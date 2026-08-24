// Moteur de merchandising automatique — implémente la spécification d'Anthony (docs/SPEC_MOTEUR_MERCH.md).
// Score commercial /100 par pondérations, statuts, pénalités, duos par compatibilité, rotation.
// Données réelles uniquement : les critères indisponibles (vues, conversion…) sont redistribués, jamais inventés.

const TAILLES_COEUR_TEXTILE = new Set(["S", "M", "L"]);

function estChaussure(p) {
  return /CHAUSS|SNEAK|RUNNING/i.test(p.famille || "") ||
         p.tailles.every(t => /^\d/.test(t.taille.trim()));
}

// --- critère tailles (25 pts) : qualité de la grille, pas seulement le stock total ---
function scoreTailles(p) {
  const dispo = p.tailles.filter(t => t.stock > 0);
  const total = p.tailles.length;
  if (!dispo.length) return { pts: 0, rupture: true };
  let pts = 25 * (dispo.length / Math.max(total, 1));           // complétude de la grille

  // tailles cœur : S/M/L en textile ; tiers central de la grille du produit en chaussure
  let coeurs;
  if (estChaussure(p)) {
    const n = p.tailles.length, debut = Math.floor(n / 3), fin = Math.ceil(2 * n / 3);
    coeurs = p.tailles.slice(debut, fin).map(t => t.taille);
  } else {
    coeurs = p.tailles.map(t => t.taille).filter(t => TAILLES_COEUR_TEXTILE.has(t.trim().toUpperCase()));
  }
  const coeursDispo = coeurs.filter(c => dispo.some(t => t.taille === c));
  const sansCoeur = coeurs.length > 0 && coeursDispo.length === 0;
  // taux de tailles cœur : critère de classement n° 1 (en % — 3/4 bat 4/12)
  const tauxCoeur = coeurs.length ? coeursDispo.length / coeurs.length
                                  : dispo.length / Math.max(total, 1);
  if (coeurs.length) pts = pts * 0.55 + 25 * 0.45 * (coeursDispo.length / coeurs.length);

  // équilibre : stock concentré sur une seule taille = pénalisé
  const stockTotal = dispo.reduce((s, t) => s + t.stock, 0);
  const concentration = Math.max(...dispo.map(t => t.stock)) / stockTotal;
  if (dispo.length > 1 && concentration > 0.7) pts *= 0.75;

  return { pts: Math.max(0, Math.min(25, pts)), tauxCoeur,
           tauxGrille: dispo.length / Math.max(total, 1),
           monoTaille: dispo.length === 1, sansCoeur,
           fragmentee: total >= 4 && dispo.length / total < 0.5,
           presqueEpuise: stockTotal <= 3, stockTotal };
}

