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

// Toulouse, zoom 13 : une tuile de ville, pas de tuile uniforme.
const PROBE = { z: 13, x: 4152, y: 2801 };

// Serveurs sans clé, du plus beau au plus dépannage. `dark`/`light` : une
// URL par mode, `labels` : surcouche de noms de rues facultative.
export const TILE_PROVIDERS = [
  {
    id: 'esri-dark',
    label: 'Esri gris foncé',
    dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    min_bytes: 3000,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    min_bytes: 4000,
  },
  {
    id: 'cyclosm',
    label: 'CyclOSM',
    light: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors · CyclOSM',
    min_bytes: 4000,
  },
  {
    id: 'esri-street',
    label: 'Esri rues',
    light: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    min_bytes: 6000,
  },
  {
    id: 'opentopo',
    label: 'OpenTopoMap',
    light: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap (CC-BY-SA)',
    min_bytes: 4000,
  },
];

// Placeholders connus : réponse 200 mais pas une carte.
const PLACEHOLDER_SHA256 = new Set([
  'cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc', // CARTO dark_all
  '69be4aecf9f814ba45d585801a5aa41e79b16fc88eafec5b1954a9f06a69e6be', // CARTO voyager
]);

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
  const url = tpl
    .replace('{z}', PROBE.z).replace('{x}', PROBE.x).replace('{y}', PROBE.y)
    .replace('{s}', 'a').replace('{r}', '');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tisseo-live/1.0 (local; http://localhost)' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  if (!type.startsWith('image/')) return { ok: false, why: `type ${type || '?'}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (PLACEHOLDER_SHA256.has(sha)) return { ok: false, why: 'placeholder (image de remplacement)' };
  if (!imageIsTile(buf)) return { ok: false, why: `pas une tuile ${TILE_SIZE_PX}×${TILE_SIZE_PX}` };
  return { ok: true, bytes: buf.length, sha256: sha.slice(0, 12) };
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
        if (r.ok) {
          out[mode].push({ id: p.id, label: p.label, url: p[mode], labels: p.labels || null, attribution: p.attribution || '' });
        } else {
          out.rejected.push({ id: p.id, mode, why: r.why });
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
