// Serveur MCP minimal — transport « Streamable HTTP », sans état, sans dépendance.
//
// C'est ce que ChatGPT (connecteurs / mode développeur), Claude et tout client
// MCP appellent : un POST JSON-RPC 2.0 sur une seule URL, réponse JSON directe.
// On ne pousse jamais de notification serveur → pas besoin de SSE ni de session :
// GET répond 405, comme le prévoit la spécification pour un serveur qui n'ouvre
// pas de flux.
//
// Chaque outil : { name, title, description, inputSchema, handler(args) }.
// Le handler renvoie un objet → il part à la fois en `structuredContent` et en
// texte JSON (les clients qui ignorent l'un lisent l'autre). Une erreur levée
// par un handler est une erreur D'OUTIL (isError: true, lue par le modèle qui
// peut corriger son appel), pas une erreur de protocole.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ToolError extends Error {}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// Validation légère des arguments d'après le JSON Schema de l'outil : types de
// premier niveau, requis, enum, bornes. Suffit pour renvoyer au modèle un message
// qui lui dit quoi corriger, au lieu d'un plantage au fond du handler.
export function checkArgs(schema, args) {
  const problems = [];
  const props = schema?.properties ?? {};
  for (const k of schema?.required ?? []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') problems.push(`« ${k} » est requis`);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      if (schema?.additionalProperties === false) problems.push(`paramètre inconnu « ${k} »`);
      continue;
    }
    if (v === undefined || v === null) continue;
    const t = p.type;
    const ok = t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : t === 'string' ? typeof v === 'string'
          : t === 'boolean' ? typeof v === 'boolean'
            : t === 'array' ? Array.isArray(v)
              : t === 'object' ? typeof v === 'object' && !Array.isArray(v)
                : true;
    if (!ok) { problems.push(`« ${k} » doit être de type ${t}`); continue; }
    if (p.enum && !p.enum.includes(v)) problems.push(`« ${k} » doit valoir ${p.enum.map((e) => `"${e}"`).join(' | ')}`);
    if (typeof v === 'number') {
      if (p.minimum != null && v < p.minimum) problems.push(`« ${k} » doit être ≥ ${p.minimum}`);
      if (p.maximum != null && v > p.maximum) problems.push(`« ${k} » doit être ≤ ${p.maximum}`);
    }
  }
  return problems;
}

export function createMcpServer({ name, title, version, instructions, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map(({ name: n, title: tt, description, inputSchema, annotations }) => ({
    name: n,
    ...(tt ? { title: tt } : {}),
    description,
    inputSchema,
    // Tout est en lecture seule sur des données publiques : on le dit, pour que
    // le client n'exige pas une confirmation à chaque appel.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...annotations },
  }));

  async function callTool(params) {
    const tool = byName.get(params?.name);
    if (!tool) return { error: [-32602, `Outil inconnu : ${params?.name}`] };
    const args = params?.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return { error: [-32602, 'arguments doit être un objet'] };
    const problems = checkArgs(tool.inputSchema, args);
    if (problems.length) {
      return { result: { isError: true, content: [{ type: 'text', text: `Paramètres invalides : ${problems.join(' ; ')}.` }] } };
    }
    try {
      const out = await tool.handler(args);
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out,
        },
      };
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : `Erreur interne : ${err?.message || err}`;
      if (!(err instanceof ToolError)) console.error(`[mcp] ${tool.name} —`, err?.stack || err);
      return { result: { isError: true, content: [{ type: 'text', text: msg }] } };
    }
  }

  // Traite UN message JSON-RPC. Renvoie la réponse, ou null pour une
  // notification (pas d'id → pas de réponse).
  async function handleMessage(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id, -32600, 'Requête JSON-RPC invalide');
    }
    const isNotification = msg.id === undefined;
    if (isNotification) return null; // notifications/initialized, cancelled…

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, title, version },
          instructions,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: listed });
      case 'tools/call': {
        const r = await callTool(msg.params);
        return r.error ? rpcError(msg.id, ...r.error) : rpcResult(msg.id, r.result);
      }
      case 'resources/list':
        return rpcResult(msg.id, { resources: [] });
      case 'prompts/list':
        return rpcResult(msg.id, { prompts: [] });
      default:
        return rpcError(msg.id, -32601, `Méthode inconnue : ${msg.method}`);
    }
  }

  // Middleware Express, à monter sur une URL (ex. app.all('/mcp', …)).
  // Attend un corps JSON déjà analysé (express.json()).
  async function httpHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.set('Allow', 'POST');
      return res.status(405).json(rpcError(null, -32000, 'Ce serveur MCP est sans état : POST uniquement.'));
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, -32700, 'Corps JSON attendu'));
    }
    if (Array.isArray(body)) { // lots (versions ≤ 2025-03-26)
      const out = (await Promise.all(body.map(handleMessage))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleMessage(body);
    if (!out) return res.status(202).end();
    if (body.method === 'initialize' && out.result) res.set('MCP-Protocol-Version', out.result.protocolVersion);
    return res.json(out);
  }

  return { handleMessage, httpHandler, tools: listed };
}