// --- score complet d'un produit ---
function scorerProduit(p, ventes) {
  const v = ventes?.[p.reference] || {};
  const q7 = Math.max(0, v.qte_7j || 0), q30 = Math.max(0, v.qte_30j || 0);
  const st = scoreTailles(p);
  if (st.rupture) return null; // rupture : exclu du classement

  // critères disponibles : vitesse 30, tailles 25, nouveauté 20, tendance 10.
  // conversion/engagement (10) et marge (5) indisponibles → redistribution proportionnelle (facteur 100/85).
  const REDIST = 100 / 85;

  // vitesse (30) : échelle logarithmique, 7j pèse double
  const vitesse = Math.min(30, (Math.log1p(q7 * 2 + q30 * 0.5) / Math.log1p(60)) * 30);

  // nouveauté (20) : récence de la saison comme approximation de la mise en ligne
  const recences = [...new Set(DATA.produits.map(x => cleRecence(x.saison)))].sort((a, b) => b - a);
  const rangSaison = recences.indexOf(cleRecence(p.saison));
  const estNouveaute = rangSaison >= 0 && rangSaison <= 1;   // deux saisons les plus récentes
  let nouveaute = estNouveaute ? 14 : Math.max(0, 10 - rangSaison * 2);
  let statutNouveaute = null;
  if (estNouveaute) {
    const rythme = q7 * 2 + q30 * 0.3;
    if (rythme >= 8) { nouveaute = 20; statutNouveaute = "NOUVEAUTE_FORT_POTENTIEL"; }
    else if (q30 === 0) { nouveaute = 12; statutNouveaute = "NOUVEAUTE_A_TESTER"; }
    else if (rythme < 2) { nouveaute = 8; statutNouveaute = "NOUVEAUTE_FAIBLE_PERFORMANCE"; }
    else statutNouveaute = "NOUVEAUTE_A_TESTER";
  }

  // tendance (10) : rythme hebdomadaire récent vs moyenne 30 j
  const rythmeRecent = q7, rythmeMoyen = q30 / 4.3;
  let tendance = 5, statutTendance = "PRODUIT_STABLE";
  if (q30 >= 3) {
    if (rythmeRecent > rythmeMoyen * 1.4) { tendance = 10; statutTendance = "PRODUIT_EN_HAUSSE"; }
    else if (rythmeRecent < rythmeMoyen * 0.5) { tendance = 1; statutTendance = "PRODUIT_EN_BAISSE"; }
  }

  // poids de saison : les saisons récentes comptent plein pot, les anciennes (AH21…) très peu
  const facteurSaison = rangSaison < 0 ? 0.5
    : rangSaison <= 1 ? 1.0      // deux saisons les plus récentes (ex. 26 Q3, 26 Q2)
    : rangSaison <= 3 ? 0.85
    : rangSaison <= 6 ? 0.7
    : 0.3;                        // fonds de saison type AH21

  // hiérarchie : 1) % tailles cœur, 2) ventes × fraîcheur de saison, 3) stock total.
  const ptsStock = Math.min(15, (Math.log1p(st.stockTotal) / Math.log1p(500)) * 15);
  let score = st.tauxCoeur * 45 + (vitesse / 30) * 30 * facteurSaison + ptsStock
              + facteurSaison * 10
              + (nouveaute / 20) * 2 + (tendance / 10) * 1;

  // pénalités et statut principal
  const alertes = [];
  let statut = statutNouveaute || statutTendance;
  if (st.monoTaille) { score *= 0.5; statut = "FAIBLE_DISPONIBILITE"; alertes.push("une seule taille disponible"); }
  if (st.sansCoeur) { score *= 0.6; statut = "GRILLE_CASSEE"; alertes.push("aucune taille cœur disponible"); }
  else if (st.fragmentee) { score *= 0.8; if (!statutNouveaute) statut = "GRILLE_CASSEE"; alertes.push("grille fragmentée"); }
  if (st.presqueEpuise) { score *= 0.5; statut = "PRESQUE_EPUISE"; alertes.push("presque épuisé"); }
  if (q30 === 0 && !estNouveaute) { score *= 0.7; statut = "DORMANT"; alertes.push("aucune vente sur 30 j"); }
  if (q7 * 2 + q30 > st.stockTotal * 2) alertes.push("stock possiblement insuffisant pour la demande");
  // spec : une forte remise n'est jamais une preuve de performance — remisé fort ET peu vendu = pénalisé
  if ((p.promo_pct || 0) >= 30 && q30 <= 2) { score *= 0.8; alertes.push(`remise −${p.promo_pct}% sans effet sur les ventes`); }

  if (statut === "PRODUIT_STABLE" && score >= 55 && q30 >= 8) statut = "BEST_SELLER";
  if (score < 15 && !estNouveaute) statut = "A_DECLASSER";
  // un produit qui ne peut plus servir la demande passe derrière tous les produits sains
  const degrade = st.monoTaille || st.presqueEpuise || st.sansCoeur
    || st.stockTotal < q7 || statut === "A_DECLASSER";
  if (degrade && !alertes.length) alertes.push("disponibilité insuffisante");

  return { reference: p.reference, produit: p, score: Math.round(Math.min(100, score)),
           statut, q7, q30, alertes, degrade,
           bandeCoeur: Math.round(st.tauxCoeur * 10),
           tauxCoeurBrut: st.tauxCoeur, tauxGrille: st.tauxGrille,
           ventesCle: (q7 * 2 + q30) * facteurSaison + (rangSaison >= 0 && rangSaison <= 1 ? 5 : 0),
           ventesBrutes: q7 * 2 + q30,
           rangSaison: rangSaison < 0 ? 9 : Math.min(rangSaison, 9),
           promo: p.promo_pct || 0,
           creation: ASSOCIES?.creation?.[p.reference] || "",
           facteurSaison, stockTotal: st.stockTotal };
}

