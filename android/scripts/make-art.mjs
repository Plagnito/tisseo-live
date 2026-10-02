// Dessine les icônes et les illustrations de l'application, et les écrit en
// VectorDrawable (res/drawable/). Aucune image importée : tout est tracé ici,
// dans la palette de l'application, et se relit comme du code.
//
//   node scripts/make-art.mjs                 régénère res/drawable/ic_*.xml et ill_*.xml
//   node scripts/make-art.mjs --apercu f.html  écrit aussi une planche HTML (mêmes tracés, en SVG)
//
// Les icônes sont au trait (grille 24, épaisseur 1.8, extrémités rondes), d'une
// seule couleur : l'application les teinte. Les illustrations (320 × 150) sont
// en aplats et gardent leurs couleurs.
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INK = '#253C3B', PAPER = '#F8F6F1', ACCENT = '#B45B40', MUTED = '#64706C';
const SAND = '#EFE6D6', MIST = '#DCE9E4', LEAF = '#7FAE8F', BLUSH = '#F3D9CC', SUN = '#E9B949', WHITE = '#FFFFFF', WATER = '#BFD9E6';

// --- tracés élémentaires (mêmes chaînes pour SVG et VectorDrawable) -----------
const n = (x) => String(Math.round(x * 100) / 100);
const C = (cx, cy, r) => `M${n(cx - r)},${n(cy)}a${n(r)},${n(r)} 0 1,0 ${n(2 * r)},0a${n(r)},${n(r)} 0 1,0 ${n(-2 * r)},0Z`;
const RR = (x, y, w, h, r = 0) => (r
  ? `M${n(x + r)},${n(y)}H${n(x + w - r)}a${n(r)},${n(r)} 0 0,1 ${n(r)},${n(r)}V${n(y + h - r)}a${n(r)},${n(r)} 0 0,1 ${n(-r)},${n(r)}H${n(x + r)}a${n(r)},${n(r)} 0 0,1 ${n(-r)},${n(-r)}V${n(y + r)}a${n(r)},${n(r)} 0 0,1 ${n(r)},${n(-r)}Z`
  : `M${n(x)},${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`);
/** Pointillés : VectorDrawable n'a pas de tirets, on pose des pastilles le long d'une ligne brisée. */
function dots(points, pas, r) {
  let d = '', reste = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const L = Math.hypot(x2 - x1, y2 - y1);
    for (let t = reste; t <= L; t += pas) d += C(x1 + (x2 - x1) * t / L, y1 + (y2 - y1) * t / L, r);
    reste = (Math.ceil((L - reste) / pas) * pas + reste) - L;
  }
  return d;
}
/** Courbe de Bézier quadratique échantillonnée (pour poser des pointillés sur une courbe). */
const courbe = (p0, p1, p2, k = 24) => Array.from({ length: k + 1 }, (_, i) => { const t = i / k; return [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]]; });
const pin = (x, y, s) => `M${n(x)},${n(y)}C${n(x)},${n(y)} ${n(x - 7 * s)},${n(y - 7.5 * s)} ${n(x - 7 * s)},${n(y - 12.5 * s)}a${n(7 * s)},${n(7 * s)} 0 0,1 ${n(14 * s)},0C${n(x + 7 * s)},${n(y - 7.5 * s)} ${n(x)},${n(y)} ${n(x)},${n(y)}Z`;

const S = (d, w = 1.8) => ({ d, stroke: INK, w });           // trait
const F = (d) => ({ d, fill: INK });                          // plein (icône)
const A = (d, fill, extra = {}) => ({ d, fill, ...extra });   // aplat (illustration)
const T = (d, stroke, w = 2) => ({ d, stroke, w });           // trait (illustration)

