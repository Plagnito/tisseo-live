// Fonds de carte : quels fournisseurs servent encore une VRAIE tuile ?
//
// Le piège rencontré le 28/09/2026 : CARTO répond HTTP 200 mais renvoie une
// image de 2 Ko « API KEY REQUIRED » à la place de la carte. Le navigateur
// la charge sans erreur, la tuile est comptée comme « ok », et l'utilisateur
// voit un fond « carte » qui est un placeholder. Une simple détection
// d'erreur HTTP ne suffit donc pas.
//
// On vérifie donc avant d'ajouter un fond à la liste :
//   1. HTTP 200 et Content-Type image/*
//   2. image 256×256 (PNG via IHDR, ou JPEG via marqueur SOF)
//   3. taille au-dessus d'un plancher (une tuile de ville réelle pèse 5–40 Ko)
//   4. empreinte absente de la liste des placeholders connus
//
// Le résultat est mis en cache : la sonde tourne au plus une fois toutes les
// PROBE_TTL_MS, et le front n'a plus qu'à lire /api/tiles.
import { createHash } from 'node:crypto';

const PROBE_TTL_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 6000;
const TILE_SIZE_PX = 256;

// Toulouse : on sonde des coordonnées réelles, pas un x/y figé. Un couple
// (x, y) ne vaut que pour UN zoom — réutilisé plus haut, il pointe au milieu
// de l'océan et renvoie une tuile vide qui fait croire à un service cassé.
const PROBE = { z: 13, lat: 43.6047, lon: 1.4442 };

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

// Serveurs sans clé, du plus beau au plus dépannage. `dark`/`light` : une
// URL par mode, `labels` : surcouche de noms de rues facultative.
// `max_native_zoom` est une simple déclaration : la sonde la VÉRIFIE (voir
// probeDepth) avant qu'on ne l'expose au client.
export const TILE_PROVIDERS = [
  {
    id: 'esri-dark',
    label: 'Esri gris foncé',
    dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    min_bytes: 3000,
    max_native_zoom: 16, // au-delà : « map data not available »
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    min_bytes: 4000,
    max_native_zoom: 19,
  },
  {
    id: 'cyclosm',
    label: 'CyclOSM',
    light: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors · CyclOSM',
    min_bytes: 2000,
    max_native_zoom: 19,
  },
  {
    id: 'esri-street',
    label: 'Esri rues',
    light: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    min_bytes: 6000,
    max_native_zoom: 19,
  },
  {
    id: 'opentopo',
    label: 'OpenTopoMap',
    light: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap (CC-BY-SA)',
    min_bytes: 4000,
    max_native_zoom: 17, // n'a plus de données au z18
  },
];

// Placeholders connus : réponse 200 mais pas une carte.
const PLACEHOLDER_SHA256 = new Set([
  'cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc', // CARTO dark_all
  '69be4aecf9f814ba45d585801a5aa41e79b16fc88eafec5b1954a9f06a69e6be', // CARTO voyager
  '9eafd300d6139318', // préfixe — placeholder Esri « map data not available »
]);

// Construit le gabarit d'URL pour un zoom donné.
function url(tpl, z) {
  const { x, y } = tileXY(PROBE.lat, PROBE.lon, z);
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a').replace('{r}', '');
}

// 256×256 ? PNG : IHDR ; JPEG : on parcourt les segments jusqu'à SOFn.
function imageIsTile(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.subarray(1, 4).toString('latin1') === 'PNG') {
    return buf.readUInt32BE(16) === TILE_SIZE_PX && buf.readUInt32BE(20) === TILE_SIZE_PX;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, hors DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return buf.readUInt16BE(i + 7) === TILE_SIZE_PX && buf.readUInt16BE(i + 5) === TILE_SIZE_PX;
      }
      i += 2 + len;
    }
  }
  return false;
}