// --- produits associés officiels (métachamps Shopify : complémentaires, cross-sell) ---
let ASSOCIES = null; // { parRef: {ref: [handles]}, refParHandle: {handle: ref} }
async function chargerAssocies() {
  if (ASSOCIES) return ASSOCIES;
  const parRef = {}, refParHandle = {}, creation = {}, partenaires = {};
  try {
    const rows = await apiTout("/rest/v1/photos?select=reference,handle,associes,cree_shopify");
    for (const r of rows) {
      if (r.handle) refParHandle[r.handle] ??= r.reference;
      if (r.associes?.length) parRef[r.reference] ??= r.associes;
      if (r.cree_shopify) creation[r.reference] ??= r.cree_shopify;
    }
    // index bidirectionnel référence ↔ référence : handles résolus une fois pour toutes
    for (const [ref, handles] of Object.entries(parRef)) {
      for (const h of handles) {
        const rb = refParHandle[h];
        if (!rb || rb === ref) continue;
        (partenaires[ref] ??= new Set()).add(rb);
        (partenaires[rb] ??= new Set()).add(ref);
      }
    }
  } catch (e) { /* associations indisponibles : les duos retombent sur les règles internes */ }
  return (ASSOCIES = { parRef, refParHandle, creation, partenaires });
}

function sontAssocies(ra, rb) {
  return !!ASSOCIES?.partenaires?.[ra]?.has(rb);
}

// --- compatibilité de deux produits pour former un duo ---
function compatibilite(a, b) {
  const pa = a.produit, pb = b.produit, types = [];
  // association déclarée dans Shopify (produit complémentaire / cross-sell) : prioritaire
  if (sontAssocies(pa.reference, pb.reference)) types.push("ASSOCIES_SHOPIFY");
  if (pa.famille && pa.famille === pb.famille) types.push("MEME_CATEGORIE");
  const univers = p => (p.sous_famille || p.coloris || "") + " " + (p.designation || "");
  const clubs = /PSG|BARCA|REAL|JUVE|MARSEILLE|OM |LIVERPOOL|ARSENAL|FFF|FOOT/i;
  if (clubs.test(univers(pa)) && clubs.test(univers(pb))) types.push("MEME_UNIVERS");
  if (pa.marque && pa.marque === pb.marque) types.push("MEME_MARQUE");
  if (pa.saison && pa.saison === pb.saison && pa.marque === pb.marque) types.push("MEME_COLLECTION");
  const base = r => (r || "").replace(/-\w+$/, "");
  if (base(pa.reference) === base(pb.reference)) types.push("MEME_MODELE_COLORIS");
  const HAUTS = /TSHIRT|POLO|SWEAT|HOOD|VESTE|MAILLOT|TOP|JKT/i, BAS = /PANT|SHORT|JOGG/i;
  if ((HAUTS.test(pa.famille || "") && BAS.test(pb.famille || "")) ||
      (BAS.test(pa.famille || "") && HAUTS.test(pb.famille || ""))) types.push("PRODUITS_COMPLEMENTAIRES");
  if (pa.couleur && pa.couleur === pb.couleur) types.push("COHERENCE_VISUELLE");
  // quasi-doublon visuel : même modèle ET même couleur = à éviter côte à côte
  const doublon = types.includes("MEME_MODELE_COLORIS") && pa.couleur === pb.couleur;
  return { types, poids: types.length ? 8 - Math.min(types.length, 4) * 0
    + (types.includes("ASSOCIES_SHOPIFY") ? 15 : 0) + (types.includes("MEME_CATEGORIE") ? 4 : 0)
    + (types.includes("MEME_UNIVERS") ? 3 : 0) + (types.includes("MEME_MARQUE") ? 2 : 0)
    + (types.includes("MEME_MODELE_COLORIS") ? 2 : 0) + (types.includes("PRODUITS_COMPLEMENTAIRES") ? 2 : 0)
    + (types.includes("COHERENCE_VISUELLE") ? 1 : 0) - 8 : 0, doublon };
}

function raisonDuo(a, b, types) {
  const morceaux = [];
  if (types.includes("ASSOCIES_SHOPIFY")) morceaux.push("associés sur le site (complémentaire/cross-sell)");
  if (types.includes("MEME_MODELE_COLORIS")) morceaux.push("deux coloris du même modèle");
  else if (types.includes("MEME_CATEGORIE")) morceaux.push(`deux ${(a.produit.famille || "produits").toLowerCase()}`);
  if (types.includes("MEME_MARQUE")) morceaux.push(a.produit.marque);
  if (types.includes("PRODUITS_COMPLEMENTAIRES")) morceaux.push("tenue haut + bas");
  if (types.includes("COHERENCE_VISUELLE")) morceaux.push("couleurs assorties");
  if (!morceaux.length) morceaux.push("meilleurs scores restants");
  return morceaux.join(" · ") + ` — scores ${a.score} et ${b.score}.`;
}