// --- icônes ---------------------------------------------------------------------
const ICONES = {
  explore: [S(C(12, 12, 9)), S('M15.6,8.4L13.5,13.5L8.4,15.6L10.5,10.5Z')],
  bus: [S(RR(5, 3.8, 14, 13.7, 3)), S('M5,11H19'), F(C(8.6, 14.3, 0.9)), F(C(15.4, 14.3, 0.9)), S('M8,17.5V20M16,17.5V20'), S('M9.5,6.8H14.5')],
  metro: [S(RR(5.5, 3, 13, 15, 4)), S(RR(8.3, 6.2, 7.4, 4.8, 1.2)), F(C(9, 14.6, 0.9)), F(C(15, 14.6, 0.9)), S('M8.8,18L6.8,21M15.2,18L17.2,21')],
  tram: [S('M8.5,2.6H15.5M12,2.6V5.2'), S(RR(6, 5.2, 12, 12.8, 3)), S('M6,11.6H18'), F(C(9, 14.8, 0.9)), F(C(15, 14.8, 0.9)), S('M9,18L7.6,21M15,18L16.4,21')],
  cable: [S('M3,5.4L21,3'), S('M12,4.2V8.2'), S(RR(6.5, 8.2, 11, 10.3, 3)), S('M6.5,13.4H17.5M12,8.2V13.4')],
  walk: [F(C(13.2, 4.4, 1.7)), S('M13,8.2L11.2,13.2L13.8,16L14.3,21M11.2,13.2L8.6,21M13,8.4L9.6,10.4L8.6,13.4M13.2,8.6L15.4,11.2L18,12.2')],
  bike: [S(C(6, 16, 3.6)), S(C(18, 16, 3.6)), S('M6,16L9.6,9.4H15L18,16M9.6,9.4L12.6,16L15,9.4M8.4,9.4H10.8M15,9.4L14.2,6.8H16.6')],
  pin: [S(pin(12, 21.2, 1)), S(C(12, 8.9, 2.4))],
  clock: [S(C(12, 12, 9)), S('M12,7V12L15.4,14')],
  bell: [S('M6.5,17.2V11a5.5,5.5 0 0,1 11,0V17.2M4.6,17.4H19.4M10.3,20.2a1.8,1.8 0 0,0 3.4,0M12,3.4V5.4')],
  share: [S(C(6, 12, 2.4)), S(C(17.6, 6, 2.4)), S(C(17.6, 18, 2.4)), S('M8.1,10.9L15.5,7.1M8.1,13.1L15.5,16.9')],
  friends: [S(C(9, 8, 3.1)), S('M3.4,19.6a5.6,5.6 0 0,1 11.2,0'), S(C(16.8, 9.2, 2.4)), S('M16,14.3a4.7,4.7 0 0,1 4.8,5.3')],
  bookmark: [S('M7,3.6H17a1,1 0 0,1 1,1V20.4L12,16.4L6,20.4V4.6a1,1 0 0,1 1,-1Z')],
  calendar: [S(RR(4, 5.5, 16, 15, 2.5)), S('M4,10H20M8.5,3.5V7M15.5,3.5V7'), F(C(8.6, 13.6, 0.9)), F(C(12, 13.6, 0.9)), F(C(15.4, 13.6, 0.9)), F(C(8.6, 17, 0.9)), F(C(12, 17, 0.9))],
  lock: [S(RR(5.5, 10.5, 13, 10, 2.5)), S('M8.5,10.5V8a3.5,3.5 0 0,1 7,0V10.5M12,14.4V16.6')],
  devices: [S(RR(3.5, 7.5, 6.6, 12, 1.6)), S('M5.8,17H7.8'), S(RR(12.6, 5.5, 8, 6.4, 1.2)), S('M11.4,14.8H21.8M16.6,11.9V14.8')],
  account: [S(C(12, 8.5, 3.7)), S('M5,20.2a7,7 0 0,1 14,0')],
  settings: [S('M4,7H7.2M11.2,7H20M4,12H13M17,12H20M4,17H6.2M10.2,17H20'), S(C(9.2, 7, 2)), S(C(15, 12, 2)), S(C(8.2, 17, 2))],
  target: [S(C(12, 12, 6.4)), F(C(12, 12, 1.7)), S('M12,2.6V5.6M12,18.4V21.4M2.6,12H5.6M18.4,12H21.4')],
  route: [S(C(6, 18, 2.2)), S(C(18, 6, 2.2)), S('M8.2,18H13.5a3.5,3.5 0 0,0 0,-7H10.5a2.5,2.5 0 0,1 0,-5H15.8')],
  stop: [S('M12,12V21M9,21H15'), S(RR(6.5, 3, 11, 9, 2.2)), S('M9.6,7.5H14.4')],
  alert: [S('M12,4.2L20.8,19.4H3.2Z'), S('M12,10V14.2'), F(C(12, 16.8, 0.95))],
  parking: [S(RR(4, 4, 16, 16, 3.5)), S('M10,16.6V7.6H13a2.6,2.6 0 0,1 0,5.2H10')],
  event: [S('M4,8.2a1.6,1.6 0 0,1 1.6,-1.6H18.4a1.6,1.6 0 0,1 1.6,1.6V10a2,2 0 0,0 0,4V15.8a1.6,1.6 0 0,1 -1.6,1.6H5.6a1.6,1.6 0 0,1 -1.6,-1.6V14a2,2 0 0,0 0,-4Z'), S('M14.6,6.8V8.6M14.6,11.1V12.9M14.6,15.4V17.2')],
  food: [S('M7,3.6V9a2,2 0 0,0 4,0V3.6M9,3.6V20.4M16,20.4V3.6c2.2,1.5 3,4 3,7.6H16')],
  park: [S(C(12, 9, 5.5)), S('M12,14.5V20.5M12,17.2L14.6,14.9M7.5,20.5H16.5')],
  culture: [S('M3.6,9L12,4.2L20.4,9Z'), S('M6.6,11.6V17M12,11.6V17M17.4,11.6V17M4,19.6H20')],
  building: [S('M5,20.5V5.5a1.5,1.5 0 0,1 1.5,-1.5H17.5a1.5,1.5 0 0,1 1.5,1.5V20.5M3.5,20.5H20.5'), S('M9,8H10.2M13.8,8H15M9,12H10.2M13.8,12H15M10.5,20.5V16.5H13.5V20.5')],
  water: [S('M12,3.6C12,3.6 6,10 6,14.5a6,6 0 0,0 12,0C18,10 12,3.6 12,3.6Z')],
  sport: [S(C(12, 12, 8.6)), S('M12,3.4V20.6M3.4,12H20.6M6,5.9a8.6,8.6 0 0,1 0,12.2M18,5.9a8.6,8.6 0 0,0 0,12.2')],
  book: [S('M12,6.6C10,5.1 7,4.6 4,5.1V18.6C7,18.1 10,18.6 12,20.1C14,18.6 17,18.1 20,18.6V5.1C17,4.6 14,5.1 12,6.6ZM12,6.6V20')],
  works: [S('M10.6,4.5H13.4L17.4,19.5H6.6Z'), S('M8.7,12H15.3M4.5,19.5H19.5')],
  info: [S(C(12, 12, 9)), S('M12,11V16.6'), F(C(12, 7.8, 1))],
  chevron: [S('M9.5,6L15.5,12L9.5,18', 2)],
  star: [S('M12,3.6L14.6,9L20.5,9.8L16.2,13.9L17.3,19.8L12,17L6.7,19.8L7.8,13.9L3.5,9.8L9.4,9Z')],
  star_on: [F('M12,3.6L14.6,9L20.5,9.8L16.2,13.9L17.3,19.8L12,17L6.7,19.8L7.8,13.9L3.5,9.8L9.4,9Z'), S('M12,3.6L14.6,9L20.5,9.8L16.2,13.9L17.3,19.8L12,17L6.7,19.8L7.8,13.9L3.5,9.8L9.4,9Z')],
  trash: [S('M5,7H19M9.6,7V4.6H14.4V7M6.6,7L7.6,20H16.4L17.4,7M10,10.6V16.4M14,10.6V16.4')],
  play: [S('M8.2,5L18.8,12L8.2,19Z')],
  pause: [S('M8.6,5.6V18.4M15.4,5.6V18.4', 2.4)],
  stop_square: [S(RR(6, 6, 12, 12, 2.2))],
  assistant: [S('M5,4.6H19a2,2 0 0,1 2,2V14.6a2,2 0 0,1 -2,2H11.2L7,20.4V16.6H5a2,2 0 0,1 -2,-2V6.6a2,2 0 0,1 2,-2Z'), S('M12,7.8V13.4M9.2,10.6H14.8')],
  cloud: [S('M7.6,18.6a3.8,3.8 0 0,1 0.4,-7.6a5.2,5.2 0 0,1 9.9,1.2a3.2,3.2 0 0,1 -0.5,6.4Z')],
  refresh: [S('M19,12a7,7 0 1,1 -2.2,-5.1M19.4,4.4V8H15.8')],
  filter: [S('M4,6H20L14,13V19L10,17V13Z')],
  grid: [S(RR(4, 4, 6.8, 6.8, 1.6)), S(RR(13.2, 4, 6.8, 6.8, 1.6)), S(RR(4, 13.2, 6.8, 6.8, 1.6)), S(RR(13.2, 13.2, 6.8, 6.8, 1.6))],
  medal: [S(C(12, 14.6, 5.4)), S('M9.2,10L6.6,3.6H10L12,8L14,3.6H17.4L14.8,10'), S('M12,12.4L12.8,14L14.5,14.2L13.2,15.4L13.6,17.1L12,16.2L10.4,17.1L10.8,15.4L9.5,14.2L11.2,14Z', 1.2)],
  flag: [S('M6,21V4M6,5H17.2L15,8.5L17.2,12H6')],
  widget: [S(RR(4, 4, 7, 7, 1.6)), S(RR(13, 4, 7, 7, 1.6)), S(RR(4, 13, 16, 7, 1.6))],
  heart: [S('M12,20C12,20 4,15 4,9.4a4.2,4.2 0 0,1 8,-1.8a4.2,4.2 0 0,1 8,1.8C20,15 12,20 12,20Z')],
  source: [S(C(12, 12, 9)), S('M3,12H21M12,3c3,2.6 3,15.4 0,18M12,3c-3,2.6 -3,15.4 0,18')],
  phone: [S('M6.5,4h3l1.5,4l-2,1.5a11,11 0 0,0 5.5,5.5l1.5,-2l4,1.5v3a2,2 0 0,1 -2,2A15,15 0 0,1 4.5,6a2,2 0 0,1 2,-2Z')],
  link: [S('M10,14a4,4 0 0,0 5.6,0l3,-3a4,4 0 0,0 -5.6,-5.6l-1.2,1.2M14,10a4,4 0 0,0 -5.6,0l-3,3a4,4 0 0,0 5.6,5.6l1.2,-1.2')],
  check: [S('M5,12.5L10,17.5L19,7', 2.2)],
  plus: [S('M12,5V19M5,12H19', 2)],
  sun: [S(C(12, 12, 4)), S('M12,2.6V5M12,19V21.4M2.6,12H5M19,12H21.4M5.4,5.4L7.1,7.1M16.9,16.9L18.6,18.6M5.4,18.6L7.1,16.9M16.9,7.1L18.6,5.4')],
  logout: [S('M10,4.5H6.5a2,2 0 0,0 -2,2V17.5a2,2 0 0,0 2,2H10'), S('M14.5,8L18.5,12L14.5,16M18.5,12H9.5')],
  // — surtout pour le site : commandes de carte, formulaire, feuille —
  fit: [S('M4,9V4.5H8.5M15.5,4.5H20V9M20,15V19.5H15.5M8.5,19.5H4V15')],
  layers: [S('M12,3.6L20.5,8L12,12.4L3.5,8Z'), S('M3.5,12L12,16.4L20.5,12M3.5,16L12,20.4L20.5,16')],
  contrast: [S(C(12, 12, 9)), F('M12,3a9,9 0 0,1 0,18Z')],
  search: [S(C(10.5, 10.5, 6.5)), S('M15.4,15.4L20.5,20.5', 2)],
  close: [S('M6,6L18,18M18,6L6,18', 2)],
  swap: [S('M8,4V20M8,20L4.5,16.5M8,20L11.5,16.5M16,20V4M16,4L12.5,7.5M16,4L19.5,7.5')],
  chevron_up: [S('M6,14.5L12,8.5L18,14.5', 2)],
  toilets: [F(C(8, 5, 1.6)), F(C(16, 5, 1.6)), S('M8,8.4V14M6,20V14H10V20M6,10.6H10M16,8.4L13.6,15H18.4ZM15,15V20M17,15V20M12,3.5V20.5', 1.5)],
};

