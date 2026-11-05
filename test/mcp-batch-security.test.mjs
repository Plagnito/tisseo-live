// F-771029 : régression du transport MCP public, sans réseau ni secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createMcpServer } from '../lib/mcp.mjs';

const message = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'probe', arguments: {} } });
function fixture(handler) {
  const mcp = createMcpServer({
    name: 'security', title: 'Security', version: '1', instructions: '',
    tools: [{ name: 'probe', inputSchema: { type: 'object', properties: {} }, handler }],
  });
  const post = async (body) => {
    const response = { statusCode: 200, headers: {}, body: undefined };
    const res = {
      set(k, v) { response.headers[k] = v; return this; },
      status(n) { response.statusCode = n; return this; },
      json(value) { response.body = value; return response; },
      end() { return response; },
    };
    return mcp.httpHandler({ method: 'POST', body, mcp: null }, res);
  };
  return { mcp, post };
}

test('F-771029 : lot >16 rejeté AVANT toute exécution, y compris notifications', async () => {
  let started = 0;
  const { post } = fixture(async () => { started++; return { ok: true }; });
  const result = await post(Array.from({ length: 17 }, (_, i) => message(i + 1)));
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, -32600);
  assert.equal(started, 0);
  const empty = await post([]);
  assert.equal(empty.statusCode, 400);
  assert.equal(started, 0);
});

test('F-771029 : lots légitimes, notifications et appels unitaires restent compatibles', async () => {
  const { post } = fixture(async () => ({ ok: true }));
  const batch = await post([message(1), { jsonrpc: '2.0', method: 'notifications/initialized' }, message(2)]);
  assert.equal(batch.statusCode, 200);
  assert.deepEqual(batch.body.map((r) => r.id), [1, 2]);
  assert.ok(batch.body.every((r) => r.result.structuredContent.ok));
  const single = await post(message(3));
  assert.equal(single.body.id, 3);
  const notifications = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(notifications.statusCode, 202);
});

test('F-771029 : plusieurs requêtes partagent un plafond global de huit outils simultanés', async () => {
  let active = 0, peak = 0, started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { post } = fixture(async () => {
    started++; active++; peak = Math.max(peak, active);
    try { await gate; return { ok: true }; } finally { active--; }
  });
  const requests = [post(Array.from({ length: 16 }, (_, i) => message(i + 1))),
    post(Array.from({ length: 16 }, (_, i) => message(i + 101)))];
  await tick();
  const beforeRelease = started;
  release();
  const responses = await Promise.all(requests);
  assert.equal(beforeRelease, 8, 'le code vulnérable démarrait les 32 appels avant la libération');
  assert.equal(peak, 8);
  assert.equal(started, 32, 'les appels admis ne doivent pas être perdus');
  assert.ok(responses.every((r) => r.body.length === 16 && r.body.every((x) => x.result)));
});

test('F-771029 : la file globale est bornée, la surcharge est refusée sans bloquer les clients', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { post } = fixture(async () => { started++; await gate; return { ok: true }; });
  const requests = Array.from({ length: 4 }, (_, batch) =>
    post(Array.from({ length: 16 }, (_, i) => message(batch * 16 + i + 1))));
  await tick();
  assert.equal(started, 8);
  release();
  const responses = await Promise.all(requests);
  const all = responses.flatMap((r) => r.body);
  assert.equal(all.length, 64);
  assert.equal(all.filter((r) => r.error?.code === -32000).length, 24);
  assert.equal(all.filter((r) => r.result).length, 40);
  assert.equal(started, 40);
});