// --- tri sur mesure : jauges d'importance (0 = critère ignoré) ---
// Chaque critère est ramené sur une échelle 0-1 comparable *à l'intérieur de la collection
// travaillée* (rang centile pour les ventes/stock/nouveauté, qui sont très étalés ; ratio
// direct pour les tailles). Le score est la moyenne pondérée : seul le poids RELATIF compte,
// « ventes 7 j 10 / stock 5 » donne le même classement que « 6 / 3 ».
const CRITERES_JAUGES = [
  { cle: "nouveaute", nom: "Nouveauté",     aide: "date de mise en ligne Shopify (à défaut : fraîcheur de la saison)" },
  { cle: "ventes7",   nom: "Ventes 7 j",    aide: "quantités vendues sur les 7 derniers jours" },
  { cle: "ventes30",  nom: "Ventes 30 j",   aide: "quantités vendues sur les 30 derniers jours" },
  { cle: "stock",     nom: "Stock",         aide: "quantité totale disponible (Duhamel)" },
  { cle: "grille",    nom: "Tailles dispo", aide: "tailles en stock ÷ tailles du produit" },
  { cle: "coeur",     nom: "Tailles cœur",  aide: "S/M/L en textile, tiers central de la grille en chaussure" },
  { cle: "promo",     nom: "Promotion",     aide: "% de remise affiché (50 % et plus = maximum)" },
];
const POIDS_DEFAUT = { nouveaute: 5, ventes7: 5, ventes30: 2, stock: 2, grille: 3, coeur: 8, promo: 0 };

// rang centile d'une valeur dans une série (ex æquo = même rang moyen) : 0 = la plus basse,
// 1 = la plus haute. Robuste aux séries très déséquilibrées (beaucoup de zéros de ventes).
function centileur(valeurs) {
  const tries = [...valeurs].sort((a, b) => a - b), n = tries.length;
  return v => {
    if (n <= 1) return 1;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tries[m] < v) lo = m + 1; else hi = m; }
    let lo2 = lo, hi2 = n;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (tries[m] <= v) lo2 = m + 1; else hi2 = m; }
    return ((lo + lo2 - 1) / 2) / (n - 1);
  };
}

// « fraîcheur » d'un produit : date de création Shopify quand on l'a ; sinon la date médiane
// des produits de la même saison (le produit se range au milieu de ses contemporains).
function datesDeReference(notes) {
  const parSaison = {};
  for (const n of notes) {
    const t = n.creation ? Date.parse(n.creation) : NaN;
    if (!isNaN(t)) (parSaison[n.rangSaison] ??= []).push(t);
  }
  const median = {};
  for (const [r, ts] of Object.entries(parSaison)) {
    ts.sort((a, b) => a - b);
    median[r] = ts[Math.floor(ts.length / 2)];
  }
  const connus = Object.values(median);
  const plancher = connus.length ? Math.min(...connus) : 0;
  return n => {
    const t = n.creation ? Date.parse(n.creation) : NaN;
    if (!isNaN(t)) return t;
    // pas de date : médiane de sa saison, à défaut on la place derrière tout le monde
    return median[n.rangSaison] ?? plancher - (n.rangSaison + 1) * 86400000;
  };
}

function appliquerJauges(notes, poids) {
  const p = { ...POIDS_DEFAUT, ...(poids || {}) };
  const total = CRITERES_JAUGES.reduce((s, c) => s + Math.max(0, p[c.cle] || 0), 0);
  if (!notes.length || !total) return false;   // toutes les jauges à zéro : rien à trier
  const dateDe = datesDeReference(notes);
  const cNouv = centileur(notes.map(dateDe));
  const c7 = centileur(notes.map(n => n.q7));
  const c30 = centileur(notes.map(n => n.q30));
  const cStock = centileur(notes.map(n => n.stockTotal));
  for (const n of notes) {
    const v = {
      nouveaute: cNouv(dateDe(n)),
      ventes7: c7(n.q7),
      ventes30: c30(n.q30),
      stock: cStock(n.stockTotal),
      grille: n.tauxGrille ?? 0,
      coeur: n.tauxCoeurBrut ?? 0,
      promo: Math.min(1, (n.promo || 0) / 50),
    };
    n.jauges = v;
    n.scorePerso = CRITERES_JAUGES.reduce((s, c) => s + Math.max(0, p[c.cle] || 0) * v[c.cle], 0) / total;
  }
  return true;
}

