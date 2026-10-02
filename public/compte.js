// Compte — trajets enregistrés et planifiés, partages avec les amis, assistants.
// ---------------------------------------------------------------
// Script classique, comme app.js, mais ENFERMÉ dans une fonction : les scripts
// classiques d'une page partagent leur portée, et un `const` qui porterait le
// même nom qu'un autre fichier empêcherait TOUT ce fichier de s'exécuter.
//
// Il s'appuie sur ce que app.js expose déjà : `$`, `toast`, `escapeHtml`, la
// carte (`map`), et l'itinéraire affiché (`journey`, `renderJourney`). Un
// trajet enregistré se calcule donc par le MÊME chemin qu'un trajet tapé à la
// main, et se dessine pareil.
//
// Rien n'est gardé dans le navigateur : la session est un cookie que le script
// ne peut pas lire, et les trajets vivent sur le serveur. Seule exception :
// l'identifiant du partage de position que CET onglet alimente (sessionStorage),
// pour le reprendre après un rechargement.
// ---------------------------------------------------------------
(() => {
  'use strict';
  const racine = document.getElementById('compte');
  const corps = document.getElementById('compteCorps');
  if (!racine || !corps) return;
  const h = (s) => escapeHtml(String(s ?? ''));
  const params = new URLSearchParams(location.search);

  const etat = {
    connecte: null,          // null = on ne sait pas encore
    compte: null, trajets: [], planifies: [], partages: { envoyes: [], recus: [] },
    horairesJusquau: null,
    amis: null, amisErreur: null,
    assistants: null, adresseMcp: null,
    formulaire: null,        // { genre: 'planifier' | 'partager' | 'position', ... }
    calculs: new Map(),      // id de trajet planifié -> résultat ou { erreur }
    occupe: false,
  };

  // --- serveur ------------------------------------------------------------------
  async function api(methode, chemin, donnees) {
    let res;
    try {
      res = await fetch(`/api/compte${chemin}`, {
        method: methode, credentials: 'same-origin',
        headers: donnees ? { 'Content-Type': 'application/json' } : {},
        body: donnees ? JSON.stringify(donnees) : undefined,
      });
    } catch {
      return { ok: false, statut: 0, erreur: 'Connexion au serveur impossible.' };
    }
    let json = null;
    try { json = await res.json(); } catch { /* réponse vide */ }
    if (res.status === 401 && json?.code === 'CONNEXION') { etat.connecte = false; rendre(); }
    return { ok: res.ok, statut: res.status, json, erreur: res.ok ? null : (json?.error || `Erreur ${res.status}`), code: json?.code };
  }

  async function charger() {
    const r = await api('GET', '');
    if (!r.ok) { etat.connecte = false; etat.panne = r.erreur; rendre(); return; }
    etat.panne = null;
    etat.connecte = Boolean(r.json.connecte);
    if (etat.connecte) {
      etat.compte = r.json.compte;
      etat.trajets = r.json.trajets;
      etat.planifies = r.json.planifies;
      etat.partages = r.json.partages;
      etat.horairesJusquau = r.json.horaires_jusquau;
    }
    rendre();
    apresResultat();
    if (etat.connecte) reprendrePosition();
  }

  // --- textes -------------------------------------------------------------------
  const JOURS = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const fmtQuand = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short' });
  const quand = (t) => fmtQuand.format(new Date(t * 1000));
  const heure = (t) => fmtHeure.format(new Date(t * 1000));
  function rythme(p) {
    const sens = p.mode === 'arriver' ? 'arriver avant' : 'partir à';
    if (p.jours) {
      const j = p.jours.join('') === '12345' ? 'en semaine' : p.jours.length === 7 ? 'tous les jours' : p.jours.map((x) => JOURS[x]).join(', ');
      return `${sens} ${p.heure} · ${j}`;
    }
    const [y, m, d] = p.date.split('-').map(Number);
    return `${sens} ${p.heure} · ${fmtJour.format(new Date(Date.UTC(y, m - 1, d, 12)))}`;
  }
  const age = (s) => (s < 60 ? `il y a ${s} s` : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`);

  // --- dessins ------------------------------------------------------------------
  // Les icônes et illustrations viennent de art.js (les mêmes que l'application
  // Android). Elles sont décoratives : chaque bloc garde son texte.
  const ic = (nom) => (window.Art ? window.Art.icon(nom) : '');
  const ill = (nom) => (window.Art ? window.Art.ill(nom) : '');
  const pastille = (nom, ton = '') => `<span class="cpt-pastille ${ton}">${ic(nom)}</span>`;
  const promesse = (nom, ton, titre, texte) => `<li>${pastille(nom, ton)}<div><b>${titre}</b><span>${texte}</span></div></li>`;
  const vide = (dessin, titre, texte) => `<div class="cpt-vide">${ill(dessin)}<b>${titre}</b><span>${texte}</span></div>`;
  const iconeMode = (mode) => { const m = String(mode || '').toLowerCase(); return m.includes('métro') || m.includes('metro') ? 'metro' : m.includes('tram') ? 'tram' : m.includes('téléo') || m.includes('teleo') ? 'cable' : 'bus'; };
  // La couleur d'une ligne : la liste des lignes que la carte a déjà chargée.
  const ligneConnue = (code) => { try { return (state.routes || []).find((r) => r.short_name === code) || null; } catch { return null; } };

  // --- rendu --------------------------------------------------------------------
  function rendre() {
    const marque = document.getElementById('compteEtat');
    if (marque) marque.textContent = etat.connecte ? etat.compte.pseudo : '';
    if (etat.connecte === null) { corps.innerHTML = '<p class="cpt-note">Chargement…</p>'; return; }
    if (!etat.connecte) {
      const retour = encodeURIComponent(`/?compte=1${params.get('partage') ? `&partage=${encodeURIComponent(params.get('partage'))}` : ''}`);
      corps.innerHTML = `
        ${etat.panne ? `<p class="cpt-alerte">${ic('alert')}${h(etat.panne)}</p>` : ''}
        <div class="cpt-hero">${ill('account')}</div>
        <h3 class="cpt-accroche">Tes trajets te suivent partout</h3>
        <ul class="cpt-promesses">
          ${promesse('bookmark', 'chaud', 'Enregistre tes trajets', 'Ceux que tu fais souvent, recalculés d’un geste.')}
          ${promesse('bell', 'vert', 'Planifie', 'Un jour précis, ou chaque semaine à la même heure.')}
          ${promesse('friends', '', 'Partage avec tes amis', 'Un trajet, ou ta position pour une durée choisie.')}
        </ul>
        <a class="mini on cpt-large" href="/api/auth/connexion?retour=${retour}">${ic('account')}Se connecter avec Atlas</a>
        <p class="cpt-note cpt-ligne-note">${ic('lock')}<span>La connexion se fait chez Atlas : ce site ne voit jamais ton mot de passe.</span></p>
        <p class="cpt-note cpt-ligne-note">${ic('check')}<span>Sans compte, la carte et l’itinéraire restent entièrement utilisables.</span></p>`;
      return;
    }
    corps.innerHTML = `
      <div class="cpt-qui">${pastille('account')}<span>Connecté : <b>${h(etat.compte.pseudo)}</b></span><button class="mini" data-action="deconnexion">${ic('logout')}Se déconnecter</button></div>
      ${vueFormulaire()}
      <div class="rowhead"><h2>${ic('route')}Mes trajets <span>${etat.trajets.length || ''}</span></h2></div>
      ${etat.trajets.length ? `<ul class="cpt-liste">${etat.trajets.map(vueTrajet).join('')}</ul>`
        : vide('empty', 'Aucun trajet enregistré', 'Calcule un itinéraire, puis « Enregistrer ce trajet » : il restera ici.')}
      <div class="rowhead"><h2>${ic('calendar')}Planifiés <span>${etat.planifies.length || ''}</span></h2></div>
      ${etat.planifies.length ? `<ul class="cpt-liste">${etat.planifies.map(vuePlan).join('')}</ul>`
        : vide('plan', 'Rien de planifié', 'Un jour précis, ou chaque semaine à la même heure : planifie depuis un trajet enregistré.')}
      <div class="rowhead"><h2>${ic('friends')}Avec mes amis</h2><button class="mini" data-action="position">${ic('target')}Partager ma position</button></div>
      ${vuePartages()}
      <details class="cpt-plus" id="cptAssistants"><summary>${ic('assistant')}Assistants (ChatGPT, Claude…)</summary><div id="cptAssistantsCorps">${vueAssistants()}</div></details>
      <details class="cpt-plus"><summary>${ic('lock')}Mes données</summary>
        <p class="cpt-note cpt-ligne-note">${ic('devices')}<span>Le serveur garde ton pseudo Atlas, tes trajets enregistrés et planifiés, et tes partages en cours.</span></p>
        <p class="cpt-note cpt-ligne-note">${ic('target')}<span>Les positions partagées ne sont jamais enregistrées : elles restent en mémoire le temps du partage.</span></p>
        <button class="mini cpt-danger" data-action="supprimer-compte">${ic('trash')}Tout effacer et me déconnecter</button>
      </details>`;
  }

  const lieux = (x) => `${h(x.de?.texte ?? 'ici')} → ${h(x.a.texte)}`;
  // Un trajet sans nom choisi s'appelle « départ → arrivée » : inutile de le
  // répéter sur la ligne du dessous.
  const sousTitre = (x) => (x.nom === `${x.de?.texte} → ${x.a.texte}` ? '' : `<div class="cpt-sous">${lieux(x)}</div>`);

  function vueTrajet(t) {
    return `<li class="cpt-item" data-id="${h(t.id)}">
      <div class="cpt-corps-item">${pastille('route')}<div class="cpt-textes">
        <div class="cpt-tete"><b>${h(t.nom)}</b>${t.utilisations ? `<small>${t.utilisations}×</small>` : ''}</div>
        ${sousTitre(t)}</div></div>
      <div class="cpt-actions">
        <button class="mini on" data-action="calculer" data-id="${h(t.id)}">${ic('route')}Calculer</button>
        <button class="mini" data-action="planifier" data-id="${h(t.id)}">${ic('calendar')}Planifier</button>
        <button class="mini" data-action="partager" data-id="${h(t.id)}">${ic('share')}Partager</button>
        <button class="mini cpt-icone" data-action="supprimer-trajet" data-id="${h(t.id)}" title="Supprimer ce trajet" aria-label="Supprimer le trajet ${h(t.nom)}">${ic('trash')}</button>
      </div></li>`;
  }

  function vuePlan(p) {
    const c = etat.calculs.get(p.id);
    return `<li class="cpt-item${p.passe ? ' cpt-passe' : ''}" data-id="${h(p.id)}">
      <div class="cpt-corps-item">${pastille('calendar', 'chaud')}<div class="cpt-textes">
        <div class="cpt-tete"><b>${h(p.nom)}</b><small>${p.passe ? 'passé' : h(quand(p.prochaine))}</small></div>
        <div class="cpt-sous">${lieux(p)}<br>${h(rythme(p))}</div></div></div>
      ${c ? vueCalcul(c) : ''}
      <div class="cpt-actions">
        ${p.passe ? '' : `<button class="mini on" data-action="itineraire" data-id="${h(p.id)}">${ic('route')}${c ? 'Recalculer' : 'Itinéraire'}</button>`}
        <button class="mini" data-action="partager" data-id="${h(p.id)}">${ic('share')}Partager</button>
        <button class="mini cpt-icone" data-action="supprimer-plan" data-id="${h(p.id)}" title="Supprimer ce trajet planifié" aria-label="Supprimer le trajet planifié ${h(p.nom)}">${ic('trash')}</button>
      </div></li>`;
  }

  // L'itinéraire d'un trajet planifié, tel que le serveur le rédige : les
  // heures, chaque étape, et tout ce qu'il faut savoir avant de s'y fier.
  function vueCalcul(c) {
    if (c.attente) return '<div class="cpt-calcul">Calcul en cours…</div>';
    if (c.erreur) return `<div class="cpt-calcul cpt-erreur">${h(c.erreur)}</div>`;
    const i = c.itineraire;
    const alertes = [c.avertissement, ...(i.alertes ?? []), i.attention].filter(Boolean);
    // La consigne rédigée par le serveur reste dans la page, pour un lecteur d'écran :
    // la frise la montre, elle ne la remplace pas.
    const dite = (e) => `<span class="sr-only">${h(e.instruction ?? '')}</span>`;
    const etape = (e) => {
      if (e.type === 'trajet') {
        const r = ligneConnue(e.ligne), couleur = r?.color ?? '64706c', encre = r?.text_color ?? 'ffffff';
        return `<li class="jleg ride" style="--lc:#${h(couleur)}"><span class="jrail" aria-hidden="true"></span><div class="jbody">${dite(e)}
          <div class="jstop"><time>${h(e.depart ?? '')}</time><strong>${h(e.monter_a ?? '')}</strong></div>
          <b><span class="dline" style="background:#${h(couleur)};color:#${h(encre)}">${h(e.ligne)}</span>${ic(iconeMode(e.mode))}<span class="jmode">${e.direction ? `vers ${h(e.direction)}` : h(e.mode ?? '')}${e.duree_min ? ` · ${e.duree_min} min` : ''}</span></b>
          ${e.statut ? `<span class="jtime">${h(e.statut)}</span>` : ''}
          <div class="jstop"><time>${h(e.arrivee ?? '')}</time><strong>${h(e.descendre_a ?? '')}</strong></div></div></li>`;
      }
      if (e.type === 'marche') {
        return `<li class="jleg walk"><span class="jrail" aria-hidden="true"></span><div class="jbody">${dite(e)}<b>${ic('walk')} ${e.duree_min ?? '?'} min à pied</b><span>${h(e.de ?? '')} → ${h(e.vers ?? '')}</span></div></li>`;
      }
      return `<li class="jleg walk"><span class="jrail" aria-hidden="true"></span><div class="jbody"><span>${h(e.instruction ?? '')}</span></div></li>`;
    };
    return `<div class="cpt-calcul">
      <div class="jhead"><b>${i.duree_min} min</b><span>${i.jour ? `${h(i.jour)} · ` : ''}départ ${h(i.partir_a)} → arrivée ${h(i.arriver_a ?? i.arrivee_estimee_non_fiable ?? '?')}${i.correspondances ? ` · ${i.correspondances} correspondance${i.correspondances > 1 ? 's' : ''}` : ''}${i.tarif?.ticket ? ` · ${h(i.tarif.ticket)}` : ''}</span></div>
      ${alertes.map((a) => `<p class="cpt-alerte">${ic('alert')}${h(a)}</p>`).join('')}
      <ol class="jlegs">${(i.etapes ?? []).map(etape).join('')}</ol>
      <p class="cpt-note cpt-ligne-note">${ic('info')}<span>${h(i.fiabilite ?? '')}</span></p></div>`;
  }

  function vuePartages() {
    const { recus, envoyes } = etat.partages;
    if (!recus.length && !envoyes.length) {
      return vide('share', 'Aucun partage en cours', 'Tes amis sont tes contacts Atlas. Partage-leur un trajet ou, pour un temps limité, ta position.');
    }
    const fin = (p) => (p.type === 'position' ? `jusqu’à ${h(heure(p.expire))}` : '');
    const corpsPartage = (p) => {
      if (p.type === 'position') return `Position en direct ${fin(p)}${p.trajet?.a ? `<br>vers ${h(p.trajet.a.texte)}` : ''}`;
      return `${p.trajet.nom ? `<b>${h(p.trajet.nom)}</b><br>` : ''}${lieux(p.trajet)}${p.trajet.heure ? `<br>${h(rythme(p.trajet))}` : ''}`;
    };
    const recu = (p) => `<li class="cpt-item${params.get('partage') === p.id ? ' cpt-vise' : ''}" data-id="${h(p.id)}">
      <div class="cpt-corps-item">${pastille(p.type === 'position' ? 'target' : 'route', 'vert')}<div class="cpt-textes">
      <div class="cpt-tete"><b>${h(p.de.pseudo)}</b><small>${p.type === 'position' ? 'en direct' : 'trajet'}</small></div>
      <div class="cpt-sous">${corpsPartage(p)}${p.message ? `<br><i>« ${h(p.message)} »</i>` : ''}</div></div></div>
      <div class="cpt-actions">
        ${p.type === 'position'
          ? `<button class="mini on" data-action="suivre" data-id="${h(p.id)}">${suivi.id === p.id ? 'Ne plus suivre' : 'Voir sur la carte'}</button>`
          : `<button class="mini on" data-action="voir-partage" data-id="${h(p.id)}">Calculer</button><button class="mini" data-action="garder-partage" data-id="${h(p.id)}">Enregistrer</button>`}
        <button class="mini cpt-icone" data-action="retirer-partage" data-id="${h(p.id)}" title="Retirer de ma liste" aria-label="Retirer ce partage de ma liste">${ic('close')}</button>
      </div></li>`;
    const envoye = (p) => `<li class="cpt-item" data-id="${h(p.id)}">
      <div class="cpt-corps-item">${pastille(p.type === 'position' ? 'target' : 'share', p.type === 'position' ? 'chaud' : '')}<div class="cpt-textes">
      <div class="cpt-tete"><b>→ ${h(p.vers.map((d) => d.pseudo).join(', '))}</b><small>${p.type === 'position' ? 'en direct' : 'trajet'}</small></div>
      <div class="cpt-sous">${corpsPartage(p)}${p.type === 'position' ? `<br>${emission.id === p.id ? `<span id="cptEmission">${h(emission.texte || 'Envoi de la position…')}</span>` : 'Aucune position envoyée depuis cet onglet.'}${p.assistants ? '<br>Lisible par les assistants de ces amis.' : ''}` : ''}</div></div></div>
      <div class="cpt-actions">
        ${p.type === 'position' && emission.id !== p.id ? `<button class="mini on" data-action="reprendre-position" data-id="${h(p.id)}">Envoyer ma position d’ici</button>` : ''}
        <button class="mini${p.type === 'position' ? ' cpt-danger' : ''}" data-action="arreter-partage" data-id="${h(p.id)}">${p.type === 'position' ? 'Arrêter le partage' : 'Ne plus partager'}</button>
      </div></li>`;
    return `${recus.length ? `<h3 class="cpt-titre">Partagé avec moi</h3><ul class="cpt-liste">${recus.map(recu).join('')}</ul>` : ''}
      ${envoyes.length ? `<h3 class="cpt-titre">Ce que je partage</h3><ul class="cpt-liste">${envoyes.map(envoye).join('')}</ul>` : ''}`;
  }

  function vueAssistants() {
    if (etat.assistants === null) return '<p class="cpt-note">Ouvre pour afficher.</p>';
    const liste = etat.assistants.length
      ? `<ul class="cpt-liste">${etat.assistants.map((a) => `<li class="cpt-item">
          <div class="cpt-tete"><b>${h(a.nom)}</b><small>${h(a.hotes.join(', '))}</small></div>
          <div class="cpt-sous">Peut gérer tes trajets${a.portees.includes('amis') ? ' et lire ce que tes amis partagent avec toi' : ''}.</div>
          <div class="cpt-actions"><button class="mini cpt-danger" data-action="retirer-assistant" data-id="${h(a.id)}">Retirer l’accès</button></div></li>`).join('')}</ul>`
      : '<p class="cpt-note">Aucun assistant autorisé.</p>';
    return `<p class="cpt-note">Pour qu’un assistant gère tes trajets, ajoute-lui ce connecteur (MCP) ; il te demandera de te connecter avec Atlas, puis ton accord.</p>
      <div class="cpt-adresse"><code>${h(etat.adresseMcp)}</code><button class="mini" data-action="copier-mcp">Copier</button></div>${liste}`;
  }

  // --- formulaires ------------------------------------------------------------------
  function vueAmis(nom) {
    if (etat.amisErreur) return `<p class="cpt-erreur">${h(etat.amisErreur)}</p>`;
    if (etat.amis === null) return '<p class="cpt-note">Lecture de tes contacts Atlas…</p>';
    if (!etat.amis.length) return `<p class="cpt-note">Tu n’as pas encore de contact Atlas. <a href="${h(etat.gererAmis)}" target="_blank" rel="noopener">Ajouter des contacts ↗</a></p>`;
    return `<div class="cpt-amis">${etat.amis.map((a) => `<label><input type="checkbox" name="${nom}" value="${h(a.id)}"> ${h(a.nom || a.pseudo)}</label>`).join('')}</div>
      <p class="cpt-note"><a href="${h(etat.gererAmis)}" target="_blank" rel="noopener">Gérer mes contacts dans Atlas ↗</a></p>`;
  }

  function vueFormulaire() {
    const f = etat.formulaire;
    if (!f) return '';
    const boutons = (libelle) => `<div class="cpt-actions"><button type="submit" class="mini on" data-action="valider" ${etat.occupe ? 'disabled' : ''}>${libelle}</button><button type="button" class="mini" data-action="annuler">Annuler</button></div>
      ${f.erreur ? `<p class="cpt-erreur" role="alert">${h(f.erreur)}</p>` : ''}`;
    if (f.genre === 'planifier') {
      const demain = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
      return `<form class="cpt-form" id="cptForm"><h3>Planifier « ${h(f.source.nom)} »</h3>
        <div class="cpt-sous">${lieux(f.source)}</div>
        <div class="cpt-ligne"><select name="mode" aria-label="Sens de l’heure"><option value="partir">Partir à</option><option value="arriver">Arriver avant</option></select>
          <input type="time" name="heure" value="08:00" required aria-label="Heure"></div>
        <div class="cpt-ligne"><label><input type="radio" name="rythme" value="date" checked> Un jour</label><input type="date" name="date" value="${demain}" aria-label="Date"></div>
        <div class="cpt-ligne"><label><input type="radio" name="rythme" value="jours"> Chaque</label>
          <span class="cpt-jours">${[1, 2, 3, 4, 5, 6, 7].map((j) => `<label><input type="checkbox" name="jours" value="${j}"${j <= 5 ? ' checked' : ''}>${JOURS[j]}</label>`).join('')}</span></div>
        <p class="cpt-note">L’itinéraire n’est pas figé : il est recalculé quand tu le consultes, avec les horaires et le trafic du moment.</p>
        ${boutons('Planifier')}</form>`;
    }
    if (f.genre === 'partager') {
      return `<form class="cpt-form" id="cptForm"><h3>Partager « ${h(f.source.nom || 'ce trajet')} »</h3>
        <div class="cpt-sous">${lieux(f.source)}${f.source.heure ? `<br>${h(rythme(f.source))}` : ''}</div>
        ${vueAmis('amis')}
        <input type="text" name="message" maxlength="200" placeholder="Un mot pour eux (facultatif)" aria-label="Message">
        <p class="cpt-note">Ils le verront ici pendant 30 jours, et recevront une carte dans Atlas Contacts.</p>
        ${boutons('Partager')}</form>`;
    }
    if (f.genre === 'position') {
      return `<form class="cpt-form" id="cptForm"><h3>Partager ma position</h3>
        ${vueAmis('amis')}
        <div class="cpt-ligne"><label for="cptDuree">Pendant</label><select name="duree" id="cptDuree"><option value="900">15 minutes</option><option value="1800">30 minutes</option><option value="3600" selected>1 heure</option><option value="7200">2 heures</option><option value="14400">4 heures</option></select></div>
        <input type="text" name="destination" maxlength="120" placeholder="Je vais à… (facultatif)" aria-label="Destination">
        <label class="cpt-case"><input type="checkbox" name="assistants"> <span>Autoriser aussi les assistants (ChatGPT, Claude…) de ces amis à lire ma position<small>Décoché : seuls eux la voient, dans Tisséo Live.</small></span></label>
        <p class="cpt-note">Ta position est envoyée tant que cette page reste ouverte, et jamais enregistrée. Le partage s’arrête seul à la fin de la durée, ou dès que tu le coupes.</p>
        ${boutons('Commencer le partage')}</form>`;
    }
    return '';
  }

  async function ouvrirFormulaire(f) {
    etat.formulaire = f;
    rendre();
    document.getElementById('cptForm')?.scrollIntoView({ block: 'nearest' });
    if (f.genre !== 'planifier' && etat.amis === null) {
      const r = await api('GET', '/amis');
      if (r.ok) { etat.amis = r.json.amis; etat.gererAmis = r.json.gerer; etat.amisErreur = null; } else etat.amisErreur = r.erreur;
      if (etat.formulaire === f) rendre();
    }
  }

  async function valider() {
    const f = etat.formulaire;
    const form = document.getElementById('cptForm');
    if (!f || !form || etat.occupe) return;
    const d = new FormData(form);
    const echec = (m) => { f.erreur = m; etat.occupe = false; rendre(); };
    etat.occupe = true;
    if (f.genre === 'planifier') {
      const corpsPlan = { nom: f.source.nom, de: f.source.de, a: f.source.a, heure: d.get('heure'), mode: d.get('mode') };
      if (d.get('rythme') === 'jours') {
        corpsPlan.jours = d.getAll('jours').map(Number);
        if (!corpsPlan.jours.length) return echec('Coche au moins un jour.');
      } else corpsPlan.date = d.get('date');
      const r = await api('POST', '/planifies', corpsPlan);
      if (!r.ok) return echec(r.erreur);
      toast('Trajet planifié.');
    } else {
      const amis = d.getAll('amis');
      if (!amis.length) return echec('Choisis au moins un ami.');
      if (f.genre === 'partager') {
        const s = f.source;
        const r = await api('POST', '/partages', {
          type: 'trajet', amis, message: d.get('message'),
          trajet: { nom: s.nom, de: s.de, a: s.a, ...(s.heure ? { heure: s.heure, mode: s.mode, date: s.date, jours: s.jours } : {}) },
        });
        if (!r.ok) return echec(r.erreur);
        toast(r.json.prevenus ? 'Trajet partagé : tes amis sont prévenus dans Atlas Contacts.' : 'Trajet partagé. Tes amis le verront en ouvrant Tisséo Live.');
      } else {
        if (!navigator.geolocation) return echec('Ce navigateur ne donne pas la position.');
        // On demande la position AVANT de créer le partage : un refus ne doit
        // pas laisser à l'ami un partage qui n'enverra jamais rien.
        let premiere;
        try { premiere = await unePosition(); } catch (e) { return echec(e.message); }
        const dest = String(d.get('destination') || '').trim();
        const r = await api('POST', '/partages', {
          type: 'position', amis, duree_s: Number(d.get('duree')), assistants: d.get('assistants') === 'on',
          ...(dest ? { trajet: { a: dest } } : {}),
        });
        if (!r.ok) return echec(r.erreur);
        emettre(r.json.partage, premiere);
        toast('Position partagée.');
      }
    }
    etat.formulaire = null;
    etat.occupe = false;
    await charger();
  }

  // --- position : émission ------------------------------------------------------------
  const CLE_EMISSION = 'tisseo.partage.position';
  const emission = { id: null, veille: null, dernier: 0, texte: '' };
  function unePosition() {
    return new Promise((ok, ko) => navigator.geolocation.getCurrentPosition(ok, (e) => ko(new Error(
      e.code === 1 ? 'Position refusée : autorise-la pour cette page dans le navigateur.' : 'Position indisponible pour l’instant.')),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }));
  }
  async function envoyerPosition(pos) {
    if (!emission.id) return;
    emission.dernier = Date.now();
    const r = await api('POST', `/partages/${emission.id}/position`, { lat: pos.coords.latitude, lon: pos.coords.longitude, precision_m: pos.coords.accuracy });
    if (r.statut === 410 || r.statut === 404) { arreterEmission(); toast('Le partage de position est terminé.'); charger(); return; }
    emission.texte = r.ok ? `Dernière position envoyée à ${fmtHeure.format(new Date())}.` : `Envoi impossible : ${r.erreur}`;
    // On ne redessine pas tout le panneau toutes les 15 s (un formulaire en
    // cours de saisie y perdrait ses valeurs) : seule la ligne d'état change.
    const ligne = document.getElementById('cptEmission');
    if (ligne) ligne.textContent = emission.texte; else if (!etat.formulaire) rendre();
  }
  function emettre(partage, premiere) {
    arreterEmission();
    emission.id = partage.id;
    try { sessionStorage.setItem(CLE_EMISSION, partage.id); } catch { /* navigation privée */ }
    if (premiere) envoyerPosition(premiere);
    // Une position toutes les 15 s au plus : assez pour suivre quelqu'un à pied
    // ou en bus, sans vider la batterie ni marteler le serveur.
    emission.veille = navigator.geolocation.watchPosition(
      (pos) => { if (Date.now() - emission.dernier >= 15000) envoyerPosition(pos); },
      () => { emission.texte = 'Position momentanément indisponible.'; },
      { enableHighAccuracy: true, maximumAge: 10000 },
    );
  }
  function arreterEmission() {
    if (emission.veille != null) navigator.geolocation.clearWatch(emission.veille);
    emission.id = null; emission.veille = null; emission.texte = '';
    try { sessionStorage.removeItem(CLE_EMISSION); } catch { /* */ }
  }
  // Après un rechargement : si cet onglet alimentait un partage encore en cours,
  // il reprend. L'autorisation de position, elle, a déjà été donnée.
  function reprendrePosition() {
    if (emission.id) return;
    let id = null;
    try { id = sessionStorage.getItem(CLE_EMISSION); } catch { /* */ }
    const p = id && etat.partages.envoyes.find((x) => x.id === id && x.type === 'position');
    if (p && navigator.geolocation) { emettre(p, null); rendre(); } else if (id) { try { sessionStorage.removeItem(CLE_EMISSION); } catch { /* */ } }
  }
  // La page se ferme : le partage qu'elle alimentait n'a plus de source. On
  // l'arrête, plutôt que de laisser l'ami regarder une position qui ne bouge plus.
  window.addEventListener('pagehide', (e) => {
    if (emission.id && !e.persisted) navigator.sendBeacon?.(`/api/compte/partages/${emission.id}/arreter`);
  });

  // --- position : suivi d'un ami ------------------------------------------------------
  const suivi = { id: null, calque: null, minuterie: null };
  function arreterSuivi() {
    clearInterval(suivi.minuterie);
    if (suivi.calque) suivi.calque.remove();
    suivi.id = null; suivi.calque = null; suivi.minuterie = null;
  }
  async function rafraichirSuivi(centrer) {
    if (!suivi.id) return;
    const r = await api('GET', `/partages/${suivi.id}`);
    if (!r.ok) { arreterSuivi(); if (r.statut === 404) { toast('Ce partage de position est terminé.'); charger(); } return; }
    const p = r.json.partage;
    suivi.calque.clearLayers();
    if (!p.position) { toast(`${p.de.pseudo} n’a pas encore envoyé de position.`); return; }
    const { lat, lon, precision_m: prec, age_s: ageS, fraiche } = p.position;
    // Une position ancienne est dessinée éteinte : la personne n'y est
    // peut-être plus, et la carte ne doit pas le laisser croire.
    const couleur = fraiche ? '#37c978' : '#93a1b0';
    if (prec && prec > 15) L.circle([lat, lon], { radius: prec, color: couleur, weight: 1, fillOpacity: .12, interactive: false }).addTo(suivi.calque);
    L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: couleur, fillOpacity: 1, className: 'cpt-ami' })
      .bindTooltip(`${h(p.de.pseudo)} · ${age(ageS)}${fraiche ? '' : ' (ancienne)'}`, { permanent: true, direction: 'top', className: 'bus-tip' })
      .addTo(suivi.calque);
    if (centrer) {
      // `flyTo` calcule une trajectoire à partir de la taille de la carte : sur
      // une carte sans dimensions (panneau replié par-dessus, onglet pas encore
      // dessiné) il lève « Invalid LatLng (NaN, NaN) » et le suivi s'arrêterait
      // là. Dans ce cas on se place directement.
      const zoom = Math.max(map.getZoom(), 15);
      try {
        if (map.getSize().x > 0 && map.getSize().y > 0) map.flyTo([lat, lon], zoom, { duration: 0.7 });
        else map.setView([lat, lon], zoom, { animate: false });
      } catch { map.setView([lat, lon], zoom, { animate: false }); }
    }
  }
  function suivre(id) {
    const deja = suivi.id === id;
    arreterSuivi();
    if (deja) { rendre(); return; }
    suivi.id = id;
    suivi.calque = L.layerGroup().addTo(map);
    suivi.minuterie = setInterval(() => rafraichirSuivi(false), 10000);
    rafraichirSuivi(true);
    rendre();
  }

  // --- calcul sur la carte ---------------------------------------------------------------
  /** Calcule entre deux lieux enregistrés et l'affiche comme un itinéraire tapé à la main. */
  async function calculerSurCarte(de, a) {
    const q = new URLSearchParams();
    for (const [cote, l] of [['from', de], ['to', a]]) {
      // Un arrêt : son nom, que le serveur regroupe en station (tous les quais).
      // Une adresse, un point : ses coordonnées, qu'on ne veut pas re-deviner.
      if (!l.stop_id && l.lat != null) { q.set(`${cote}_lat`, l.lat); q.set(`${cote}_lon`, l.lon); q.set(`${cote}_label`, l.texte); }
      else q.set(cote, l.texte);
    }
    $('jFrom').value = de.texte; $('jTo').value = a.texte;
    $('planner').open = true;
    setHtml($('jResults'), '<div class="jerr">Calcul en cours…</div>');
    $('planner').scrollIntoView({ block: 'nearest' });
    try {
      // Même affichage qu'un itinéraire tapé à la main : étapes et trajet entier sur la carte.
      showJourney(await (await fetch(`/api/journey?${q}`)).json());
    } catch (e) {
      journey = { error: `Calcul indisponible (${e.message})` };
      renderJourney();
    }
  }

  // --- après un calcul : enregistrer, planifier, partager -------------------------------
  // Le résultat d'itinéraire est redessiné par app.js ; on y ajoute nos boutons
  // à chaque fois, sans toucher à son rendu.
  function apresResultat() {
    const boite = $('jResults');
    if (!boite || boite.querySelector('.cpt-apres') || !boite.querySelector('.jhead')) return;
    const de = $('jFrom').value.trim(), a = $('jTo').value.trim();
    if (!de || !a) return;
    const zone = document.createElement('div');
    zone.className = 'cpt-apres';
    zone.innerHTML = etat.connecte
      ? `<button class="mini" data-apres="enregistrer">${ic('bookmark')}Enregistrer ce trajet</button><button class="mini" data-apres="planifier">${ic('calendar')}Planifier</button><button class="mini" data-apres="partager">${ic('share')}Partager</button>`
      : `<a class="mini" href="/api/auth/connexion?retour=${encodeURIComponent('/?compte=1')}">${ic('account')}Se connecter pour enregistrer ce trajet</a>`;
    boite.appendChild(zone);
  }
  new MutationObserver(apresResultat).observe($('jResults'), { childList: true });
  $('jResults').addEventListener('click', async (e) => {
    const quoi = e.target.closest('[data-apres]')?.dataset.apres;
    if (!quoi) return;
    // Le serveur résout les deux lieux tels qu'ils ont été tapés, et rend les
    // noms sous lesquels il les a compris.
    const r = await api('POST', '/trajets', { de: $('jFrom').value.trim(), a: $('jTo').value.trim() });
    if (!r.ok) { toast(r.erreur); return; }
    await charger();
    racine.open = true;
    if (quoi === 'enregistrer') {
      toast(r.json.trajet.deja ? 'Ce trajet était déjà enregistré.' : `Trajet enregistré : ${r.json.trajet.nom}.`);
      racine.scrollIntoView({ block: 'nearest' });
    } else ouvrirFormulaire({ genre: quoi, source: r.json.trajet });
  });

  // --- gestes ----------------------------------------------------------------------------
  const parId = (liste, id) => liste.find((x) => x.id === id);
  corps.addEventListener('submit', (e) => { e.preventDefault(); valider(); });
  corps.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const { action, id } = b.dataset;
    if (action === 'valider') { e.preventDefault(); return valider(); }
    if (action === 'annuler') { etat.formulaire = null; rendre(); return; }
    if (action === 'deconnexion') {
      arreterEmission(); arreterSuivi();
      await fetch('/api/auth/deconnexion', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      etat.amis = null; etat.assistants = null;
      return charger();
    }
    if (action === 'calculer') {
      const t = parId(etat.trajets, id);
      if (!t) return;
      api('POST', `/trajets/${id}/utilise`, {}).then(charger);
      return calculerSurCarte(t.de, t.a);
    }
    if (action === 'planifier') { const t = parId(etat.trajets, id); return t && ouvrirFormulaire({ genre: 'planifier', source: t }); }
    if (action === 'partager') { const s = parId(etat.trajets, id) ?? parId(etat.planifies, id); return s && ouvrirFormulaire({ genre: 'partager', source: s }); }
    if (action === 'position') return ouvrirFormulaire({ genre: 'position' });
    if (action === 'supprimer-trajet' || action === 'supprimer-plan') {
      const plan = action === 'supprimer-plan';
      const x = parId(plan ? etat.planifies : etat.trajets, id);
      if (!x || !confirm(`Supprimer « ${x.nom} » ?`)) return;
      const r = await api('DELETE', `/${plan ? 'planifies' : 'trajets'}/${id}`);
      if (!r.ok) toast(r.erreur);
      return charger();
    }
    if (action === 'itineraire') {
      etat.calculs.set(id, { attente: true }); rendre();
      const r = await api('GET', `/planifies/${id}/calcul`);
      etat.calculs.set(id, r.ok ? r.json : { erreur: r.erreur });
      return rendre();
    }
    if (action === 'voir-partage') { const p = parId(etat.partages.recus, id); return p?.trajet?.de && calculerSurCarte(p.trajet.de, p.trajet.a); }
    if (action === 'garder-partage') {
      const r = await api('POST', `/partages/${id}/enregistrer`, {});
      toast(r.ok ? (r.json.planifie ? 'Trajet enregistré et planifié chez toi.' : 'Trajet enregistré chez toi.') : r.erreur);
      return charger();
    }
    if (action === 'suivre') return suivre(id);
    if (action === 'reprendre-position') {
      const p = parId(etat.partages.envoyes, id);
      if (!p) return;
      try { emettre(p, await unePosition()); } catch (err) { toast(err.message); }
      return rendre();
    }
    if (action === 'retirer-partage' || action === 'arreter-partage') {
      if (suivi.id === id) arreterSuivi();
      if (emission.id === id) arreterEmission();
      const r = await api('DELETE', `/partages/${id}`);
      if (!r.ok && r.statut !== 404) toast(r.erreur);
      return charger();
    }
    if (action === 'copier-mcp') {
      try { await navigator.clipboard.writeText(etat.adresseMcp); toast('Adresse du connecteur copiée.'); } catch { toast(etat.adresseMcp); }
      return;
    }
    if (action === 'retirer-assistant') {
      if (!confirm('Retirer l’accès de cet assistant ? Il ne pourra plus lire ni modifier tes trajets.')) return;
      await api('DELETE', `/assistants/${id}`);
      return chargerAssistants();
    }
    if (action === 'supprimer-compte') {
      if (!confirm('Effacer tes trajets, tes trajets planifiés, tes partages et les accès des assistants ? Ton compte Atlas, lui, n’est pas touché.')) return;
      arreterEmission(); arreterSuivi();
      const r = await api('DELETE', '');
      toast(r.ok ? 'Tes données Tisséo Live sont effacées.' : r.erreur);
      etat.amis = null; etat.assistants = null;
      return charger();
    }
  });

  async function chargerAssistants() {
    const r = await api('GET', '/assistants');
    if (r.ok) { etat.assistants = r.json.assistants; etat.adresseMcp = r.json.adresse; }
    const zone = document.getElementById('cptAssistantsCorps');
    if (zone) zone.innerHTML = r.ok ? vueAssistants() : `<p class="cpt-erreur">${h(r.erreur)}</p>`;
  }
  corps.addEventListener('toggle', (e) => {
    if (e.target.id === 'cptAssistants' && e.target.open && etat.assistants === null) chargerAssistants();
  }, true);

  // Un lien « ?compte=1 » ou « ?partage=… » ouvre le panneau directement.
  if (params.has('compte') || params.has('partage')) {
    racine.open = true;
    // Le panneau vit côté Transports : si la page s'est rouverte en mode Ville,
    // il serait ouvert mais invisible.
    if (!document.getElementById('cityPanel')?.classList.contains('hidden')) document.getElementById('viewTransport')?.click();
    document.getElementById('sidebar')?.classList.add('open');
  }
  // On relit les partages quand on revient sur l'onglet : un ami a pu en créer un.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && etat.connecte && !etat.formulaire) charger(); });
  charger();
})();