// --- illustrations (320 × 150) -----------------------------------------------------
const fond = (c) => A(RR(0, 8, 320, 134, 22), c);
const telephone = (x, y, w, h) => [A(RR(x, y, w, h, 9), INK), A(RR(x + 4, y + 9, w - 8, h - 20, 4), PAPER), A(C(x + w / 2, y + h - 5.5, 2), PAPER)];
const nuage = (x, y, s, c) => A(`M${n(x)},${n(y)}a${n(11 * s)},${n(11 * s)} 0 0,1 ${n(2 * s)},${n(-21.5 * s)}a${n(15 * s)},${n(15 * s)} 0 0,1 ${n(28.5 * s)},${n(-3.5 * s)}a${n(12.5 * s)},${n(12.5 * s)} 0 0,1 ${n(3.5 * s)},${n(25 * s)}Z`, c);
const arbre = (x, y, s, c = LEAF) => [A(RR(x - 1.6 * s, y - 14 * s, 3.2 * s, 14 * s, 1), INK), A(C(x, y - 20 * s, 10 * s), c), A(C(x + 6 * s, y - 13 * s, 6 * s), c)];
const personne = (x, y, s, c) => [A(C(x, y - 15 * s, 5.4 * s), c), A(`M${n(x - 9 * s)},${n(y)}a${n(9 * s)},${n(9 * s)} 0 0,1 ${n(18 * s)},0Z`, c)];