// --- classement complet : scores, rotation, duos ---
// Profils de tri : même moteur, priorités différentes. Les dégradés restent toujours en queue.
const PROFILS_TRI = {
  equilibre: (x, y) => (y.bandeCoeur - x.bandeCoeur) || (y.ventesCle - x.ventesCle) || (y.stockTotal - x.stockTotal),
  nouveautes: (x, y) => (x.rangSaison - y.rangSaison) || (y.bandeCoeur - x.bandeCoeur) || (y.ventesCle - x.ventesCle),
  ventes: (x, y) => (y.ventesBrutes - x.ventesBrutes) || (y.bandeCoeur - x.bandeCoeur) || (y.stockTotal - x.stockTotal),
  promotions: (x, y) => (Math.floor(y.promo / 10) - Math.floor(x.promo / 10)) || (y.ventesCle - x.ventesCle) || (y.bandeCoeur - x.bandeCoeur),
  // Tri antho : tailles cœur → date de création (approchée par la saison tant que
  // Created At manque à l'export) → ventes brutes → stock total
  // Tri sur mesure : score pondéré par les jauges, départage par les tailles cœur
  perso: (x, y) => (y.scorePerso - x.scorePerso) || (y.bandeCoeur - x.bandeCoeur),
  antho: (x, y) => (y.bandeCoeur - x.bandeCoeur)
    || (x.creation !== y.creation ? (y.creation > x.creation ? 1 : -1) : (x.rangSaison - y.rangSaison))
    || (y.ventesBrutes - x.ventesBrutes) || (y.stockTotal - x.stockTotal),
};

function classementAutomatique(produits, ventes, profil = "equilibre", decalage = 0, options = {}) {
  let notes = produits.map(p => scorerProduit(p, ventes)).filter(Boolean);
  let cmp = PROFILS_TRI[profil] || PROFILS_TRI.equilibre;
  // tri sur mesure : si toutes les jauges sont à zéro, on retombe sur le profil équilibré
  if (profil === "perso" && !appliquerJauges(notes, options.poids)) cmp = PROFILS_TRI.equilibre;
  const relegue = options.relegueDegrades !== false;
  notes.sort((x, y) => (relegue ? (x.degrade ? 1 : 0) - (y.degrade ? 1 : 0) : 0) || cmp(x, y));
  // le score affiché reflète exactement le rang du tri (n° 1 = 100) : plus jamais de
  // contradiction score/position. Seuls les partenaires de duo peuvent l'entrecouper.
  notes.forEach((n, i) => {
    n.score = Math.max(1, 100 - Math.round((95 * i) / Math.max(notes.length - 1, 1)));
  });

  // appairage
  const duos = [];
  // mode « sans duos » : chaque produit occupe sa propre case, l'ordre est celui du tri
  if (options.duos === false) {
    for (const n of notes) duos.push({ seul: n, simple: true });
    return rendreClassement(duos, produits);
  }
  const restants = [...notes];
  const refsRestantes = new Set(restants.map(n => n.reference));
  let marquesConsecutives = [];
  // grille du site en 2 ou 4 colonnes : un duo doit occuper (impair, pair) — 63-64, pas
  // 62-63. Si la zone figée est impaire, le n° 1 du tri complète seul sa ligne, puis
  // les duos repartent alignés.
  if (decalage % 2 === 1 && restants.length) {
    // de préférence un produit dont l'associé officiel n'est pas présent : on ne casse
    // jamais un binôme pour caler la grille
    let iCale = restants.findIndex(n => {
      const off = ASSOCIES?.partenaires?.[n.reference];
      return !off || ![...off].some(r => refsRestantes.has(r));
    });
    if (iCale < 0) iCale = 0;
    const cale = restants.splice(iCale, 1)[0];
    refsRestantes.delete(cale.reference);
    duos.push({ seul: cale, cale: true });
  }
  while (restants.length) {
    const a = restants.shift();
    refsRestantes.delete(a.reference);
    if (!restants.length) {
      duos.push({ seul: a });
      break;
    }
    let meilleur = null, meilleurPoids = -1;
    // partenaire officiel Shopify : cherché dans TOUTE la collection, pas seulement la
    // fenêtre des 40 suivants — premier trouvé = le mieux classé (restants est trié)
    const officiels = ASSOCIES?.partenaires?.[a.reference];
    if (officiels) {
      for (const b of restants) {
        if (!officiels.has(b.reference)) continue;
        if (!a.degrade && b.degrade) continue;
        const c = compatibilite(a, b);
        if (c.doublon) continue;
        meilleur = { b, c };
        break;
      }
    }
    const memeMarqueBloquee = marquesConsecutives.length >= 2 &&
      marquesConsecutives.every(m => m === a.produit.marque);
    if (!meilleur) for (const b of restants.slice(0, 40)) {
      const c = compatibilite(a, b);
      if (c.doublon) continue;
      // spec : jamais un produit presque épuisé/dégradé en partenaire d'un produit sain
      if (!a.degrade && b.degrade) continue;
      if (memeMarqueBloquee && b.produit.marque === a.produit.marque && c.types.length <= 1) continue;
      // ne pas séparer un binôme officiel : si l'associé Shopify de b est encore dans la
      // collection, b lui est réservé (il fera son duo quand son tour viendra)
      const bOfficiels = ASSOCIES?.partenaires?.[b.reference];
      if (bOfficiels && [...bOfficiels].some(r => refsRestantes.has(r))) continue;
      // jamais remonter un mauvais produit juste pour compléter : compatibilité pondérée par le score
      const poids = c.poids * 10 + b.score;
      if (poids > meilleurPoids) { meilleurPoids = poids; meilleur = { b, c }; }
    }
    if (!meilleur) {
      const secours = restants.find(b => a.degrade || !b.degrade) || restants[0];
      meilleur = { b: secours, c: { types: [], doublon: false } };
    }
    restants.splice(restants.indexOf(meilleur.b), 1);
    refsRestantes.delete(meilleur.b.reference);
    const types = meilleur.c.types.length ? meilleur.c.types : ["DUO_PAR_DEFAUT"];
    duos.push({ a, b: meilleur.b, types });
    marquesConsecutives.push(a.produit.marque);
    if (marquesConsecutives.length > 2) marquesConsecutives.shift();
  }

  return rendreClassement(duos, produits);
}

