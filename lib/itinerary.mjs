// Retrouver le parcours d'un véhicule dans une ligne à deux sens.
// ---------------------------------------------------------------
// Le flux temps réel ne dit pas « ce bus va à Basso Cambo » : il dit juste
// « il est entre tel et tel arrêt ». Pour reconstituer son itinéraire, il
// faut choisir la bonne variante (le sens) de la ligne — et se tromper met
// tout le parcours à l'envers sans que rien ne saute aux yeux.
//
// Logique pure, donc testée : c'est ici que se joue la moitié de
// l'exactitude de la carte, et c'était dans public/app.js, hors de portée
// de `npm test`.

// Normalisation pour la comparaison : minuscules, sans accents, ponctuation
// réduite à des espaces ("Hôpital Ranguei" == "hopital rangeuil").
export function normPlace(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Comparaison « le même endroit » : égalité stricte d'abord, puis
// approximation seulement si l'un des deux noms est assez long — sans quoi
// « Rangueil » matcherait « Rangueil Centre Commercial » sur une simple
// coïncidence de préfixe, et une erreur de sens est bien plus grave qu'un
// abandon.
function samePlace(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 2;                       // identique
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 6 && long.startsWith(short)) return 1;
  return 0;
}

// Choisit la variante que suit `v` parmi celles d'une même ligne.
// `v` est un véhicule du flux (destination, from, to, next_stop_id).
// Renvoie { variant, index, score, why, ambiguous } ou null.
//
// Les poids sont ordonnés par fiabilité décroissante : le headsign du GTFS
// est la destination affichée par le véhicule, donc un nom identique est le
// signal le plus fort ; `to` est l'arrêt suivant, donc la position sur la
// ligne vaut presque autant ; le départ et le prochain arrêt confirment.
export function pickVariantForVehicle(variants, v) {
  if (!Array.isArray(variants) || !variants.length || !v) return null;
  const dest = normPlace(v.destination);
  const to = normPlace(v.to);
  const from = normPlace(v.from);
  let best = null;
  let bestScore = -1;
  for (const [index, variant] of variants.entries()) {
    const stops = variant?.stops || [];
    const head = normPlace(variant?.headsign);
    const last = stops.length ? normPlace(stops[stops.length - 1].name) : '';
    const first = stops.length ? normPlace(stops[0].name) : '';
    let score = 0;
    const why = [];
    const add = (w, label) => { score += w; if (w > 0) why.push(label); };

    // 1. destination annoncée par le véhicule == titre de la variante
    if (dest) add(head === dest ? 5 : head && samePlace(head, dest) ? 2 : 0, 'destination');
    // 2. la variante se termine là où le véhicule va
    if (last) {
      const t = samePlace(last, to);
      const d = dest ? samePlace(last, dest) : 0;
      add(Math.max(t * 2, d), 'terminus');
    }
    // 3. le véhicule est parti du premier arrêt de cette variante
    if (first) add(samePlace(first, from), 'depart');
    // 4. le prochain arrêt figure bien dans cette variante
    if (v.next_stop_id && stops.some((s) => s.id === v.next_stop_id)) add(1, 'prochain arret');

    if (score > bestScore) { bestScore = score; best = { variant, index, score, why }; }
  }
  if (!best) return null;
  // Aucun signal exploitable : mieux vaut le signaler que d'inventer un sens.
  return bestScore <= 0 ? { ...best, score: 0, ambiguous: true } : best;
}
