// Téléphone — ce que la mise en page seule ne peut pas faire.
//
//   • les commandes de la carte (autour de moi, tout voir, fond, thème, actualiser)
//     quittent l'en-tête pour flotter sur la carte : ce sont les MÊMES boutons,
//     déplacés, donc leurs gestes (posés par app.js et city.js) restent les leurs ;
//   • le panneau est une feuille qui monte du bas : on la tire par sa poignée,
//     elle s'efface quand une fiche s'ouvre sur la carte, Échap la referme.
//
// Au-delà de 820 px, rien de tout cela ne s'applique : les boutons retournent
// dans l'en-tête.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const telephone = window.matchMedia('(max-width: 820px)');
  const feuille = $('sidebar'), poignee = $('sidebarToggle');
  const carte = document.querySelector('.mapwrap'), entete = document.querySelector('.topbar .actions');
  if (!feuille || !poignee || !carte || !entete) return;

  // --- commandes de la carte --------------------------------------------------------
  const COMMANDES = ['btnGeo', 'btnFit', 'btnMap', 'btnTiles', 'btnRefresh'];
  const outils = document.createElement('div');
  outils.className = 'map-tools';
  outils.setAttribute('role', 'group');
  outils.setAttribute('aria-label', 'Commandes de la carte');
  function ranger() {
    const cible = telephone.matches ? outils : entete;
    if (telephone.matches && !outils.isConnected) carte.appendChild(outils);
    for (const id of COMMANDES) { const b = $(id); if (b && b.parentElement !== cible) cible.appendChild(b); }
    if (!telephone.matches) outils.remove();
  }
  telephone.addEventListener('change', ranger);
  ranger();

  // --- la feuille ---------------------------------------------------------------------
  const ouverte = () => feuille.classList.contains('open');
  const dire = () => poignee.setAttribute('aria-expanded', String(ouverte()));
  new MutationObserver(dire).observe(feuille, { attributes: true, attributeFilter: ['class'] });
  dire();

  // Tirer la poignée : vers le haut pour ouvrir, vers le bas pour fermer. Un simple
  // appui garde son effet (app.js bascule) ; après un glissement, on l'annule.
  let depart = null, glisse = false;
  poignee.addEventListener('touchstart', (e) => { depart = e.touches[0].clientY; glisse = false; }, { passive: true });
  poignee.addEventListener('touchmove', (e) => {
    if (depart == null) return;
    const dy = e.touches[0].clientY - depart;
    if (Math.abs(dy) < 24) return;
    glisse = true;
    feuille.classList.toggle('open', dy < 0);
    depart = e.touches[0].clientY;
  }, { passive: true });
  poignee.addEventListener('touchend', () => { depart = null; });
  poignee.addEventListener('click', (e) => { if (glisse) { glisse = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);

  // Une fiche qui s'ouvre sur la carte (véhicule, arrêt, lieu, inventaire) serait
  // cachée par la feuille : celle-ci s'efface. Seul le PASSAGE de fermé à ouvert
  // compte, sinon chaque rafraîchissement de la fiche refermerait la feuille.
  for (const id of ['detail', 'inventory', 'cityDetail']) {
    const fiche = $(id);
    if (!fiche) continue;
    let visible = !fiche.classList.contains('hidden');
    new MutationObserver(() => {
      const maintenant = !fiche.classList.contains('hidden');
      if (maintenant && !visible && telephone.matches) feuille.classList.remove('open');
      visible = maintenant;
    }).observe(fiche, { attributes: true, attributeFilter: ['class'] });
  }

  // --- fiche d'un lieu : une icône devant chaque action -------------------------------
  // city.js crée ces boutons avec leur seul libellé (et le réécrit quand on
  // enregistre un favori) : on pose l'icône après coup, à chaque changement.
  const ficheLieu = $('cityDetail');
  if (ficheLieu && window.Art) {
    const ICONES = [['#cityFavorite', (e) => (/retirer/i.test(e.textContent) ? 'star_on' : 'star')], ['#cityWalk', () => 'walk'], ['#cityTourAdd', () => 'route'], ['#cityJourney', () => 'bus'], ['a[href^="tel:"]', () => 'phone']];
    const decorer = () => {
      for (const [selecteur, nom] of ICONES) {
        const e = ficheLieu.querySelector(selecteur);
        if (!e || e.querySelector('.ic')) continue;
        const texte = e.textContent.replace(/^[☆★]\s*/, '');
        e.textContent = texte;
        e.insertAdjacentHTML('afterbegin', window.Art.icon(nom(e)));
      }
    };
    new MutationObserver(decorer).observe(ficheLieu, { childList: true, subtree: true, characterData: true });
    decorer();
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && telephone.matches && ouverte()) { feuille.classList.remove('open'); poignee.focus(); } });
})();
