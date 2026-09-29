// Tests de lib/motion.mjs — le calcul de déplacement des pastilles.
// Tout était dans public/app.js avant : aucune de ces décisions n'était
// vérifiable, et c'est ce code qui décide si une pastille va trop vite,
// freeze, ou part dans le mauvais sens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  metresBetween,
  bearingBetween,
  smoothSpeed,
  predict,
  interpDurationMs,
  MOTION_IDLE_MS,
  easeInOut,
  lerpLatLng,
  observedSpeed,
} from '../lib/motion.mjs';

const TOULOUSE = { lat: 48.8637, lng: 2.3212 };

test('metresBetween : 0,1° de latitude ≈ 11 km vers le nord', () => {
  const d = metresBetween(TOULOUSE, { lat: TOULOUSE.lat + 0.1, lng: TOULOUSE.lng });
  assert.ok(Math.abs(d - 11054) < 20, `attendu ~11054 m, obtenu ${Math.round(d)}`);
});

test('metresBetween : symétrique, et nul sur soi-même', () => {
  const a = { lat: 48.86, lng: 2.34 };
  const b = { lat: 48.88, lng: 2.30 };
  assert.ok(Math.abs(metresBetween(a, b) - metresBetween(b, a)) < 1e-6);
  assert.equal(metresBetween(a, a), 0);
  assert.equal(metresBetween(null, a), 0);
});

test('metresBetween : à latitude de Toulouse, 0,1° de longitude est plus court', () => {
  const dLat = metresBetween(TOULOUSE, { lat: TOULOUSE.lat + 0.1, lng: TOULOUSE.lng });
  const dLng = metresBetween(TOULOUSE, { lat: TOULOUSE.lat, lng: TOULOUSE.lng + 0.1 });
  // Le méridien converge vers les pôles : à 48,8° le rapport vaut ~0,66.
  assert.ok(dLng < dLat * 0.75, `longitude ${Math.round(dLng)} vs latitude ${Math.round(dLat)}`);
  assert.ok(dLng > dLat * 0.5);
});

