// Ce que le routeur demande aux horaires pour dater un trajet : prochain
// départ, ligne en service ou non, heure d'arrivée d'une course.
// ---------------------------------------------------------------
// Écrit d'abord pour Tisséo (dans server.mjs) ; partagé depuis que les réseaux
// des autres villes passent par le même routeur (lib/reseaux/planificateur.mjs).
// Rien ici ne connaît un réseau en particulier : tout vient des paramètres.
//
//   variants   : { ligne: [{ dir, stops }] }
//   schedules  : () → index de loadSchedules(), ou null tant qu'il n'est pas prêt
//   liveRoutes : () → { ligne: nombre de véhicules vus en temps réel } ou null
// ---------------------------------------------------------------
import { scheduleDepartures, routeActiveAt, pairTimes, ymd } from './schedules.mjs';

export function createJourneyOpts({ variants, schedules, liveRoutes = () => null, now = () => Date.now() }) {
  // Le parcours qui dessert la montée PUIS la descente : c'est lui qui dit dans
  // quel sens (et sur quelle branche) lire les horaires.
  const variantOf = (routeId, board, alight) => (variants[routeId] ?? []).find((x) => {
    const i = x.stops.indexOf(board);
    return i >= 0 && x.stops.indexOf(alight) > i;
  });

  // Prochain départ THÉORIQUE d'une ligne à un arrêt, dans le sens qui va de
  // board à alight : c'est ce qui donne un temps d'attente aux étapes que le
  // temps réel ne couvre pas (métro, creux du flux).
  function nextDeparture(routeId, board, alight, t) {
    const idx = schedules();
    if (!idx) return null;
    const v = variantOf(routeId, board, alight);
    const pick = (list) => list.find((x) => x.route_id === routeId && (!v || x.dir === v.dir));
    // D'abord les 2 h qui viennent ; sinon la nuit entière : à 00 h 30, le
    // prochain bus est souvent à 05 h 15, et « aucun horaire » ferait
    // inventer un départ immédiat.
    const d = pick(scheduleDepartures(idx, board, t, 400))
      ?? pick(scheduleDepartures(idx, board, t, 20_000, 14 * 3600));
    return d ? d.time : null;
  }

  // Ligne en service à l'heure t ? Horaires théoriques, et — pour un départ
  // proche de maintenant — la présence de véhicules dans le flux temps réel.
  // null = on ne sait pas (la ligne n'est alors pas écartée).
  function inService(routeId, t) {
    const nowish = Math.abs(t - now() / 1000) < 30 * 60;
    if (nowish && liveRoutes()?.[routeId]) return true;
    return routeActiveAt(schedules(), routeId, t);
  }

  // Heure d'ARRIVÉE théorique d'une course partie de board à depT : on
  // retrouve le départ dans la grille, puis son arrivée par appariement.
  function scheduledArrival(routeId, board, alight, depT, estS) {
    const idx = schedules();
    if (!idx || !(estS > 0)) return null;
    const v = variantOf(routeId, board, alight);
    const pick = (id) => (idx.byStop.get(id) ?? []).filter((e) => e.route_id === routeId && (!v || e.dir === v.dir));
    const eB = pick(board), eA = pick(alight);
    if (!eB.length || !eA.length) return null;
    const day0 = new Date(depT * 1000);
    for (const offset of [0, -1]) {
      const day = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + offset);
      const mid = Math.floor(day.getTime() / 1000);
      const secs = depT - mid;
      for (const pi of idx.patternsByDate.get(ymd(day)) ?? []) {
        const B = [...new Set(eB.flatMap((e) => e.perPat[pi] ?? []))].sort((a, b) => a - b);
        if (!B.includes(secs)) continue;
        const A = [...new Set(eA.flatMap((e) => e.perPat[pi] ?? []))].sort((a, b) => a - b);
        const hit = pairTimes(B, A, estS).find(([b]) => b === secs);
        if (hit) return mid + hit[1];
      }
    }
    return null;
  }

  return { nextDeparture, inService, scheduledArrival };
}
