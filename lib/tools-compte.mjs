// Outils MCP du COMPTE — ce qu'un assistant autorisé peut faire au nom de
// quelqu'un : ses trajets enregistrés, ses trajets planifiés, ses partages.
// ---------------------------------------------------------------
// Chaque outil porte une `portee`. Il n'apparaît dans la liste d'un assistant,
// et n'est exécutable par lui, que si la personne lui a accordé cette portée
// sur l'écran d'accord (lib/oauth.mjs).
//
// Le second argument du handler est l'assistant identifié :
//   { uid, pseudo, portees, client: { nom, hotes } }
//
// Les outils qui ÉCRIVENT le disent (`readOnlyHint: false`) : le client peut
// alors demander confirmation avant d'agir. Aucun n'est marqué « destructeur »
// sauf les suppressions.
//
// CE QU'UN ASSISTANT NE PEUT PAS FAIRE, même autorisé :
//   • partager la position de la personne — il faut un appareil et un geste ;
//   • lire la position d'un ami qui ne l'a pas permis aux assistants ;
//   • autoriser un autre assistant, ou supprimer le compte.
// ---------------------------------------------------------------
import { ToolError } from './mcp.mjs';
import { Refus, dateParis, heureParis } from './account.mjs';

const LECTURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ECRITURE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SUPPRESSION = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const JOURS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const JOURS_ABREGES = { lun: 1, lundi: 1, mar: 2, mardi: 2, mer: 3, mercredi: 3, jeu: 4, jeudi: 4, ven: 5, vendredi: 5, sam: 6, samedi: 6, dim: 7, dimanche: 7 };
const sansAccent = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** « lundi, mercredi », « semaine », « week-end », [1,3] → [1,3]. Rend null si rien d'utilisable. */
export function lireJours(v) {
  if (v == null || v === '') return null;
  const morceaux = Array.isArray(v) ? v : String(v).split(/[,;/]|\bet\b/);
  const out = new Set();
  for (const brut of morceaux) {
    if (typeof brut === 'number') { if (brut >= 1 && brut <= 7) out.add(brut); continue; }
    const m = sansAccent(brut);
    if (!m) continue;
    if (/^[1-7]$/.test(m)) { out.add(+m); continue; }
    if (/(tous les jours|chaque jour|quotidien)/.test(m)) { for (let i = 1; i <= 7; i++) out.add(i); continue; }
    if (/(semaine|ouvr)/.test(m) && !/week/.test(m)) { for (let i = 1; i <= 5; i++) out.add(i); continue; }
    if (/week-?end/.test(m)) { out.add(6); out.add(7); continue; }
    // Le nom entier (au pluriel éventuel) ou l'abréviation de trois lettres —
    // pas « tout ce qui commence pareil » : « lundredi » n'est pas lundi.
    const cle = m.replace(/\.$/, '');
    const j = JOURS_ABREGES[cle] ?? (cle.length > 4 ? JOURS_ABREGES[cle.replace(/s$/, '')] : undefined);
    if (!j) throw new ToolError(`Jour non compris : « ${brut} ». Attendu : lundi … dimanche, « semaine », « week-end » ou « tous les jours ».`);
    out.add(j);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

export function createAccountTools({ accounts, compte, publicUrl = 'https://tisseo.plagnito.com', now = () => Math.floor(Date.now() / 1000) }) {
  const BASE = String(publicUrl).replace(/\/+$/, '');
  const tools = [];

  // Un refus métier devient une erreur d'OUTIL : le modèle la lit et peut
  // corriger son appel ou l'expliquer.
  const garde = (fn) => async (args, ctx) => {
    if (!ctx?.uid) throw new ToolError('Outil réservé à un assistant connecté à un compte.');
    try { return await fn(args, ctx); } catch (e) {
      if (e instanceof Refus) throw new ToolError(e.message);
      throw e;
    }
  };

  const quand = (t) => (t ? `${dateParis(t)} ${heureParis(t)}` : null);
  const lieu = (l) => (l ? { nom: l.texte, ...(l.stop_id ? { arret_id: l.stop_id } : {}), ...(l.lat != null ? { lat: l.lat, lon: l.lon } : {}) } : null);
  const vueTrajet = (t) => ({ id: t.id, nom: t.nom, depart: lieu(t.de), arrivee: lieu(t.a), utilisations: t.utilisations, derniere_utilisation: quand(t.dernier) });
  const repetition = (p) => (p.jours ? `chaque ${p.jours.map((j) => JOURS[j]).join(', ')}` : `le ${p.date}`);
  const vuePlan = (p) => ({
    id: p.id, nom: p.nom, depart: lieu(p.de), arrivee: lieu(p.a),
    quand: `${p.mode === 'arriver' ? 'arriver avant' : 'partir à'} ${p.heure}, ${repetition(p)}`,
    mode: p.mode, heure: p.heure, ...(p.date ? { date: p.date } : { jours: p.jours.map((j) => JOURS[j]) }),
    prochaine_fois: p.passe ? null : quand(p.prochaine),
    ...(p.passe ? { etat: 'passé' } : {}),
    ...(p.rappel_min != null ? { rappel_min: p.rappel_min } : {}),
  });

  /** Retrouve un élément par son identifiant ou par son nom, sans deviner en cas de doute. */
  function designer(liste, ref, quoi) {
    const r = String(ref ?? '').trim();
    if (!r) throw new ToolError(`Indique ${quoi} (identifiant ou nom).`);
    const parId = liste.find((x) => x.id === r);
    if (parId) return parId;
    const n = sansAccent(r);
    const exacts = liste.filter((x) => sansAccent(x.nom) === n);
    const hits = exacts.length ? exacts : liste.filter((x) => sansAccent(x.nom).includes(n));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new ToolError(`Aucun ${quoi.replace(/^(le|la|un|une) /, '')} ne correspond à « ${r} ». Disponibles : ${liste.map((x) => `« ${x.nom} »`).join(', ') || 'aucun'}.`);
    throw new ToolError(`Plusieurs correspondent à « ${r} » : ${hits.map((x) => `« ${x.nom} » (${x.id})`).join(', ')}. Précise avec l'identifiant.`);
  }

  const P = { type: 'string' };
  const o = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

  // ------------------------------------------------------------------ compte
  tools.push({
    name: 'mon_compte', portee: 'tisseo', annotations: LECTURE,
    title: 'Mon compte Tisséo Live',
    description: 'Le compte connecté : pseudo Atlas, nombre de trajets enregistrés et planifiés, partages en cours, et ce que cet assistant est autorisé à faire.',
    inputSchema: o({}),
    handler: garde((args, ctx) => {
      const r = accounts.resume(ctx.uid);
      return {
        pseudo: r.compte.pseudo,
        trajets_enregistres: r.trajets.length,
        trajets_planifies: r.planifies.filter((p) => !p.passe).length,
        partages_envoyes: r.partages.envoyes.length,
        partages_recus: r.partages.recus.length,
        autorisations: ctx.portees,
        acces_amis: ctx.portees.includes('amis') ? 'accordé' : 'non accordé : les outils sur les amis ne sont pas disponibles',
        page: `${BASE}/?compte=1`,
      };
    }),
  });

  // ---------------------------------------------------------- trajets enregistrés
  tools.push({
    name: 'mes_trajets', portee: 'tisseo', annotations: LECTURE,
    title: 'Mes trajets enregistrés',
    description: 'Les trajets que la personne a enregistrés (domicile → travail, etc.), les plus utilisés d\'abord. Donne l\'identifiant à passer à « calculer_mon_trajet ».',
    inputSchema: o({}),
    handler: garde((args, ctx) => {
      const l = accounts.listerTrajets(ctx.uid);
      return { nombre: l.length, trajets: l.map(vueTrajet), ...(l.length ? {} : { note: 'Aucun trajet enregistré. « enregistrer_trajet » en crée un.' }) };
    }),
  });

  tools.push({
    name: 'enregistrer_trajet', portee: 'tisseo', annotations: ECRITURE,
    title: 'Enregistrer un trajet',
    description: 'Enregistre un trajet fréquent dans le compte (départ et arrivée : arrêt, adresse, lieu connu ou "lat,lon"). Les lieux sont vérifiés : un lieu introuvable est refusé, et la réponse dit comment chacun a été compris. Enregistrer deux fois le même trajet ne le duplique pas.',
    inputSchema: o({
      depart: { ...P, description: 'Lieu de départ.' },
      arrivee: { ...P, description: 'Lieu d\'arrivée.' },
      nom: { ...P, description: 'Nom du trajet (ex. « Maison → Travail »). Défaut : « départ → arrivée ».' },
    }, ['depart', 'arrivee']),
    handler: garde(async ({ depart, arrivee, nom }, ctx) => {
      const t = accounts.enregistrerTrajet(ctx.uid, await compte.preparer({ de: depart, a: arrivee, nom }));
      return { ...(t.deja ? { deja_enregistre: true } : { enregistre: true }), trajet: vueTrajet(t) };
    }),
  });

  tools.push({
    name: 'supprimer_trajet', portee: 'tisseo', annotations: SUPPRESSION,
    title: 'Supprimer un trajet enregistré',
    description: 'Supprime un trajet enregistré du compte, désigné par son identifiant ou son nom.',
    inputSchema: o({ trajet: { ...P, description: 'Identifiant (t_…) ou nom du trajet.' } }, ['trajet']),
    handler: garde(({ trajet }, ctx) => {
      const t = designer(accounts.listerTrajets(ctx.uid), trajet, 'le trajet');
      accounts.supprimerTrajet(ctx.uid, t.id);
      return { supprime: true, trajet: t.nom };
    }),
  });

  tools.push({
    name: 'calculer_mon_trajet', portee: 'tisseo', annotations: { ...LECTURE, idempotentHint: false, openWorldHint: true },
    title: 'Calculer un de mes trajets',
    description: 'Calcule l\'itinéraire d\'un trajet enregistré, maintenant ou à une heure donnée (mêmes garanties que « itineraire » : provenance de chaque horaire, correspondances risquées signalées).',
    inputSchema: o({
      trajet: { ...P, description: 'Identifiant (t_…) ou nom du trajet enregistré.' },
      heure_depart: { ...P, description: 'Heure de départ, fuseau de Paris ("08:15" ou "2026-10-05T08:15"). Défaut : maintenant.' },
      arriver_avant: { ...P, description: 'Heure limite d\'arrivée (même format). Exclusif avec heure_depart.' },
    }, ['trajet']),
    handler: garde(async ({ trajet, heure_depart: depart, arriver_avant: arriver }, ctx) => {
      if (depart && arriver) throw new ToolError('Donne soit « heure_depart », soit « arriver_avant », pas les deux.');
      const t = designer(accounts.listerTrajets(ctx.uid), trajet, 'le trajet');
      const r = await compte.calculTrajet(ctx.uid, t.id, { depart: depart || null, arriver: arriver || null });
      return { trajet: t.nom, ...r.itineraire };
    }),
  });

  // ------------------------------------------------------------ trajets planifiés
  tools.push({
    name: 'mes_trajets_planifies', portee: 'tisseo', annotations: LECTURE,
    title: 'Mes trajets planifiés',
    description: 'Les trajets que la personne a planifiés : un jour précis, ou répétés certains jours de la semaine. Le prochain d\'abord, avec la date de sa prochaine occurrence.',
    inputSchema: o({}),
    handler: garde((args, ctx) => {
      const l = accounts.listerPlans(ctx.uid);
      return { nombre: l.length, trajets_planifies: l.map(vuePlan), ...(l.length ? {} : { note: 'Aucun trajet planifié. « planifier_trajet » en crée un.' }) };
    }),
  });

  const champsPlan = {
    heure: { ...P, description: 'Heure au format HH:MM, fuseau de Paris (ex. "08:15").' },
    date: { ...P, description: 'Pour un trajet d\'un seul jour : la date, AAAA-MM-JJ. Exclusif avec « jours ».' },
    jours: { ...P, description: 'Pour un trajet répété : jours séparés par des virgules (« lundi, mardi »), ou « semaine », « week-end », « tous les jours ». Exclusif avec « date ».' },
    mode: { ...P, enum: ['partir', 'arriver'], description: '« partir » : l\'heure est celle du départ (défaut). « arriver » : il faut être arrivé avant cette heure.' },
    nom: { ...P, description: 'Nom du trajet planifié.' },
    rappel_min: { type: 'integer', minimum: 0, maximum: 180, description: 'Rappel sur le téléphone, tant de minutes avant de partir (application Android).' },
  };

  tools.push({
    name: 'planifier_trajet', portee: 'tisseo', annotations: ECRITURE,
    title: 'Planifier un trajet',
    description: 'Planifie un trajet dans le compte : à une date précise, ou répété certains jours de la semaine. Les lieux sont vérifiés. L\'itinéraire n\'est pas figé : il est recalculé à la consultation, avec les horaires et le trafic du moment (« calculer_trajet_planifie »).',
    inputSchema: o({
      depart: { ...P, description: 'Lieu de départ.' },
      arrivee: { ...P, description: 'Lieu d\'arrivée.' },
      ...champsPlan,
    }, ['depart', 'arrivee', 'heure']),
    handler: garde(async ({ depart, arrivee, heure, date, jours, mode, nom, rappel_min: rappel }, ctx) => {
      if (date && jours) throw new ToolError('Donne soit « date », soit « jours », pas les deux.');
      const b = await compte.preparer({ de: depart, a: arrivee, heure, date, jours: lireJours(jours), mode, nom, rappel_min: rappel });
      const p = accounts.planifier(ctx.uid, b);
      return { planifie: true, trajet_planifie: vuePlan(p), ...(p.passe ? { attention: 'Cette date est déjà passée.' } : {}) };
    }),
  });

  tools.push({
    name: 'modifier_trajet_planifie', portee: 'tisseo', annotations: ECRITURE,
    title: 'Modifier un trajet planifié',
    description: 'Change l\'heure, la date, les jours, le mode, le nom ou le rappel d\'un trajet planifié. Seuls les champs fournis changent.',
    inputSchema: o({ trajet: { ...P, description: 'Identifiant (p_…) ou nom du trajet planifié.' }, ...champsPlan }, ['trajet']),
    handler: garde(({ trajet, heure, date, jours, mode, nom, rappel_min: rappel }, ctx) => {
      if (date && jours) throw new ToolError('Donne soit « date », soit « jours », pas les deux.');
      const p = designer(accounts.listerPlans(ctx.uid), trajet, 'le trajet planifié');
      const b = {};
      if (heure !== undefined) b.heure = heure;
      if (date !== undefined) b.date = date;
      if (jours !== undefined) b.jours = lireJours(jours);
      if (mode !== undefined) b.mode = mode;
      if (nom !== undefined) b.nom = nom;
      if (rappel !== undefined) b.rappel_min = rappel;
      if (!Object.keys(b).length) throw new ToolError('Rien à modifier : donne au moins un champ.');
      return { modifie: true, trajet_planifie: vuePlan(accounts.modifierPlan(ctx.uid, p.id, b)) };
    }),
  });

  tools.push({
    name: 'supprimer_trajet_planifie', portee: 'tisseo', annotations: SUPPRESSION,
    title: 'Supprimer un trajet planifié',
    description: 'Supprime un trajet planifié du compte, désigné par son identifiant ou son nom.',
    inputSchema: o({ trajet: { ...P, description: 'Identifiant (p_…) ou nom du trajet planifié.' } }, ['trajet']),
    handler: garde(({ trajet }, ctx) => {
      const p = designer(accounts.listerPlans(ctx.uid), trajet, 'le trajet planifié');
      accounts.supprimerPlan(ctx.uid, p.id);
      return { supprime: true, trajet_planifie: p.nom };
    }),
  });

  tools.push({
    name: 'calculer_trajet_planifie', portee: 'tisseo', annotations: { ...LECTURE, openWorldHint: true },
    title: 'Itinéraire d\'un trajet planifié',
    description: 'Calcule l\'itinéraire d\'un trajet planifié pour sa prochaine occurrence. Si la date dépasse la fenêtre d\'horaires publiée par Tisséo, la réponse le dit dans « avertissement » : l\'itinéraire sera à recalculer.',
    inputSchema: o({ trajet: { ...P, description: 'Identifiant (p_…) ou nom du trajet planifié.' } }, ['trajet']),
    handler: garde(async ({ trajet }, ctx) => {
      const p = designer(accounts.listerPlans(ctx.uid), trajet, 'le trajet planifié');
      const r = await compte.calculPlan(ctx.uid, p.id);
      return { trajet_planifie: vuePlan(r.planifie), ...(r.avertissement ? { avertissement: r.avertissement } : {}), ...r.itineraire };
    }),
  });

  // ------------------------------------------------------------------------ amis
  const vuePartage = (p, sens) => ({
    id: p.id,
    type: p.type === 'position' ? 'position en direct' : 'trajet',
    ...(sens === 'recu' ? { de: p.de.pseudo } : { vers: (p.vers ?? []).map((d) => d.pseudo) }),
    ...(p.message ? { message: p.message } : {}),
    ...(p.trajet ? { trajet: {
      ...(p.trajet.nom ? { nom: p.trajet.nom } : {}),
      ...(p.trajet.de ? { depart: lieu(p.trajet.de) } : {}),
      arrivee: lieu(p.trajet.a),
      ...(p.trajet.heure ? { quand: `${p.trajet.mode === 'arriver' ? 'arriver avant' : 'partir à'} ${p.trajet.heure}, ${repetition(p.trajet)}` } : {}),
    } } : {}),
    ...(p.type === 'position' ? {
      position: p.position ? { lat: p.position.lat, lon: p.position.lon, precision_m: p.position.precision_m, age_s: p.position.age_s, etat: p.position.fraiche ? 'récente' : 'ancienne : la personne a peut-être bougé depuis' } : null,
      ...(p.position_reservee ? { position_non_transmise: p.position_reservee } : {}),
      ...(p.position_attente ? { position_non_transmise: p.position_attente } : {}),
    } : {}),
    jusqu_a: quand(p.expire),
    page: `${BASE}/?partage=${p.id}`,
  });

  tools.push({
    name: 'mes_amis', portee: 'amis', annotations: { ...LECTURE, openWorldHint: true },
    title: 'Mes amis (contacts Atlas)',
    description: 'Les contacts Atlas de la personne : ceux avec qui elle peut partager un trajet. La liste se gère dans Atlas Contacts, pas ici.',
    inputSchema: o({}),
    handler: garde(async (args, ctx) => {
      const l = await compte.amisDe(ctx.uid, { frais: true });
      return { nombre: l.length, amis: l.map((c) => ({ pseudo: c.pseudo, ...(c.nom ? { nom: c.nom } : {}), id: c.id })), gerer: 'https://plagnito.com/contacts' };
    }),
  });

  tools.push({
    name: 'partages_recus', portee: 'amis', annotations: LECTURE,
    title: 'Ce que mes amis partagent avec moi',
    description: 'Les trajets que des amis ont partagés avec la personne, et les positions en direct qu\'ils lui partagent en ce moment. La position d\'un ami n\'est transmise à un assistant que si cet ami l\'a lui-même autorisé : sinon la réponse dit qu\'elle existe mais ne la donne pas.',
    inputSchema: o({}),
    handler: garde((args, ctx) => {
      // La vue « assistant » : c'est elle qui retient une position non permise.
      const recus = accounts.partagesDe(ctx.uid).recus.map((p) => accounts.partage(ctx.uid, p.id, 'assistant'));
      return { heure: heureParis(now()), nombre: recus.length, partages: recus.map((p) => vuePartage(p, 'recu')) };
    }),
  });

  tools.push({
    name: 'mes_partages', portee: 'amis', annotations: LECTURE,
    title: 'Ce que je partage',
    description: 'Les partages en cours de la personne vers ses amis (trajets, position en direct), avec leur fin.',
    inputSchema: o({}),
    handler: garde((args, ctx) => {
      const l = accounts.partagesDe(ctx.uid).envoyes;
      return { nombre: l.length, partages: l.map((p) => vuePartage(p, 'envoye')) };
    }),
  });

  tools.push({
    name: 'partager_trajet', portee: 'amis', annotations: { ...ECRITURE, openWorldHint: true },
    title: 'Partager un trajet avec des amis',
    description: 'Partage un trajet avec un ou plusieurs contacts Atlas : ils le voient dans Tisséo Live et reçoivent une carte dans Atlas Contacts. Donne soit un trajet enregistré ou planifié (« trajet »), soit un départ et une arrivée. Envoie quelque chose à d\'autres personnes au nom de l\'utilisateur : ne le fais que s\'il l\'a demandé, en nommant les destinataires.',
    inputSchema: o({
      amis: { type: 'array', items: { type: 'string' }, description: 'Pseudos (ou identifiants) des contacts Atlas destinataires.' },
      trajet: { ...P, description: 'Identifiant ou nom d\'un trajet enregistré (t_…) ou planifié (p_…).' },
      depart: { ...P, description: 'Lieu de départ, si « trajet » n\'est pas donné.' },
      arrivee: { ...P, description: 'Lieu d\'arrivée, si « trajet » n\'est pas donné.' },
      message: { ...P, description: 'Un mot pour les destinataires (200 caractères au plus).' },
    }, ['amis']),
    handler: garde(async ({ amis, trajet, depart, arrivee, message }, ctx) => {
      const carnet = await compte.amisDe(ctx.uid, { frais: true });
      const ids = [];
      for (const ref of amis ?? []) {
        const r = sansAccent(ref);
        const hits = carnet.filter((c) => c.id === String(ref).trim() || sansAccent(c.pseudo) === r || (c.nom && sansAccent(c.nom) === r));
        if (hits.length !== 1) throw new ToolError(hits.length ? `Plusieurs contacts correspondent à « ${ref} » : précise avec l'identifiant (outil « mes_amis »).` : `« ${ref} » n'est pas dans les contacts Atlas de la personne (outil « mes_amis » pour la liste).`);
        ids.push(hits[0].id);
      }
      if (!ids.length) throw new ToolError('Indique au moins un ami.');
      let corps;
      if (trajet) {
        const tous = [...accounts.listerTrajets(ctx.uid), ...accounts.listerPlans(ctx.uid)];
        const t = designer(tous, trajet, 'le trajet');
        corps = { nom: t.nom, de: t.de, a: t.a, ...(t.heure ? { heure: t.heure, mode: t.mode, date: t.date, jours: t.jours } : {}) };
      } else {
        if (!depart || !arrivee) throw new ToolError('Donne « trajet », ou « depart » et « arrivee ».');
        corps = { de: depart, a: arrivee };
      }
      const r = await compte.creerPartage(ctx.uid, { type: 'trajet', amis: ids, trajet: corps, message });
      return {
        partage: vuePartage(r.partage, 'envoye'),
        prevenus_dans_atlas_contacts: r.prevenus,
        ...(r.annonce ? { note: `Le partage est créé, mais la carte Atlas Contacts n'a pas pu être envoyée (${r.annonce}). Les amis le verront en ouvrant Tisséo Live.` } : {}),
      };
    }),
  });

  tools.push({
    name: 'arreter_partage', portee: 'amis', annotations: SUPPRESSION,
    title: 'Arrêter un partage',
    description: 'Arrête un partage que la personne a créé (ses amis ne le voient plus), ou retire de sa liste un partage reçu.',
    inputSchema: o({ partage: { ...P, description: 'Identifiant du partage (s_…).' } }, ['partage']),
    handler: garde(({ partage }, ctx) => accounts.retirerPartage(ctx.uid, String(partage).trim())),
  });

  return tools;
}

export const INSTRUCTIONS_COMPTE = [
  'Compte connecté : cet assistant agit au nom d\'une personne. « mes_trajets » liste ses trajets enregistrés (les plus utilisés d\'abord) et « calculer_mon_trajet » en calcule un ; « mes_trajets_planifies » / « planifier_trajet » gèrent ses trajets planifiés (un jour précis ou répétés), « calculer_trajet_planifie » donne l\'itinéraire de la prochaine occurrence.',
  'Avant d\'enregistrer, planifier, modifier ou supprimer, assure-toi que la personne l\'a demandé ; redis-lui comment les lieux ont été compris (le nom rendu peut différer de ce qu\'elle a dit).',
  'Amis (si l\'autorisation « amis » a été accordée) : « partages_recus » donne ce que ses contacts Atlas partagent avec elle ; une position marquée « position_non_transmise » ne doit pas être devinée ni estimée. « partager_trajet » envoie un trajet à des amis : uniquement à sa demande, vers des destinataires qu\'elle a nommés. Un assistant ne peut pas partager la position de la personne : cela se fait depuis son téléphone ou la page.',
].join('\n');