test('metresBetween : antimeridien sans NaN', () => {
  const d = metresBetween({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
  // 0,2° de long, pas 358,8° : on est au bout du monde mais du bon côté.
  assert.ok(d < 30000, `attendu < 30 km, obtenu ${Math.round(d)}`);
  assert.ok(Number.isFinite(d));
});

test('M_PER_DEG_LON rétrécit en montant vers le pôle', () => {
  assert.ok(M_PER_DEG_LON(60) < M_PER_DEG_LON(0));
  assert.ok(M_PER_DEG_LON(0) > M_PER_DEG_LAT * 0.99);
});

test('bearingBetween : les quatre caps', () => {
  const p = TOULOUSE;
  const cap = (lat, lng) => Math.round(bearingBetween(p, { lat, lng }));
  assert.equal(cap(p.lat + 0.01, p.lng), 0);          // nord
  assert.equal(cap(p.lat, p.lng + 0.01), 90);          // est
  assert.equal(cap(p.lat - 0.01, p.lng), 180);         // sud
  assert.equal(cap(p.lat, p.lng - 0.01), 270);         // ouest
});

test('bearingBetween : nord-est en degrés égaux n\'est PAS 45°', () => {
  // Piège classique : avancer d\'un degré de latitude et d\'un degré de
  // longitude ne donne pas une diagonale. À 48,8° N, le degré de longitude
  // vaut 0,66 fois celui de latitude, donc le cap initial est ~33°, pas 45°.
  const b = bearingBetween(TOULOUSE, { lat: TOULOUSE.lat + 0.01, lng: TOULOUSE.lng + 0.01 });
  assert.ok(b > 32 && b < 35, `attendu ~33°, obtenu ${b.toFixed(1)}`);
});

test('bearingBetween : cap compris en diagonale, à latitude nulle', () => {
  // À l\'équateur, là où un degré de longitude vaut un degré de latitude, on
  // retrouve bien 45°.
  const b = bearingBetween({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0.01 });
  assert.ok(Math.abs(b - 45) < 0.5, `attendu ~45°, obtenu ${b.toFixed(1)}`);
});

test('smoothSpeed : première mesure prise telle quelle', () => {
  assert.equal(smoothSpeed(null, 10), 10);
  assert.equal(smoothSpeed(0, 10, 0.5), 5);
});

test('smoothSpeed : une mesure aberrante est amortie, pas suivie', () => {
  // Un saut de 0 à 30 m/s (108 km/h) en une mesure est du bruit GPS : avec un
  // lissage à 0,35 on doit rester loin de la valeur aberrante.
  const lissé = smoothSpeed(10, 30, 0.35);
  assert.ok(lissé < 20, `amorti trop peu : ${lissé}`);
  assert.ok(lissé > 10);
});

test('smoothSpeed : converge vers la vitesse réelle', () => {
  let v = 0;
  for (let i = 0; i < 40; i++) v = smoothSpeed(v, 12, 0.35);
  assert.ok(Math.abs(v - 12) < 0.01, `convergence : ${v}`);
});

test('smoothSpeed : une vitesse non finie est ignorée', () => {
  assert.equal(smoothSpeed(10, NaN, 0.35), 10);
  assert.equal(smoothSpeed(10, Infinity, 0.35), 10);
});

test('smoothSpeed : un arrêt franc ramène la vitesse vers zéro', () => {
  let v = 20;
  for (let i = 0; i < 20; i++) v = smoothSpeed(v, 0, 0.35);
  assert.ok(v < 0.5, `la vitesse devrait retomber à zéro, elle est à ${v}`);
});

test('predict : à l\'instant de la mesure, rien ne bouge', () => {
  const p = predict({ fix: TOULOUSE, fixAtMs: 1000, speed: 10, bearing: 90, nowMs: 1000 });
  assert.equal(p.lat, TOULOUSE.lat);
  assert.equal(p.lng, TOULOUSE.lng);
});

test('predict : avance dans la direction du cap, à la vitesse mesurée', () => {
  const p = predict({ fix: TOULOUSE, fixAtMs: 0, speed: 10, bearing: 90, nowMs: 2000 });
  // 2 s × 10 m/s = 20 m vers l'est.
  const d = metresBetween(TOULOUSE, p);
  assert.ok(Math.abs(d - 20) < 1, `attendu 20 m, obtenu ${d.toFixed(1)}`);
  assert.ok(p.lng > TOULOUSE.lng);
  assert.ok(Math.abs(p.lat - TOULOUSE.lat) < 1e-6);
});

test('predict : ne devine pas au-delà de la limite', () => {
  // Après 60 s, l'extrapolation reste bornée à maxLeadS (8 s par défaut) :
  // on préfère attendre la prochaine mesure plutôt que d'envoyer la
  // pastille à l'autre bout de la ville.
  const p = predict({ fix: TOULOUSE, fixAtMs: 0, speed: 10, bearing: 90, nowMs: 60000 });
  const d = metresBetween(TOULOUSE, p);
  assert.ok(d <= 85, `borné à ~80 m, obtenu ${d.toFixed(1)}`);
});

test('predict : ne recule jamais dans le temps', () => {
  const p = predict({ fix: TOULOUSE, fixAtMs: 10000, speed: 10, bearing: 90, nowMs: 5000 });
  assert.equal(p.lat, TOULOUSE.lat);
  assert.equal(p.lng, TOULOUSE.lng);
});

test('predict : à l\'arrêt, la position reste celle observée', () => {
  const p = predict({ fix: TOULOUSE, fixAtMs: 0, speed: 0, bearing: 90, nowMs: 5000 });
  assert.equal(p.lat, TOULOUSE.lat);
});

test('predict : sans mesure, on rend ce qu\'on a', () => {
  assert.equal(predict({ fix: null, fixAtMs: null, speed: 5 }, TOULOUSE), TOULOUSE);
  const p = predict({ fix: TOULOUSE, fixAtMs: null, speed: 5 }, null);
  assert.equal(p.lat, TOULOUSE.lat);
});

test('predict : la distance extrapolée est proportionnelle au temps', () => {
  const a = predict({ fix: TOULOUSE, fixAtMs: 0, speed: 10, bearing: 0, nowMs: 1000 });
  const b = predict({ fix: TOULOUSE, fixAtMs: 0, speed: 10, bearing: 0, nowMs: 3000 });
  assert.ok(Math.abs(metresBetween(a, b) - 20) < 1);
});

test('interpDurationMs : proportionnelle à la distance, bornée', () => {
  const d1 = interpDurationMs(100, 10);
  const d2 = interpDurationMs(300, 10);
  assert.ok(d2 > d1, 'plus c\'est long, plus ça dure');
  assert.ok(Math.abs(d1 - 10000) < 1);
  // Bornes : jamais instantané, jamais interminable.
  assert.ok(interpDurationMs(0.1, 10) >= 2500);
  assert.ok(interpDurationMs(99999, 10) <= 12000);
});

test('interpDurationMs : à l\'arrêt, on ne fige pas la pastille', () => {
  // C\'est le piège du rendu : sans durée de repli, une vitesse nulle
  // donnerait une durée infinie et une pastille immobile.
  assert.equal(interpDurationMs(400, 0), MOTION_IDLE_MS);
  assert.equal(interpDurationMs(400, null), MOTION_IDLE_MS);
  assert.equal(interpDurationMs(400, 0.2), MOTION_IDLE_MS);
});

test('interpDurationMs : un bus rapide va plus vite qu\'un bus lent', () => {
  assert.ok(interpDurationMs(200, 20) < interpDurationMs(200, 4));
});

test('easeInOut : bornes et symétrie', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-9);
  assert.ok(easeInOut(0.25) < 0.25, 'démarrage plus lent que linéaire');
  assert.ok(easeInOut(0.75) > 0.75, 'arrivée plus lente que linéaire');
});