const ILLUSTRATIONS = {
  // Le même trajet, sur le téléphone et sur l'ordinateur, relié par le compte.
  account: [
    fond(SAND),
    ...telephone(34, 30, 58, 100),
    A(C(50, 62, 4.5), ACCENT), A(C(76, 100, 4.5), LEAF), T('M50,62C50,84 76,78 76,100', INK, 2.4),
    A(RR(204, 40, 96, 64, 7), INK), A(RR(209, 45, 86, 54, 3), PAPER), A(RR(192, 106, 120, 8, 4), INK),
    A(C(228, 60, 4.5), ACCENT), A(C(274, 86, 4.5), LEAF), T('M228,60C228,80 274,66 274,86', INK, 2.4),
    nuage(132, 84, 1.25, WHITE), A('M146,52H164a2,2 0 0,1 2,2V78L155,71L144,78V54a2,2 0 0,1 2,-2Z', ACCENT),
    A(dots(courbe([98, 70], [112, 50], [130, 58]), 6, 1.6), INK), A(dots(courbe([184, 58], [196, 50], [202, 62]), 6, 1.6), INK),
  ],
  // Deux amis sur une carte, un trajet en pointillés entre eux.
  share: [
    fond(MIST),
    A(RR(24, 26, 272, 98, 14), WHITE),
    T('M24,62H296M24,98H296M88,26V124M168,26V124M240,26V124', '#E3E8E4', 5),
    A('M24,104C70,96 96,116 140,110C196,102 230,124 296,112V110a14,14 0 0,1 -14,14H38a14,14 0 0,1 -14,-14Z', WATER),
    A(dots(courbe([86, 86], [150, 30], [236, 74], 40), 9, 2.4), INK),
    A(pin(86, 92, 1.5), ACCENT), A(C(86, 73, 5), WHITE),
    A(pin(236, 80, 1.5), LEAF), A(C(236, 61, 5), WHITE),
    A(C(132, 44, 13), SAND), ...personne(132, 55, 0.62, INK),
    A(C(192, 108, 13), BLUSH), ...personne(192, 119, 0.62, INK),
  ],
  // Une promenade : chemin, arbres, soleil, la distance qui se compte.
  walk: [
    fond(SAND),
    A(C(262, 44, 17), SUN),
    A('M0,120C60,84 110,112 160,96C214,80 262,104 320,84V120a22,22 0 0,1 -22,22H22a22,22 0 0,1 -22,-22Z', '#CFE3D3'),
    A('M0,128C70,104 130,134 190,116C240,102 286,120 320,108V120a22,22 0 0,1 -22,22H22a22,22 0 0,1 -22,-22Z', LEAF),
    ...arbre(52, 108, 1.15), ...arbre(286, 102, 0.9, '#5F977A'),
    A(dots(courbe([86, 132], [150, 96], [232, 118], 40), 10, 2.6), PAPER),
    A(pin(232, 122, 1.25), ACCENT), A(C(232, 106.5, 4.2), WHITE),
    // promeneur
    A(C(150, 62, 7), INK), T('M150,72L144,92L152,102L154,120M144,92L136,120M150,74L138,82L134,94M151,75L160,86L170,90', INK, 5),
  ],
  // Planifier : un calendrier, une heure, un rappel.
  plan: [
    fond(BLUSH),
    A(RR(44, 30, 118, 96, 12), WHITE), A(`M56,30H150a12,12 0 0,1 12,12V54H44V42a12,12 0 0,1 12,-12Z`, ACCENT),
    A(RR(70, 22, 7, 18, 3.5), INK), A(RR(129, 22, 7, 18, 3.5), INK),
    ...[0, 1, 2, 3].flatMap((i) => [0, 1, 2].map((j) => A(RR(58 + i * 25, 64 + j * 20, 15, 11, 3), i === 2 && j === 1 ? INK : '#E9E4D8'))),
    A(C(222, 78, 40), WHITE), T(C(222, 78, 40), INK, 4), T('M222,54V78L240,89', INK, 4.5), A(C(222, 78, 4), ACCENT),
    A(C(266, 38, 17), SUN), T('M258,42V37a8,8 0 0,1 16,0V42M254.5,43H277.5M263,47.5a3,3 0 0,0 6,0', INK, 2.6),
  ],
  // Un arrêt, un bus qui arrive, les minutes.
  stops: [
    fond(MIST),
    A('M0,116H320V120a22,22 0 0,1 -22,22H22a22,22 0 0,1 -22,-22Z', '#C9D6D1'),
    A(RR(58, 44, 6, 74, 3), INK), A(RR(38, 26, 46, 34, 8), ACCENT), T('M50,43H72', WHITE, 4),
    A(RR(128, 50, 150, 62, 14), WHITE), T(RR(128, 50, 150, 62, 14), INK, 4),
    A(RR(140, 62, 40, 24, 5), WATER), A(RR(186, 62, 40, 24, 5), WATER), A(RR(232, 62, 34, 24, 5), WATER),
    A(C(160, 114, 11), INK), A(C(160, 114, 4.5), PAPER), A(C(246, 114, 11), INK), A(C(246, 114, 4.5), PAPER),
    A(RR(132, 96, 12, 5, 2.5), SUN),
    A(C(96, 96, 15), INK), T('M96,87V96L102,100', PAPER, 3),
  ],
  // Rien encore : une carte, une épingle, une invitation à commencer.
  empty: [
    fond(SAND),
    A('M52,40L122,28L198,44L268,30V112L198,126L122,110L52,122Z', WHITE), T('M122,28V110M198,44V126', '#E3DCCB', 3),
    T('M52,40L122,28L198,44L268,30V112L198,126L122,110L52,122Z', INK, 3.5),
    A(dots(courbe([84, 96], [130, 60], [176, 88], 30), 9, 2.2), INK),
    A(pin(196, 92, 2), ACCENT), A(C(196, 67, 6.4), WHITE),
    A(C(84, 100, 6), LEAF),
  ],
  // Un assistant relié au compte : une bulle, un trajet, une clé de permission.
  assistant: [
    fond(MIST),
    A('M40,34H170a14,14 0 0,1 14,14V92a14,14 0 0,1 -14,14H96L70,128V106H40a14,14 0 0,1 -14,-14V48a14,14 0 0,1 14,-14Z', WHITE),
    A(RR(44, 52, 96, 9, 4.5), '#D5DEDA'), A(RR(44, 70, 122, 9, 4.5), '#D5DEDA'), A(RR(44, 88, 70, 9, 4.5), ACCENT),
    A(RR(204, 46, 84, 70, 12), INK), A(C(224, 70, 5), ACCENT), A(C(268, 96, 5), LEAF), T('M224,70C224,92 268,74 268,96', PAPER, 2.6),
    A(dots([[188, 78], [204, 78]], 6, 1.8), INK),
    A(C(246, 40, 15), SUN), T('M240,41V38a6,6 0 0,1 12,0V41', INK, 2.6), A(RR(237, 41, 18, 13, 3), INK),
  ],
  // Position partagée : un point qui émet, pour une durée.
  position: [
    fond(BLUSH),
    A(C(160, 78, 58), '#F7E7DE'), A(C(160, 78, 40), '#F0CDBD'), A(C(160, 78, 22), ACCENT), A(C(160, 78, 8), WHITE),
    A(C(70, 52, 16), WHITE), ...personne(70, 65, 0.75, INK),
    A(C(254, 108, 16), WHITE), ...personne(254, 121, 0.75, INK),
    A(dots([[88, 58], [138, 72]], 8, 2), INK), A(dots([[182, 86], [238, 104]], 8, 2), INK),
    A(C(252, 44, 17), WHITE), T(C(252, 44, 17), INK, 3), T('M252,34V44L259,48', INK, 3),
  ],
};

