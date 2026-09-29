// Mouvement des pastilles — logique pure, partagée entre le navigateur et
// les tests unitaires.
// ---------------------------------------------------------------
// Ce fichier n'a aucun accès au DOM ni à Leaflet : il ne manipule que des
// nombres et des objets { lat, lng }. Le front l'importe (voir
// public/app.js) et `node --test` le couvre, ce qui n'était pas possible
// tant que tout vivait dans public/app.js.
//
// Latence de référence : un `LatLng` de Leaflet expose .lat et .lng (PAS
// .lon) ; on reste en { lat, lng } partout ici pour ne plus se reprendre les
// pieds dans le même piège.

export const M_PER_DEG_LAT = 110540;
export const M_PER_DEG_LON = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// Différence de longitude ramenée dans [-180, 180] : sans cela, deux points
// séparés de 0,2° par l'antiméridien seraient mesurés à 40 000 km.
function wrapLng(dLng) {
  let d = dLng;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// Distance en mètres entre deux points { lat, lng }.
// Le facteur d'échelle en longitude est pris à la latitude *moyenne* : avec
// celui d'un seul des deux points, la distance n'était pas symétrique.
export function metresBetween(a, b) {
  if (!a || !b) return 0;
  const dx = wrapLng(b.lng - a.lng) * M_PER_DEG_LON((a.lat + b.lat) / 2);
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// Cap en degrés, normalisé dans [0, 360) : atan2 rend [-180, 180], si bien
// que l'ouest ressortirait à -90. Les appelants n'ont pas à faire le modulo
// eux-mêmes.
export function bearingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = wrapLng(b.lng - a.lng);
  const y = Math.sin(toRad(dLng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(dLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Vitesse lissée : une mesure isolée aberrante ne doit pas faire bondir la
// pastille, et un arrêt franc doit finir par la ramener à zéro.
export function smoothSpeed(previous, instant, alpha = 0.35) {
  if (previous == null) return instant;
  if (!Number.isFinite(instant)) return previous;
  return previous + (instant - previous) * alpha;
}

// Extrapolation à l'instant `nowMs` : position observée + vitesse × temps.
// `maxLeadS` borne l'anticipation : au-delà, on ne devine plus, on attend la
// prochaine mesure.
export function predict({ fix, fixAtMs, speed, bearing, nowMs, maxLeadS = 8 }, out) {
  if (!fix || fixAtMs == null) return out || fix;
  const v = Number.isFinite(speed) ? speed : 0;
  if (v <= 0.05) return fix;
  const lead = Math.min(Math.max(((nowMs ?? fixAtMs) - fixAtMs) / 1000, 0), maxLeadS);
  const d = v * lead;
  if (d < 1) return fix;
  const rad = ((bearing || 0) * Math.PI) / 180;
  return {
    lat: fix.lat + (Math.cos(rad) * d) / M_PER_DEG_LAT,
    lng: fix.lng + (Math.sin(rad) * d) / M_PER_DEG_LON(fix.lat),
  };
}

// Durée d'une interpolation : la distance à parcourir divisée par la vitesse
// mesurée. Un bus rapide arrive au bout en peu de temps, un bus à l'arrêt ne
// bouge pas : plus de durée constante arbitraire qui ne colle à rien.
export const MOTION_IDLE_MS = 9000;
export function interpDurationMs(distanceM, speed, opts = {}) {
  const min = opts.min ?? 2500;
  const max = opts.max ?? 12000;
  const idle = opts.idle ?? MOTION_IDLE_MS;
  const v = Number.isFinite(speed) ? speed : 0;
  if (v <= 0.3) return idle;
  return Math.min(Math.max((distanceM / v) * 1000, min), max);
}

// Accélération/décélération douce aux extrémités, vitesse constante au milieu.
// NaN en entrée deviendrait NaN en sortie et figerait la pastille à une
// position infinie pour le reste de la session : on le ramène à 0.
export function easeInOut(p) {
  const x = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : 0;
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

// Interpolation entre deux points, avec l'accélération ci-dessus.
export function lerpLatLng(from, to, p) {
  const e = easeInOut(p);
  return {
    lat: from.lat + (to.lat - from.lat) * e,
    lng: from.lng + (to.lng - from.lng) * e,
  };
}

// Vitesse mesurée entre deux observations successives, en m/s.
// Renvoie null si les deux points sont trop proches dans le temps (le saut
// serait du bruit de mesure) ou trop lointains (nouvelle observation).
export function observedSpeed(prev, cur, minDtMs = 1500, maxSpeed = 60) {
  if (!prev || !cur) return null;
  const dt = cur.atMs - prev.atMs;
  if (!(dt >= minDtMs)) return null;
  const inst = metresBetween(prev, cur) / (dt / 1000);
  if (!Number.isFinite(inst) || inst > maxSpeed) return null;
  return inst;
}