test('easeInOut : borne les valeurs aberrantes', () => {
  assert.equal(easeInOut(-3), 0);
  assert.equal(easeInOut(7), 1);
  assert.ok(Number.isFinite(easeInOut(NaN)));
});

test('easeInOut est croissant', () => {
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = easeInOut(p);
    assert.ok(v >= prev - 1e-9, `décroissance à ${p}`);
    prev = v;
  }
});

test('lerpLatLng : du premier au second point', () => {
  const to = { lat: 48.8737, lng: 2.3312 };
  assert.deepEqual(lerpLatLng(TOULOUSE, to, 0), { lat: TOULOUSE.lat, lng: TOULOUSE.lng });
  assert.deepEqual(lerpLatLng(TOULOUSE, to, 1), to);
  const mid = lerpLatLng(TOULOUSE, to, 0.5);
  assert.ok(mid.lat > TOULOUSE.lat && mid.lat < to.lat);
  assert.ok(mid.lng > TOULOUSE.lng && mid.lng < to.lng);
});

test('lerpLatLng : le point milieu est à mi-distance', () => {
  const to = { lat: 48.8737, lng: 2.3212 };
  const mid = lerpLatLng(TOULOUSE, to, 0.5);
  assert.ok(Math.abs(metresBetween(TOULOUSE, mid) - metresBetween(TOULOUSE, to) / 2) < 1);
});

test('observedSpeed : vitesse plausible entre deux points', () => {
  const a = { lat: 48.8637, lng: 2.3212, atMs: 0 };
  const b = { lat: 48.8637, lng: 2.3212 + 0.0005, atMs: 10000 }; // ~38 m en 10 s
  const v = observedSpeed(a, b);
  assert.ok(v > 3 && v < 4.5, `attendu ~3,8 m/s, obtenu ${v}`);
});

test('observedSpeed : rejette les sauts trop rapprochés (bruit)', () => {
  const a = { lat: 48.8637, lng: 2.3212, atMs: 0 };
  const b = { lat: 48.8637, lng: 2.3212 + 0.0005, atMs: 300 };
  // 38 m en 0,3 s = 126 m/s : ce n'est pas un bus, c'est du bruit.
  assert.equal(observedSpeed(a, b), null);
});

test('observedSpeed : rejette les vitesses impossibles', () => {
  const a = { lat: 48.8637, lng: 2.3212, atMs: 0 };
  const b = { lat: 48.9, lng: 2.3212, atMs: 2000 }; // 4 km en 2 s
  assert.equal(observedSpeed(a, b), null);
});

test('observedSpeed : tolère un bond de ligne (relève de conducteur)', () => {
  // Passer de 48,86 à 48,87 est 1,1 km : en 10 min c'est 1,9 m/s, plausible
  // pour un saut de relevée.
  const a = { lat: 48.86, lng: 2.32, atMs: 0 };
  const b = { lat: 48.87, lng: 2.32, atMs: 600000 };
  const v = observedSpeed(a, b);
  assert.ok(v > 0 && v < 3, `attendu ~1,9 m/s, obtenu ${v}`);
});

test('observedSpeed : sans historique, pas de vitesse', () => {
  assert.equal(observedSpeed(null, { atMs: 0 }), null);
  assert.equal(observedSpeed({ atMs: 0 }, null), null);
});