// --- sorties ------------------------------------------------------------------------
const ici = dirname(fileURLToPath(import.meta.url));
const dossier = join(ici, '..', 'app', 'src', 'main', 'res', 'drawable');
mkdirSync(dossier, { recursive: true });
const xmlDe = (elements, w, h, dpW, dpH) => `<?xml version="1.0" encoding="utf-8"?>
<!-- Généré par scripts/make-art.mjs : ne pas modifier à la main. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${dpW}dp" android:height="${dpH}dp" android:viewportWidth="${w}" android:viewportHeight="${h}">
${elements.map((e) => `    <path android:pathData="${e.d}"${e.fill ? ` android:fillColor="${e.fill}"` : ''}${e.stroke ? ` android:strokeColor="${e.stroke}" android:strokeWidth="${e.w}" android:strokeLineCap="round" android:strokeLineJoin="round"` : ''} />`).join('\n')}
</vector>
`;
for (const f of readdirSync(dossier)) if (/^(ic|ill)_[a-z_]+\.xml$/.test(f) && f !== 'ic_city.xml') unlinkSync(join(dossier, f));
for (const [nom, e] of Object.entries(ICONES)) writeFileSync(join(dossier, `ic_${nom}.xml`), xmlDe(e, 24, 24, 24, 24));
for (const [nom, e] of Object.entries(ILLUSTRATIONS)) writeFileSync(join(dossier, `ill_${nom}.xml`), xmlDe(e, 320, 150, 320, 150));
console.log(`${Object.keys(ICONES).length} icônes et ${Object.keys(ILLUSTRATIONS).length} illustrations écrites dans res/drawable/.`);