async function probeUrl(tpl) {
  const res = await fetch(url(tpl, PROBE.z), {
    headers: { 'User-Agent': 'tisseo-live/1.0 (local; http://localhost)' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  if (!type.startsWith('image/')) return { ok: false, why: `type ${type || '?'}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (PLACEHOLDER_SHA256.has(sha) || PLACEHOLDER_SHA256.has(sha.slice(0, 16))) {
    return { ok: false, why: 'placeholder (image de remplacement)' };
  }
  if (!imageIsTile(buf)) return { ok: false, why: `pas une tuile ${TILE_SIZE_PX}×${TILE_SIZE_PX}` };
  return { ok: true, bytes: buf.length, sha256: sha.slice(0, 12) };
}

// Jusqu'à quel zoom le fournisseur a-t-il de VRAIES données ?
//
// Le piège du 28/09 : au-delà du z16, le fond gris foncé d'Esri continue de
// répondre 200, mais renvoie le MÊME fichier « map data not available » qu'au
// niveau précédent — d'où des carrés vides dès qu'on zoome. Plutôt que de
// croire une valeur déclarée, on la vérifie : une tuile identique en
// empreinte à celle du niveau précédent, une image minuscule, ou un
// content-type inattendu marquent la fin.
async function probeDepth(tpl, declared) {
  const limit = Number.isFinite(declared) ? declared : 19;
  const ok = async (z) => {
    try {
      const res = await fetch(url(tpl, z), {
        headers: { 'User-Agent': 'tisseo-live/1.0 (local; http://localhost)' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const type = String(res.headers.get('content-type') || '');
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200 || !imageIsTile(buf)) return null;
      const sha = createHash('sha256').update(buf).digest('hex');
      if (PLACEHOLDER_SHA256.has(sha) || PLACEHOLDER_SHA256.has(sha.slice(0, 16))) return null;
      return sha;
    } catch { return null; }
  };
  if (limit <= 16) {
    // Limite basse déclarée : deux niveaux suffisent à prouver qu'au-delà
    // c'est un placeholder, et ça coûte deux requêtes.
    const a = await ok(15);
    if (!a) return { zoom: null, why: 'pas de tuile au z15' };
    const b = await ok(16);
    if (!b || b === a) return { zoom: 15, why: 'z16 identique au z15 ou absent' };
    return { zoom: 16, why: null };
  }
  // Limite haute déclarée : on vérifie le niveau du dessus, puis on recule
  // d'un cran pour distinguer « limite réelle » d'une tuile manquante.
  const a = await ok(limit);
  if (!a) {
    const b = await ok(limit - 1);
    if (!b) return { zoom: null, why: `pas de tuile au z${limit - 1}` };
    return { zoom: limit - 1, why: `z${limit} absent` };
  }
  return { zoom: limit, why: null };
}

export function createTileProbe(providers = TILE_PROVIDERS) {
  let cache = { at: 0, value: null, running: null };

  async function run() {
    const out = { checked_at: new Date().toISOString(), dark: [], light: [], rejected: [] };
    await Promise.all(providers.map(async (p) => {
      for (const mode of ['dark', 'light']) {
        if (!p[mode]) continue;
        let r;
        try {
          r = await probeUrl(p[mode]);
        } catch (err) {
          r = { ok: false, why: String(err.message || err) };
        }
        if (!r.ok) {
          out.rejected.push({ id: p.id, mode, why: r.why });
          continue;
        }
        // Puis on vérifie jusqu'où le fournisseur a de vraies données.
        let depth = { zoom: p.max_native_zoom ?? 19, why: null };
        try {
          depth = await probeDepth(p[mode], p.max_native_zoom);
        } catch (err) {
          depth = { zoom: null, why: String(err.message || err) };
        }
        if (!depth.zoom) {
          out.rejected.push({ id: p.id, mode, why: depth.why || 'profondeur de zoom inconnue' });
          continue;
        }
        out[mode].push({
          id: p.id,
          label: p.label,
          url: p[mode],
          labels: p.labels || null,
          attribution: p.attribution || '',
          max_native_zoom: depth.zoom,
        });
        if (depth.why) {
          out.notes = out.notes || [];
          out.notes.push(`${p.id} : zoom natif ${depth.zoom} (${depth.why})`);
        }
      }
    }));
    // L'ordre de TILE_PROVIDERS est perdu avec Promise.all : on le rétablit.
    const rank = new Map(providers.map((p, i) => [p.id, i]));
    for (const mode of ['dark', 'light']) out[mode].sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return out;
  }

  return async function tileCatalog(force = false) {
    const now = Date.now();
    if (!force && cache.value && now - cache.at < PROBE_TTL_MS) return cache.value;
    if (!cache.running) {
      cache.running = run().then((v) => { cache = { at: Date.now(), value: v, running: null }; return v; },
        (e) => { cache.running = null; throw e; });
    }
    return cache.running;
  };
}