// --- rapport JSON conforme à la spécification, ordre et scores ---
function rendreClassement(duos, produits) {
  const rapport = [];
  let pos = 1;
  for (let i = 0; i < duos.length; i++) {
    const d = duos[i];
    if (d.seul) {
      rapport.push({ duo: i + 1, position_produit_1: pos, identifiant_produit_1: d.seul.reference,
        score_produit_1: d.seul.score, statut_produit_1: d.seul.statut,
        position_produit_2: null, identifiant_produit_2: null, score_produit_2: null, statut_produit_2: null,
        score_duo: d.seul.score, types_rapprochement: ["DUO_PAR_DEFAUT"],
        raison_duo: d.simple ? "appairage désactivé : classement au score seul"
          : d.cale ? "produit seul : complète la ligne de la zone figée pour caler les duos"
                   : "produit restant (nombre impair)",
        alerte: d.seul.alertes.join(" ; ") || null });
      pos += 1;
      continue;
    }
    rapport.push({ duo: i + 1,
      position_produit_1: pos, identifiant_produit_1: d.a.reference,
      score_produit_1: d.a.score, statut_produit_1: d.a.statut,
      position_produit_2: pos + 1, identifiant_produit_2: d.b.reference,
      score_produit_2: d.b.score, statut_produit_2: d.b.statut,
      score_duo: Math.round((d.a.score + d.b.score) / 2),
      types_rapprochement: d.types,
      raison_duo: raisonDuo(d.a, d.b, d.types),
      alerte: [...d.a.alertes, ...d.b.alertes].join(" ; ") || null });
    pos += 2;
  }
  const ordre = duos.flatMap(d => d.seul ? [d.seul.reference] : [d.a.reference, d.b.reference]);
  const scores = Object.fromEntries(duos.flatMap(d => d.seul ? [[d.seul.reference, d.seul]]
    : [[d.a.reference, d.a], [d.b.reference, d.b]]));
  return { ordre, rapport, scores,
           exclus: produits.length - Object.keys(scores).length };
}