// --- le site : les mêmes tracés, en SVG en ligne -----------------------------------
// Les icônes y sont en « currentColor » : elles prennent la couleur du texte voisin,
// donc suivent d'elles-mêmes le thème sombre (Transports) et le thème clair (Ville).
{
  const chemin = (e, encre) => `<path d="${e.d}" fill="${e.fill ? (encre && e.fill === INK ? 'currentColor' : e.fill) : 'none'}"${e.stroke ? ` stroke="${encre && e.stroke === INK ? 'currentColor' : e.stroke}" stroke-width="${e.w}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`;
  const icones = Object.fromEntries(Object.entries(ICONES).map(([k, e]) => [k, e.map((x) => chemin(x, true)).join('')]));
  const dessins = Object.fromEntries(Object.entries(ILLUSTRATIONS).map(([k, e]) => [k, e.map((x) => chemin(x, false)).join('')]));
  const js = [
    '// Généré par android/scripts/make-art.mjs : ne pas modifier à la main.',
    "// Les icônes et illustrations du site — les mêmes tracés que l'application Android.",
    '(() => {',
    "  'use strict';",
    '  const I = ' + JSON.stringify(icones) + ';',
    '  const D = ' + JSON.stringify(dessins) + ';',
    '  const Art = {',
    '    /** Une icône au trait, à la couleur du texte. Décorative : le libellé voisin porte le sens. */',
    "    icon(nom, classe) { return I[nom] ? '<svg class=\"ic' + (classe ? ' ' + classe : '') + '\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">' + I[nom] + '</svg>' : ''; },",
    '    /** Une illustration, dans ses couleurs. */',
    "    ill(nom, classe) { return D[nom] ? '<svg class=\"ill' + (classe ? ' ' + classe : '') + '\" viewBox=\"0 0 320 150\" aria-hidden=\"true\" focusable=\"false\">' + D[nom] + '</svg>' : ''; },",
    '    has(nom) { return nom in I; },',
    "    /** Pose les icônes demandées par le balisage : <… data-ic=\"bus\">. Le texte de l'élément est conservé. */",
    '    poser(racine) {',
    "      for (const e of (racine || document).querySelectorAll('[data-ic]')) {",
    "        if (e.firstElementChild && e.firstElementChild.classList.contains('ic')) continue;",
    "        e.insertAdjacentHTML('afterbegin', Art.icon(e.dataset.ic));",
    '      }',
    '    },',
    '  };',
    '  window.Art = Art;',
    '  Art.poser();',
    '})();',
    '',
  ].join('\n');
  writeFileSync(join(ici, '..', '..', 'public', 'art.js'), js);
  console.log(`public/art.js écrit (${Math.round(js.length / 1024)} ko).`);
}

