// Perturbations → contraintes sur le réseau.
// ---------------------------------------------------------------
// Tisséo publie ses perturbations comme du TEXTE : chaque alerte du flux ne
// porte, de structuré, que la ligne concernée. Ni arrêt, ni période. Tout le
// reste — « arrêts non desservis : Sers, Tournelle… », « du 7 septembre au
// 4 octobre », « interrompue entre Palais de Justice et Purpan » — est dans
// un HTML rédigé à la main, mais selon des gabarits très réguliers.
//
// Sans le lire, le calcul d'itinéraire et les prochains passages ignoraient
// les perturbations : le 02/10/2026, le tram T1 était coupé entre Palais de
// Justice et Purpan, et le connecteur y annonçait un tram toutes les quatre
// minutes (horaires théoriques), y faisait monter le voyageur, et lui
// proposait deux autres T1 en plan B. Une instruction plausible et fausse.
//
// Ce module lit ces gabarits et en tire des FERMETURES : pour une ligne, des
// quais non desservis (ou toute la ligne), pendant une période. Ce qu'il ne
// sait pas lire reste une perturbation « en texte » — jamais une fermeture
// inventée — et les noms d'arrêts qu'il ne retrouve pas sur la ligne sont
// gardés à part (`inconnus`) pour être montrés tels quels.
//
// Pur et testable : `node --test`.
// ---------------------------------------------------------------

const TZ = 'Europe/Paris';
const H = 3600;
// Un « jour » de perturbation est un jour de SERVICE : il commence à 4 h et
// englobe les passages d'après minuit (le dernier métro du samedi est à 3 h).
const SERVICE_DAY_START_H = 4;
// Une perturbation sans date lisible (« déviation momentanée ») vaut pour
// maintenant : on l'applique à douze heures autour de l'instant présent.
const UNDATED_WINDOW_S = 12 * H;

const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
function parisParts(t) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: p.weekday };
}
// Heure murale de Paris → epoch (deux passes suffisent, heure d'été comprise).
export function parisEpoch(y, mo, d, h = 0, mi = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = parisParts(t);
    t += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
  }
  return t;
}

// --- texte ---------------------------------------------------------------

const decode = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&[a-z]+;/g, ' ');
const plain = (html) => decode(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Normalisation des noms d'arrêts : sans accents ni ponctuation, et
// « St » = « Saint » (l'alerte écrit « St-Georges », les horaires
// « Saint-Georges » — ou l'inverse).
export const normName = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\bst\b/g, 'saint').replace(/\bste\b/g, 'sainte');

// Une alerte = plusieurs sujets, chacun introduit par un <h1>.
export function htmlSections(html) {
  const src = String(html ?? '');
  const out = [];
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m, last = null;
  while ((m = re.exec(src))) {
    if (last) last.html = src.slice(last.start, m.index);
    last = { title: plain(m[1]), start: re.lastIndex, html: '' };
    out.push(last);
  }
  if (last) last.html = src.slice(last.start);
  if (!out.length && src.trim()) out.push({ title: '', html: src });
  return out.map(({ title, html: h }) => ({ title, html: h }));
}

// --- périodes ------------------------------------------------------------

