// L'application sur un téléphone.
//
// C'est une carte, et elle n'a jamais été ouverte en taille téléphone : tous
// les tests existants tournent en 1280×720. Le risque n'est pas que ça plante,
// c'est que le panneau occupe tout l'écran, qu'un bouton soit hors d'atteinte,
// ou qu'un élément déborde horizontalement (donc un scroll parasite).
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* plus loin */ }
  const cache = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const dir of readdirSync(cache)) {
    const p = join(cache, dir, 'node_modules', 'playwright');
    if (existsSync(p)) return createRequire(import.meta.url)(p);
  }
  throw new Error('playwright introuvable dans le cache npx');
}

const { chromium } = loadPlaywright();
const URL = process.env.URL || 'http://localhost:4127/';
const TMP = process.env.TEMP || '.';

const TELEPHONES = [
  { nom: 'iphone-390', width: 390, height: 844, dpr: 3, tactile: true },
  { nom: 'petit-360', width: 360, height: 640, dpr: 2, tactile: true },
  { nom: 'tablette-820', width: 820, height: 1180, dpr: 2, tactile: true },
];

const echecs = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) echecs.push(m); };

const navigateur = await chromium.launch();

for (const tel of TELEPHONES) {
  console.log(`\n=== ${tel.nom} (${tel.width}×${tel.height}, ${tel.dpr}x) ===`);
  const ctx = await navigateur.newContext({
    viewport: { width: tel.width, height: tel.height },
    deviceScaleFactor: tel.dpr,
    hasTouch: tel.tactile,
    isMobile: true,
    locale: 'fr-FR',
  });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e.message).slice(0, 100)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);

  const m = await page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const doc = document.documentElement;
    return {
      debord: doc.scrollWidth - doc.clientWidth,
      carte: r('#map'),
      entete: r('header, .topbar, #topbar'),
      panneau: r('#panel, aside, .panel'),
      compteurVeh: r('#statVehiclesBtn'),
      compteurLignes: r('#statLinesBtn'),
      boutonItin: r('#planner'),
      boutonCarte: r('#btnMap'),
      boutonTiles: r('#btnTiles'),
      boutons: [...document.querySelectorAll('header button, #topbar button')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => { const x = b.getBoundingClientRect(); return { t: (b.textContent || b.title || '').trim().slice(0, 12), w: Math.round(x.width), h: Math.round(x.height) }; }),
      pastilles: document.querySelectorAll('.leaflet-marker-icon').length,
      leaflet: typeof window.L !== 'undefined',
    };
  });

  ok(m.leaflet, 'Leaflet chargé');
  ok(m.debord <= 1, `pas de débordement horizontal (${m.debord} px)`);
  ok(m.carte && m.carte.w > 0, `la carte occupe de la place (${m.carte?.w}×${m.carte?.h})`);
  ok(m.pastilles > 0, `des véhicules affichés (${m.pastilles})`);

  // La carte doit rester visible : un panneau qui la recouvre entièrement est
  // inutilisable sur un téléphone.
  const partCarte = m.carte ? (m.carte.w * m.carte.h) / (tel.width * tel.height) : 0;
  ok(partCarte > 0.2, `la carte reste visible (${Math.round(partCarte * 100)} % de l'écran)`);

  // Présentation téléphone : l'en-tête ne mange plus l'écran (il en prenait près de la
  // moitié), les commandes de la carte flottent sur la carte, le panneau est une feuille
  // dont seule la poignée dépasse tant qu'on ne l'ouvre pas.
  const pres = await page.evaluate(() => {
    const boite = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const carte = boite(document.querySelector('.mapwrap'));
    const outils = [...document.querySelectorAll('.map-tools button')].filter((b) => b.offsetParent !== null).map(boite);
    const feuille = boite(document.getElementById('sidebar'));
    const poignee = boite(document.getElementById('sidebarToggle'));
    return {
      entete: boite(document.querySelector('.topbar')).h, carte, outils, feuille, poignee,
      contenuCache: getComputedStyle(document.querySelector('.sidebar-body')).visibility === 'hidden',
      emojis: [...document.querySelectorAll('.topbar button, .map-tools button, .planner > summary')].filter((e) => /\p{Extended_Pictographic}/u.test(e.textContent)).length,
      icones: document.querySelectorAll('.topbar .ic, .map-tools .ic').length,
    };
  });
  ok(pres.entete <= tel.height * 0.24, `l'en-tête tient en deux lignes (${pres.entete} px, soit ${Math.round(100 * pres.entete / tel.height)} % de l'écran)`);
  ok(pres.outils.length >= 4 && pres.outils.every((b) => b.w >= 44 && b.h >= 44 && b.y >= pres.carte.y && b.x + b.w <= tel.width),
    `les commandes de la carte flottent sur la carte, à 44 px (${pres.outils.length} boutons)`);
  ok(pres.poignee.h >= 44 && pres.poignee.y + pres.poignee.h <= tel.height + 1 && pres.feuille.y >= tel.height - 80 && pres.contenuCache,
    `fermée, la feuille ne laisse voir que sa poignée (haut à y=${pres.feuille.y}, écran ${tel.height})`);
  ok(pres.emojis === 0 && pres.icones >= 8, `des icônes dessinées, plus d'emojis, dans l'en-tête et les commandes (${pres.icones} icônes, ${pres.emojis} emoji)`);

  // Cibles tactiles : 40 px est le plancher usuel (WCAG 2.1 AA).
  const petits = m.boutons.filter((b) => b.h > 0 && (b.h < 32 || b.w < 32));
  ok(petits.length === 0, `toutes les cibles tactiles font au moins 32 px`
    + (petits.length ? ` (trop petites : ${petits.map((b) => `${b.t} ${b.w}×${b.h}`).join(', ')})` : ''));

  // Rien d'essentiel ne doit être hors de l'écran. Les boutons d'action
  // disparaissaient en premier quand la barre défilait horizontalement, sans
  // que rien ne l'indique.
  for (const [nom, k] of [['compteur véhicules', 'compteurVeh'], ['compteur lignes', 'compteurLignes'],
    ['bouton fond de carte', 'boutonCarte'], ['bascule thème', 'boutonTiles']]) {
    const b = m[k];
    ok(b && b.w > 0 && b.x + b.w <= tel.width + 1 && b.y + b.h <= tel.height + 1,
      `${nom} est entièrement visible (x=${b?.x}→${(b?.x ?? 0) + (b?.w ?? 0)}, y=${b?.y} h=${b?.h})`);
  }

  // L'inventaire doit tenir dans l'écran.
  await page.click('#statVehiclesBtn');
  await page.waitForTimeout(1200);
  const inv = await page.evaluate(() => {
    const e = document.getElementById('inventory');
    const b = e.getBoundingClientRect();
    return { visible: !e.classList.contains('hidden'), h: Math.round(b.height), y: Math.round(b.y), lignes: e.querySelectorAll('li.inv').length };
  });
  ok(inv.visible, `inventaire ouvert (${inv.lignes} véhicules)`);
  ok(inv.y + inv.h <= tel.height + 2, `l'inventaire tient dans l'écran (y=${inv.y} h=${inv.h}, écran ${tel.height})`);

  // Le bouton de rafraîchissement : le suffixe « s » doit disparaître quand le
  // push est actif, sinon il affiche « ↻ lives ».
  const raf = await page.evaluate(() => {
    const b = document.getElementById('btnRefresh');
    const s = document.getElementById('countdownS');
    return {
      // innerText respecte la visibilité : textContent garderait le suffixe
      // caché, et le test ne verrait pas le défaut qu'il cherche.
      visible: b.innerText.replace(/\s+/g, ' ').trim(),
      brut: b.textContent.replace(/\s+/g, ' ').trim(),
      suffixeVisible: !!s && getComputedStyle(s).display !== 'none',
    };
  });
  ok(!/lives/.test(raf.visible) && !raf.suffixeVisible,
    `le bouton de rafraîchissement est lisible (« ${raf.visible} », `
    + `texte brut « ${raf.brut} », suffixe visible : ${raf.suffixeVisible})`);

  const legende = await page.evaluate(() => {
    const e = document.querySelector('.legend');
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { lignes: Math.round(b.height), deborde: e.scrollWidth > Math.round(b.width) + 2, h: Math.round(b.height) };
  });
  ok(legende && legende.h < 46, `la légende tient sur une ligne (h=${legende?.h})`);

  await page.screenshot({ path: join(TMP, `tisseo-${tel.nom}.png`) });
  console.log('     capture :', join(TMP, `tisseo-${tel.nom}.png`));

  await page.click('#inventory .close, #btnCloseInv, #inventory h3 button');
  await page.waitForTimeout(600);

  // Le planificateur A→B vit dans la barre latérale, qui est un tiroir sur
  // téléphone : il faut l'ouvrir avant d'atteindre le formulaire.
  const tiret = await page.$('.sidebar-toggle');
  if (tiret) {
    const visible = await tiret.isVisible();
    ok(visible, 'le bouton d\'ouverture du panneau est présent');
    if (visible) await tiret.click();
    await page.waitForTimeout(600);
  }
  ok(await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    return !!s && s.getBoundingClientRect().x >= -1;
  }), 'le panneau s\'ouvre bien');
  const ouverte = await page.evaluate(() => {
    const f = document.getElementById('sidebar').getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect();
    return { haut: Math.round(f.y), bas: Math.round(f.bottom), sousEntete: Math.round(f.y - t.bottom), visible: getComputedStyle(document.querySelector('.sidebar-body')).visibility !== 'hidden', expanded: document.getElementById('sidebarToggle').getAttribute('aria-expanded') };
  });
  ok(ouverte.visible && ouverte.sousEntete >= 60 && ouverte.bas <= tel.height + 1 && ouverte.expanded === 'true',
    `ouverte, la feuille monte du bas et laisse ${ouverte.sousEntete} px de carte au-dessus`);

  const vol = await page.evaluate(() => {
    const e = document.getElementById('planner');
    if (!e) return null;
    e.open = true; // le <details> est replié par défaut
    const b = e.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) };
  });
  ok(!!vol, 'le volet itinéraire existe');
  if (vol) {
    ok(vol.w > 0 && vol.w <= tel.width, `le volet ne dépasse pas la largeur (${vol.w}/${tel.width})`);
    ok(vol.y + vol.h <= tel.height + 2, `le volet tient dans l'écran (y=${vol.y} h=${vol.h})`);
  }
  await page.fill('#jFrom', 'Capitole');
  await page.fill('#jTo', 'Basso Cambo');
  await page.click('#jGo');
  await page.waitForTimeout(6000);
  const res = await page.evaluate(() => ({
    erreur: document.querySelector('.jerr')?.textContent?.trim()?.slice(0, 40) || null,
    etapes: document.querySelectorAll('li.jleg').length,
    duree: document.querySelector('.jhead b')?.textContent?.trim() || null,
  }));
  ok(res.etapes > 0 || res.erreur, `calcul d'itinéraire sur téléphone (${res.duree || res.erreur || 'rien'})`);
  await page.screenshot({ path: join(TMP, `tisseo-${tel.nom}-itin.png`) });

  // Une fiche qui s'ouvre sur la carte ne doit pas rester cachée derrière la feuille.
  await page.click('#statVehiclesBtn');
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => !document.getElementById('inventory').classList.contains('hidden') && !document.getElementById('sidebar').classList.contains('open')),
    'ouvrir une fiche sur la carte efface la feuille');

  if (erreurs.length) ok(false, `erreurs JavaScript : ${erreurs.slice(0, 2).join(' | ')}`);
  else ok(true, 'aucune erreur JavaScript');

  await ctx.close();
}

await navigateur.close();
console.log(echecs.length ? `\n${echecs.length} échec(s)` : '\nTout est vert');
process.exit(echecs.length ? 1 : 0);