const i = process.argv.indexOf('--apercu');
if (i > 0 && process.argv[i + 1]) {
  const svg = (elements, w, h, px) => `<svg viewBox="0 0 ${w} ${h}" width="${px}" height="${px * h / w}">${elements.map((e) => `<path d="${e.d}" fill="${e.fill ?? 'none'}"${e.stroke ? ` stroke="${e.stroke}" stroke-width="${e.w}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`).join('')}</svg>`;
  writeFileSync(process.argv[i + 1], `<!doctype html><meta charset="utf-8"><title>Planche</title><style>body{font:13px system-ui;background:${PAPER};color:${INK};margin:16px}.g{display:flex;flex-wrap:wrap;gap:10px}.c{background:#fff;border-radius:12px;padding:10px;text-align:center;width:86px}.c svg{display:block;margin:0 auto 6px}.i{background:#fff;border-radius:14px;padding:10px;text-align:center}h2{margin:18px 0 8px}</style>
<h2>Icônes</h2><div class="g">${Object.entries(ICONES).map(([k, e]) => `<div class="c">${svg(e, 24, 24, 56)}${k}</div>`).join('')}</div>
<h2>Illustrations</h2><div class="g">${Object.entries(ILLUSTRATIONS).map(([k, e]) => `<div class="i">${svg(e, 320, 150, 400)}<br>${k}</div>`).join('')}</div>`);
  console.log('planche :', process.argv[i + 1]);
}