const MOIS = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
const M = '(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)';
const J = '(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\\s+)?';
const D = '(\\d{1,2})(?:\\s*er)?';
const Y = '(?:\\s+(\\d{4}))?';
const HM = '(\\d{1,2})\\s*h\\s*(\\d{2})?';
const dateText = (s) => plain(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");

// Année d'une date écrite sans année : celle qui la place au plus près de maintenant.
function nearestYear(mo, d, now) {
  const y = parisParts(now).y;
  let best = y, gap = Infinity;
  for (const c of [y - 1, y, y + 1]) {
    const g = Math.abs(parisEpoch(c, mo, d, 12) - now);
    if (g < gap) { gap = g; best = c; }
  }
  return best;
}
const fullYear = (y) => (y == null ? null : +y < 100 ? 2000 + +y : +y);
const dayStart = (y, mo, d) => parisEpoch(y, mo, d, SERVICE_DAY_START_H);
const dayEnd = (y, mo, d) => parisEpoch(y, mo, d + 1, SERVICE_DAY_START_H);

// Lit la période d'un sujet : { periods: [[début, fin]…] en epoch (null = sans
// borne), weekdaysOnly, text } ou null si aucune date n'est lisible.
export function parsePeriod(raw, now = Math.floor(Date.now() / 1000)) {
  const s = dateText(raw);
  const weekdaysOnly = /sauf (?:les )?(?:week-?ends?|samedis? (?:et|,) dimanches?)/.test(s);
  const done = (periods, text) => ({ periods, weekdaysOnly, text: text.trim() });
  let m;

  // Intervalle « du … au … », en toutes lettres ou en chiffres, avec une heure
  // facultative à chaque bout :
  //   « du [jeudi] 1er [octobre] [2026] au [samedi] 3 octobre [2026] »
  //   « du mercredi 7 octobre à 23h30 au dimanche 11 octobre 2026 [à 16h30] »
  //   « du 07/09 au 04/10/2026 », « du 27/09 à 17h00 au 05/10/2026 à 16h30 »,
  //   « du 07 au 11/10/2026 »
  const T = (n) => `(?:\\s+a\\s+(?<h${n}>\\d{1,2})\\s*h\\s*(?<i${n}>\\d{2})?)?`;
  const interval = (g) => {
    const mo2 = g.m2n ? +g.m2n : MOIS[g.m2], d2 = +g.d2;
    const y2 = fullYear(g.y2) ?? fullYear(g.y1) ?? nearestYear(mo2, d2, now);
    const mo1 = g.m1n ? +g.m1n : g.m1 ? MOIS[g.m1] : mo2, d1 = +g.d1;
    const y1 = fullYear(g.y1) ?? (mo1 > mo2 || (mo1 === mo2 && d1 > d2) ? y2 - 1 : y2);
    return [
      g.h1 != null ? parisEpoch(y1, mo1, d1, +g.h1, +(g.i1 ?? 0)) : dayStart(y1, mo1, d1),
      g.h2 != null ? parisEpoch(y2, mo2, d2, +g.h2, +(g.i2 ?? 0)) : dayEnd(y2, mo2, d2),
    ];
  };
  m = s.match(new RegExp(`du ${J}(?<d1>\\d{1,2})(?:\\s*er)?(?:\\s+(?<m1>${M.slice(1, -1)}))?(?:\\s+(?<y1>\\d{4}))?${T(1)}\\s+au ${J}(?<d2>\\d{1,2})(?:\\s*er)?\\s+(?<m2>${M.slice(1, -1)})(?:\\s+(?<y2>\\d{4}))?${T(2)}`));
  if (m) return done([interval(m.groups)], m[0]);
  m = s.match(new RegExp(`du (?<d1>\\d{1,2})(?:/(?<m1n>\\d{1,2}))?(?:/(?<y1>\\d{2,4}))?${T(1)} au (?<d2>\\d{1,2})/(?<m2n>\\d{1,2})(?:/(?<y2>\\d{2,4}))?${T(2)}`));
  if (m) return done([interval(m.groups)], m[0]);
  // « jusqu'au [vendredi] 30 avril 2027 » / « jusqu'au 02/11/2026 »
  m = s.match(new RegExp(`jusqu'au ${J}${D}\\s+${M}${Y}`));
  if (m) { const mo = MOIS[m[2]], d = +m[1]; return done([[null, dayEnd(fullYear(m[3]) ?? nearestYear(mo, d, now), mo, d)]], m[0]); }
  m = s.match(/jusqu'au (\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) { const mo = +m[2], d = +m[1]; return done([[null, dayEnd(fullYear(m[3]) ?? nearestYear(mo, d, now), mo, d)]], m[0]); }
  // « à compter du [lundi] 21 septembre »
  m = s.match(new RegExp(`(?:a compter du|a partir du|des le|depuis le) ${J}${D}\\s+${M}${Y}`));
  if (m) { const mo = MOIS[m[2]], d = +m[1]; return done([[dayStart(fullYear(m[3]) ?? nearestYear(mo, d, now), mo, d), null]], m[0]); }

  // Un ou plusieurs jours : « le samedi 3 octobre », « les samedi 3 et lundi 5
  // octobre 2026 », « vendredi 02 octobre 2026 : », suivis d'une plage horaire
  // facultative (« de 9h00 à 16h00 », « dès 05h00 », « jusqu'à 14h00 »).
  m = s.match(new RegExp(`(?:\\b(?:le|les)\\s+)?${J}${D}((?:\\s*(?:,|et)\\s*${J}\\d{1,2}(?:\\s*er)?)*)\\s+${M}${Y}`));
  let days = null, matched = '';
  if (m) {
    const mo = MOIS[m[3]];
    const nums = [+m[1], ...[...m[2].matchAll(/(\d{1,2})/g)].map((x) => +x[1])];
    const y = fullYear(m[4]) ?? nearestYear(mo, nums[0], now);
    days = nums.map((d) => [y, mo, d]);
    matched = m[0];
  } else {
    m = s.match(/\ble (\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) { const mo = +m[2], d = +m[1]; days = [[fullYear(m[3]) ?? nearestYear(mo, d, now), mo, d]]; matched = m[0]; }
  }
  if (!days) return null;
  const after = s.slice(s.indexOf(matched) + matched.length, s.indexOf(matched) + matched.length + 60);
  const win = after.match(new RegExp(`^[\\s,:]*de ${HM}\\s*a ${HM}`));
  const from = after.match(new RegExp(`^[\\s,:]*(?:des|a partir de|a compter de)\\s+${HM}`));
  const until = after.match(new RegExp(`^[\\s,:]*jusqu'a\\s+${HM}`));
  const periods = days.map(([y, mo, d]) => {
    if (win) return [parisEpoch(y, mo, d, +win[1], +(win[2] ?? 0)), parisEpoch(y, mo, d, +win[3], +(win[4] ?? 0))];
    if (from) return [parisEpoch(y, mo, d, +from[1], +(from[2] ?? 0)), dayEnd(y, mo, d)];
    if (until) return [dayStart(y, mo, d), parisEpoch(y, mo, d, +until[1], +(until[2] ?? 0))];
    return [dayStart(y, mo, d), dayEnd(y, mo, d)];
  });
  return done(periods, matched + (win || from || until ? (win || from || until)[0] : ''));
}

// --- arrêts non desservis ----------------------------------------------------

// Listes d'arrêts qui suivent « non desservi(s) » dans un sujet :
// [{ direction (texte ou null), noms: [..] }]. On s'arrête au premier passage
// qui n'est plus une liste d'arrêts (« ✔️ … », un paragraphe, des liens).
function closedLists(html, lineName) {
  const src = String(html);
  const at = src.search(/non\s+desservi/i);
  if (at < 0) return [];
  const rest = src.slice(at);
  const out = [];
  const re = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let m, cursor = 0;
  while ((m = re.exec(rest))) {
    const between = rest.slice(cursor, m.index);
    const text = plain(between);
    // Entre deux listes, il ne doit y avoir qu'un intitulé de sens (« Direction
    // Cours Dillon : »). Tout autre texte — « ✔️ … », « L'arrêt X est déplacé : »
    // — clôt le relevé : la liste qui suit n'est plus une liste d'arrêts fermés.
    if (out.length && (text.length > 90 || /[✔✅🚧💡📣❓⚠]/u.test(text) || (text.replace(/[\s:]/g, '') && !/direction/i.test(text)))) break;
    if (!out.length && text.length > 260) break;
    if (/<a\s/i.test(m[1])) break; // liste de pièces jointes
    const items = [...m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => plain(x[1])).filter(Boolean);
    if (!items.length) break;
    out.push({ direction: directionIn(text, lineName), noms: items });
    cursor = re.lastIndex;
  }
  return out;
}

// Sens cité dans un intitulé : « Direction Basso Cambo : », « Ligne 151 -
// Direction Colomiers Gare SNCF », « lignes 58 direction Muret et 85 direction
// Portet » (on prend alors celui de NOTRE ligne).
function directionIn(text, lineName) {
  const all = [...String(text).matchAll(/direction\s+(?:d[e']\s*)?(.+?)(?=\s+et\s+(?:la\s+)?(?:ligne\s+)?[A-Z0-9]+\s+direction|\s*[:;,.)]|\s+de la ligne|\s+des lignes|\s+est\b|\s+n'est\b|\s+sont\b|$)/gi)];
  if (!all.length) return null;
  if (all.length === 1) return all[0][1].trim();
  if (lineName) {
    const esc = String(lineName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const own = String(text).match(new RegExp(`(?:^|[^A-Za-z0-9])${esc}\\s+direction\\s+(?:d[e']\\s*)?(.+?)(?=\\s+et\\s+|\\s*[:;,.)]|$)`, 'i'));
    if (own) return own[1].trim();
  }
  return null; // plusieurs sens, aucun rattachable à la ligne : on ne choisit pas
}

// Un élément de liste peut porter son propre sens : « François Verdier
// ( Direction L'Union Grande Halle ) ».
function splitItem(item) {
  const m = item.match(/^(.*?)\s*\(\s*direction\s+(.+?)\s*\)\s*$/i);
  const name = (m ? m[1] : item).replace(/^["«»\s]+|["«»\s]+$/g, '').trim();
  return { name, direction: m ? m[2].trim() : null };
}

// « Arrêt non desservi : Landes - ligne 13 », « l'arrêt "Molette" de la ligne
// 67 n'est pas desservi » : un seul arrêt, nommé dans le titre ou la phrase.
function singleStop(title, text, lineName) {
  const out = [];
  let m = title.match(/arr[êe]ts?\s+non\s+desservis?(?:\s+momentan[ée]ment)?\s*:\s*(.+?)\s+-\s+(?:lignes?|tad|navette)\b/i);
  if (m) out.push(m[1].trim());
  for (const x of text.matchAll(/(?:l'arr[êe]t|le terminus|la station)\s+["«]\s*([^"»]+?)\s*["»][^.]{0,160}?(?:n'est pas desservi|non desservi|ne sera pas desservi|n'est plus desservi)/gi)) out.push(x[1].trim());
  if (!out.length) return null;
  return { noms: [...new Set(out)], direction: directionIn(text, lineName) };
}

// Quais de la ligne qui portent ce nom, dans le sens demandé s'il est donné.
function stopIdsFor(name, direction, list, stops) {
  const key = normName(name);
  if (!key) return [];
  const dir = direction ? normName(direction) : null;
  // Le sens est écrit en toutes lettres dans l'alerte (« Saint-Orens Centre
  // Commercial ») et en abrégé dans les horaires (« St-Orens Ctre Cial ») : on
  // compare mot à mot, un mot pouvant être le début de l'autre.
  const close = (a, b) => {
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const ta = a.split(' '), tb = b.split(' ');
    const hit = ta.filter((x) => tb.some((y) => x === y || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))))).length;
    return hit >= Math.min(2, ta.length, tb.length) && hit >= Math.ceil(Math.min(ta.length, tb.length) / 2);
  };
  const sameDir = (v) => {
    if (!dir) return true;
    const head = normName(v.headsign);
    const last = normName(stops[v.stops[v.stops.length - 1]]?.n);
    return [head, last].some((x) => x && close(x, dir));
  };
  let pool = list.filter(sameDir);
  if (!pool.length) pool = list; // sens non reconnu : les deux, plutôt qu'aucun
  const ids = new Set();
  for (const pass of [(n) => n === key, (n) => key.length >= 5 && (n.startsWith(key) || key.startsWith(n)) && n.length >= 5]) {
    for (const v of pool) for (const id of v.stops) if (stops[id] && pass(normName(stops[id].n))) ids.add(id);
    if (ids.size) break;
  }
  return [...ids];
}

// --- lecture d'ensemble --------------------------------------------------------

const KIND_LABEL = { arret: 'arrêts non desservis', coupure: 'ligne interrompue sur une partie du parcours', ligne: 'ligne suspendue' };

// alerts : [{ id, title, description (HTML), url, routes: [route_id] }]
// → { closures, at(t), describe(closure) }
export function parseDisruptions(alerts, { routeById, variants, stops, now = Math.floor(Date.now() / 1000) } = {}) {
  const closures = [];
  for (const a of alerts ?? []) {
    const routes = (a.routes ?? []).filter((id) => variants?.[id]);
    if (!routes.length) continue;
    for (const section of htmlSections(a.description)) {
      const text = plain(section.html);
      const head = `${section.title} ${text}`;
      // Un arrêt DÉPLACÉ reste desservi (cinquante mètres plus loin).
      if (/^d[ée]placement d'arr[êe]t/i.test(section.title) && !/non\s+desservi/i.test(text)) continue;
      const period = parsePeriod(`${text.slice(0, 320)} ${section.title}`, now) ?? parsePeriod(section.title, now);
      for (const routeId of routes) {
        const line = routeById?.get(routeId)?.short_name ?? '';
        const list = variants[routeId] ?? [];
        const base = {
          alert_id: a.id, route_id: routeId, line, title: section.title || plain(a.title), url: a.url || null,
          periods: period?.periods ?? null, weekdaysOnly: Boolean(period?.weekdaysOnly), period_text: period?.text ?? null,
        };
        // Toute la ligne : « La ligne 13 est suspendue ».
        if (/\bligne\b[^.]{0,40}\b(?:est|sera)\s+suspendue|\bne circule (?:pas|plus)\b(?![^.]{0,30}\bentre\b)/i.test(text) && !/non\s+desservi/i.test(text)) {
          closures.push({ ...base, kind: 'ligne', stopIds: new Set(list.flatMap((v) => v.stops)), names: [], unknown: [] });
          continue;
        }
        const lists = closedLists(section.html, line);
        const single = lists.length ? null : singleStop(section.title, text, line);
        const groups = lists.length ? lists : single ? [single] : [];
        if (!groups.length) continue;
        const stopIds = new Set(), names = [], unknown = [];
        for (const g of groups) {
          for (const item of g.noms) {
            const { name, direction } = splitItem(item);
            const ids = stopIdsFor(name, direction ?? g.direction, list, stops);
            if (ids.length) { for (const id of ids) stopIds.add(id); names.push(name); } else unknown.push(name);
          }
        }
        if (!stopIds.size && !unknown.length) continue;
        // Coupure : on ne TRAVERSE pas ces arrêts (le tram ne roule pas sur le
        // tronçon). Déviation : le bus les contourne et continue.
        const kind = /interrompue?s?\b|arr[êe]t partiel|ne circule (?:pas|plus)\b[^.]{0,30}\bentre\b/i.test(head) ? 'coupure' : 'arret';
        closures.push({ ...base, kind, stopIds, names: [...new Set(names)], unknown: [...new Set(unknown)] });
      }
    }
  }

  const isActive = (c, t) => {
    if (!c.periods) return Math.abs(t - now) <= UNDATED_WINDOW_S;
    if (c.weekdaysOnly && ['Sat', 'Sun'].includes(parisParts(t).wd)) return false;
    return c.periods.some(([from, to]) => (from == null || t >= from) && (to == null || t < to));
  };
  const byRoute = new Map();
  for (const c of closures) (byRoute.get(c.route_id) ?? byRoute.set(c.route_id, []).get(c.route_id)).push(c);

  const fmtDate = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const describe = (c) => ({
    ligne: c.line,
    effet: KIND_LABEL[c.kind],
    ...(c.names.length ? { arrets_non_desservis: c.names } : {}),
    ...(c.unknown.length ? { arrets_cites_non_reconnus: c.unknown } : {}),
    periode: c.periods
      ? c.periods.map(([from, to]) => `${from == null ? 'en cours' : `du ${fmtDate.format(new Date(from * 1000))}`} ${to == null ? 'sans date de fin' : `au ${fmtDate.format(new Date(to * 1000))}`}`).join(' ; ') + (c.weekdaysOnly ? ' (hors week-ends)' : '')
      : 'non datée : considérée comme en cours',
    titre: c.title,
    ...(c.url ? { lien: c.url } : {}),
  });

  // Vue du réseau à l'instant t.
  function at(t = now) {
    const active = new Map();
    for (const [routeId, list] of byRoute) {
      const on = list.filter((c) => isActive(c, t));
      if (on.length) active.set(routeId, on);
    }
    const find = (routeId, stopId, kinds) => (active.get(routeId) ?? []).find((c) => kinds.includes(c.kind) && c.stopIds.has(stopId)) ?? null;
    return {
      t,
      size: active.size,
      // Montée et descente impossibles à ce quai, pour cette ligne.
      stopClosed: (routeId, stopId) => find(routeId, stopId, ['arret', 'coupure', 'ligne']),
      // La ligne ne passe pas par ce quai DU TOUT : on ne le traverse pas.
      cut: (routeId, stopId) => find(routeId, stopId, ['coupure', 'ligne']),
      suspended: (routeId) => (active.get(routeId) ?? []).find((c) => c.kind === 'ligne') ?? null,
      forRoute: (routeId) => active.get(routeId) ?? [],
      forStops: (stopIds) => {
        const ids = new Set(stopIds), out = [];
        for (const list of active.values()) for (const c of list) if ([...c.stopIds].some((id) => ids.has(id))) out.push(c);
        return out;
      },
    };
  }
  // Accès direct, sans construire de vue : pour filtrer des passages un par un,
  // chacun à SON heure.
  const closedAt = (routeId, stopId, t) => (byRoute.get(routeId) ?? []).find((c) => c.stopIds.has(stopId) && isActive(c, t)) ?? null;
  const activeFor = (routeIds, t) => [...new Set(routeIds)].flatMap((id) => (byRoute.get(id) ?? []).filter((c) => isActive(c, t)));
  // Fermetures qui touchent ces quais (toutes lignes, ou celles données), à l'instant t.
  const activeAtStops = (stopIds, t, routeIds = null) => {
    const ids = new Set(stopIds), out = [];
    for (const [routeId, list] of byRoute) {
      if (routeIds && !routeIds.has(routeId)) continue;
      for (const c of list) if (isActive(c, t) && [...c.stopIds].some((id) => ids.has(id))) out.push(c);
    }
    return out;
  };
  return { closures, at, describe, isActive, closedAt, activeFor, activeAtStops };
}

// Vue vide : aucun arrêt fermé. Évite un test de nullité à chaque appel.
export const NO_DISRUPTION = Object.freeze({ t: 0, size: 0, stopClosed: () => null, cut: () => null, suspended: () => null, forRoute: () => [], forStops: () => [] });
