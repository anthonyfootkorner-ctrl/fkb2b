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
           ventesCle: (q7 * 2 + q30) * facteurSaison + (rangSaison >= 0 && rangSaison <= 1 ? 5 : 0),
           facteurSaison, stockTotal: st.stockTotal };
}

// --- compatibilité de deux produits pour former un duo ---
function compatibilite(a, b) {
  const pa = a.produit, pb = b.produit, types = [];
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
  return { types, poids: types.length ? 8 - Math.min(types.length, 4) * 0 + (types.includes("MEME_CATEGORIE") ? 4 : 0)
    + (types.includes("MEME_UNIVERS") ? 3 : 0) + (types.includes("MEME_MARQUE") ? 2 : 0)
    + (types.includes("MEME_MODELE_COLORIS") ? 2 : 0) + (types.includes("PRODUITS_COMPLEMENTAIRES") ? 2 : 0)
    + (types.includes("COHERENCE_VISUELLE") ? 1 : 0) - 8 : 0, doublon };
}

function raisonDuo(a, b, types) {
  const morceaux = [];
  if (types.includes("MEME_MODELE_COLORIS")) morceaux.push("deux coloris du même modèle");
  else if (types.includes("MEME_CATEGORIE")) morceaux.push(`deux ${(a.produit.famille || "produits").toLowerCase()}`);
  if (types.includes("MEME_MARQUE")) morceaux.push(a.produit.marque);
  if (types.includes("PRODUITS_COMPLEMENTAIRES")) morceaux.push("tenue haut + bas");
  if (types.includes("COHERENCE_VISUELLE")) morceaux.push("couleurs assorties");
  if (!morceaux.length) morceaux.push("meilleurs scores restants");
  return morceaux.join(" · ") + ` — scores ${a.score} et ${b.score}.`;
}

// --- classement complet : scores, rotation, duos ---
function classementAutomatique(produits, ventes) {
  let notes = produits.map(p => scorerProduit(p, ventes)).filter(Boolean);
  // hiérarchie : 0) produits sains avant produits dégradés (mono-taille, presque épuisés…),
  // 1) taux de tailles cœur (tranches de 10 %), 2) ventes pondérées, 3) stock total
  notes.sort((x, y) => ((x.degrade ? 1 : 0) - (y.degrade ? 1 : 0))
    || (y.bandeCoeur - x.bandeCoeur)
    || (y.ventesCle - x.ventesCle)
    || (y.stockTotal - x.stockTotal));

  // duos
  const duos = [];
  const restants = [...notes];
  let marquesConsecutives = [];
  while (restants.length) {
    const a = restants.shift();
    if (!restants.length) {
      duos.push({ seul: a });
      break;
    }
    let meilleur = null, meilleurPoids = -1;
    const memeMarqueBloquee = marquesConsecutives.length >= 2 &&
      marquesConsecutives.every(m => m === a.produit.marque);
    for (const b of restants.slice(0, 40)) {
      const c = compatibilite(a, b);
      if (c.doublon) continue;
      // spec : jamais un produit presque épuisé/dégradé en partenaire d'un produit sain
      if (!a.degrade && b.degrade) continue;
      if (memeMarqueBloquee && b.produit.marque === a.produit.marque && c.types.length <= 1) continue;
      // jamais remonter un mauvais produit juste pour compléter : compatibilité pondérée par le score
      const poids = c.poids * 10 + b.score;
      if (poids > meilleurPoids) { meilleurPoids = poids; meilleur = { b, c }; }
    }
    if (!meilleur) {
      const secours = restants.find(b => a.degrade || !b.degrade) || restants[0];
      meilleur = { b: secours, c: { types: [], doublon: false } };
    }
    restants.splice(restants.indexOf(meilleur.b), 1);
    const types = meilleur.c.types.length ? meilleur.c.types : ["DUO_PAR_DEFAUT"];
    duos.push({ a, b: meilleur.b, types });
    marquesConsecutives.push(a.produit.marque);
    if (marquesConsecutives.length > 2) marquesConsecutives.shift();
  }

  // rapport JSON conforme à la spécification
  const rapport = [];
  let pos = 1;
  for (let i = 0; i < duos.length; i++) {
    const d = duos[i];
    if (d.seul) {
      rapport.push({ duo: i + 1, position_produit_1: pos, identifiant_produit_1: d.seul.reference,
        score_produit_1: d.seul.score, statut_produit_1: d.seul.statut,
        position_produit_2: null, identifiant_produit_2: null, score_produit_2: null, statut_produit_2: null,
        score_duo: d.seul.score, types_rapprochement: ["DUO_PAR_DEFAUT"],
        raison_duo: "produit restant (nombre impair)", alerte: d.seul.alertes.join(" ; ") || null });
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
