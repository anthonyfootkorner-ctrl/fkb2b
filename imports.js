// Centre d'import FKB2B — détection, simulation, exécution des fichiers Fastmag.
// Reprend les règles validées par l'audit du 26/07/2026 (moteur Python du POC).

const MODELES_IMPORT = {
  fiches_produits: {
    libelle: "Fiches produits (catalogue complet)",
    sep: ";", encodage: "windows-1252",
    signature: ["Magasin", "Fournisseur", "Reference_Article", "Gencod", "Produit"],
  },
  stock: {
    libelle: "Stock consolidé par magasin",
    sep: ",", encodage: "utf-8",
    signature: ["Code_Origine", "BarCode V2", "Taille", "Total Stock"],
    remplacement_complet: true,
  },
  tarifs: {
    libelle: "Tarifs par famille tarifaire",
    sep: ";", encodage: "utf-8",
    signature: ["BarCode", "Tarif", "Couleur", "Taille", "Prix", "PrixAchat"],
    verifie_references: true, decimale_virgule: true,
  },
  clients: {
    libelle: "Comptes clients",
    sep: ";", encodage: "windows-1252",
    signature: ["CompteClient", "TarifVente", "Client", "AdrLivraison"],
  },
  stock_shopify: {
    // Ce dépôt alimente le stock WEB (Duhamel) qui sert au merch, PAS le stock vendable
    // du catalogue B2B — le libellé disait l'inverse et a prêté à confusion le 21/08.
    libelle: "Stock Shopify — emplacement Duhamel (stock web du merch)",
    sep: ",", encodage: "utf-8",
    signature: ["ID", "Handle", "Variant ID", "Option1 Value", "Inventory Available: Duhamel"],
    remplacement_complet: true,
    remplacement_libelle: "remplace le stock web Duhamel — le catalogue B2B n'est pas touché",
  },
  ventes: {
    libelle: "Ventes quotidiennes (journal VENTE)",
    sep: ",", encodage: "utf-8",
    signature: ["Code_Origine", "BarCode V2", "Jours dans Date", "Total QteVenteRetail"],
  },
};
const RE_REF_VALIDE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;

/* ---- fichier de stock B2B (préparé par Footkorner) ----
   Pas de signature figée : on reconnaît les colonnes par leur intitulé, quelle que
   soit leur orthographe et leur ordre, pour s'adapter au fichier réel. */
const COLONNES_B2B = {
  reference: ["reference", "ref", "references", "reference article", "reference_article",
              "barcode", "barcode v2", "code", "code article", "article", "modele", "sku"],
  taille: ["taille", "tailles", "size", "pointure", "option1 value"],
  quantite: ["quantite", "qte", "qty", "quantity", "stock", "stock b2b", "disponible",
             "dispo", "total stock", "nombre", "nb"],
  precommande: ["precommande", "preco", "precommand", "pre-commande", "illimite", "illimité",
                "infini", "stock infini", "sur commande"],
  // deux emplacements depuis le 25/08/2026 : CENTRAL sert en premier, WEB en dernier recours
  magasin: ["magasin", "depot", "dépôt", "emplacement", "site", "code_origine", "origine"],
  gencod: ["gencod", "ean", "code barre", "code-barres", "codebarre", "barcode", "ean13"],
};
// « CENTRAL » et « WEB » sont les seuls emplacements du stock vendable.
const EMPLACEMENTS = { CENTRAL: "CENTRAL", CENTRALE: "CENTRAL", WEB: "WEB", SHOP: "WEB", SITE: "WEB" };
const sansAccent = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();
const estVrai = v => ["oui", "o", "yes", "y", "x", "1", "true", "vrai"].includes(sansAccent(v));

// Cherche, dans l'en-tête, la colonne qui correspond à l'un des intitulés attendus.
function trouverColonne(entete, candidats) {
  const norm = entete.map(sansAccent);
  for (const c of candidats) {
    const i = norm.indexOf(c);
    if (i >= 0) return entete[i];
  }
  return null;
}

function detecterStockB2B(tampon) {
  for (const encodage of ["utf-8", "windows-1252"]) {
    let texte;
    try { texte = new TextDecoder(encodage).decode(tampon); } catch (e) { continue; }
    const premiere = texte.slice(0, 8000).split(/\r?\n/)[0].replace(/^\uFEFF/, "");
    for (const sep of [";", ",", "\t"]) {
      const entete = decouperLigne(premiere, sep).map(c => c.trim());
      if (entete.length < 2) continue;
      const ref = trouverColonne(entete, COLONNES_B2B.reference);
      const qte = trouverColonne(entete, COLONNES_B2B.quantite);
      const preco = trouverColonne(entete, COLONNES_B2B.precommande);
      if (!ref || !(qte || preco)) continue;
      return { modele: "stock_b2b", texte, entete,
        spec: { libelle: "Stock B2B (fichier Footkorner) — stock vendable du catalogue",
                sep, encodage, remplacement_complet: true,
                remplacement_libelle: "remplace le stock B2B du catalogue + recalcul des actifs",
                colonnes: { ref, taille: trouverColonne(entete, COLONNES_B2B.taille), qte, preco,
                            magasin: trouverColonne(entete, COLONNES_B2B.magasin),
                            gencod: trouverColonne(entete, COLONNES_B2B.gencod) } } };
    }
  }
  return null;
}

// Analyse CSV/TSV avec guillemets (état simple, suffisant pour les exports Fastmag).
function decouperLigne(ligne, sep) {
  const champs = [];
  let courant = "", entreGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (entreGuillemets) {
      if (c === '"' && ligne[i + 1] === '"') { courant += '"'; i++; }
      else if (c === '"') entreGuillemets = false;
      else courant += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === sep) { champs.push(courant); courant = ""; }
    else courant += c;
  }
  champs.push(courant);
  return champs;
}

// Découpe le texte entier en enregistrements : gère les champs entre guillemets
// contenant des retours à la ligne (descriptions Shopify multi-lignes).
function decouperTexte(texte, sep) {
  const enregistrements = [];
  let champs = [], courant = "", entreGuillemets = false, vide = true;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { courant += '"'; i++; }
      else if (c === '"') entreGuillemets = false;
      else courant += c;
    } else if (c === '"') { entreGuillemets = true; vide = false; }
    else if (c === sep) { champs.push(courant); courant = ""; vide = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texte[i + 1] === "\n") i++;
      if (!vide || courant.length) { champs.push(courant); enregistrements.push(champs); }
      champs = []; courant = ""; vide = true;
    } else { courant += c; vide = false; }
  }
  if (!vide || courant.length) { champs.push(courant); enregistrements.push(champs); }
  return enregistrements;
}

function detecterModeleImport(tampon) {
  for (const [nom, s] of Object.entries(MODELES_IMPORT)) {
    const essai = new TextDecoder(s.encodage).decode(tampon);
    const premiere = essai.slice(0, 8000).split(/\r?\n/)[0].replace(/^\uFEFF/, "");
    const colonnes = decouperLigne(premiere, s.sep).map(col => col.trim());
    if (s.signature.every(sig => colonnes.includes(sig))) {
      return { modele: nom, spec: s, texte: essai, entete: colonnes };
    }
  }
  return null;
}

async function analyserFichierFastmag(fichier) {
  const tampon = await fichier.arrayBuffer();
  const empreinte = [...new Uint8Array(await crypto.subtle.digest("SHA-256", tampon))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // .zip et .xlsx acceptés tels quels : un classeur Excel est un ZIP de XML,
  // on en tire la première feuille ; sinon on cherche un CSV au format connu.
  let nomAffiche = fichier.name, d = null;
  if (estZip(tampon)) {
    let entrees;
    try { entrees = await dezipper(tampon); }
    catch (e) { return { erreur: "lecture du fichier impossible : " + e.message, empreinte }; }

    if (estXlsx(entrees)) {
      let texte;
      try { texte = xlsxVersTexte(entrees); }
      catch (e) { return { erreur: "classeur Excel illisible : " + e.message, empreinte }; }
      if (!texte.trim()) return { erreur: "la première feuille de ce classeur est vide", empreinte };
      const octets = new TextEncoder().encode(texte).buffer;
      d = detecterModeleImport(octets) || detecterStockB2B(octets);
      if (!d) return { erreur: "format non reconnu : l'en-tête de la feuille ne correspond "
        + "à aucun modèle connu", empreinte };
      nomAffiche = fichier.name + " → feuille 1";
    } else {
      for (const e of entrees) {
        if (!/\.(csv|txt|tsv)$/i.test(e.nom) || /summary/i.test(e.nom)) continue;
        d = detecterModeleImport(e.tampon) || detecterStockB2B(e.tampon);
        if (d) { nomAffiche = fichier.name + " \u2192 " + e.nom; break; }
      }
      if (!d) return { erreur: "aucun fichier au format connu dans ce ZIP", empreinte };
    }
  } else {
    // les mod\u00e8les Fastmag/Shopify d'abord (signature stricte), le stock B2B en dernier recours
    d = detecterModeleImport(tampon) || detecterStockB2B(tampon);
  }
  if (!d) return { erreur: "format non reconnu : l'en-t\u00eate ne correspond \u00e0 aucun mod\u00e8le connu", empreinte };
  const { modele, spec, texte, entete } = d;

  const enregistrements = decouperTexte(texte.replace(/^\uFEFF/, ""), spec.sep);
  const stats = { trim: 0, prefixe: 0, decimales: 0 };
  const quarantaine = [];
  const lignes = [];
  const colRef = ["BarCode", "BarCode V2", "Reference_Article"].find(c => entete.includes(c));

  for (let n = 1; n < enregistrements.length; n++) {
    const champs = enregistrements[n];
    const obj = {};
    entete.forEach((c, i) => {
      let v = champs[i] ?? "";
      const propre = v.trim();
      if (propre !== v) stats.trim++;
      obj[c] = propre;
    });
    // le retrait du préfixe fournisseur est décidé plus tard, référentiel en main
    // (cf. resoudrePrefixes) : « ETIQ- » ou « MAT- » ne sont pas des préfixes.
    if (spec.decimale_virgule) {
      for (const c of ["Prix", "PrixAchat"]) {
        if (obj[c]?.includes(",")) { obj[c] = obj[c].replace(",", "."); stats.decimales++; }
      }
    }
    const ref = colRef ? obj[colRef] : "";
    if (ref && !RE_REF_VALIDE.test(ref)) {
      quarantaine.push({ ligne: n + 1, colonne: colRef, valeur: ref, erreur: "référence non conforme" });
      continue;
    }
    lignes.push(obj);
  }

  return { modele, libelle: spec.libelle, spec, empreinte, fichier: nomAffiche, entete,
           lignes, lues: enregistrements.length - 1, quarantaine, stats };
}

// Les tarifs Fastmag contiennent encore des références préfixées par un code
// fournisseur (NIK-, NKS-, PUM-, ASI-, UND-…). Ce sont d'ANCIENS articles, en cours
// de disparition : 99,8 % d'entre eux ont déjà leur référence définitive tarifée dans
// le même fichier, avec parfois un prix différent. On ne les rabat donc surtout pas
// sur la référence propre — on les laisse tels quels, inertes, et on se contente de
// dire combien de lignes ne correspondent à aucun produit du référentiel.
async function verifierReferences(analyse) {
  if (!analyse.spec.verifie_references) return analyse;
  const colRef = ["BarCode", "BarCode V2", "Reference_Article"].find(c => analyse.entete.includes(c));
  if (!colRef) return analyse;

  const refs = [...new Set(analyse.lignes.map(l => l[colRef]).filter(Boolean))];
  const connues = new Set();
  for (let i = 0; i < refs.length; i += 3000) {
    const lot = await api("/rest/v1/rpc/references_connues", { corps: { p_refs: refs.slice(i, i + 3000) } });
    for (const r of lot || []) connues.add(r);
  }
  const inconnues = refs.filter(r => !connues.has(r));
  analyse.stats.reference_connue = refs.length - inconnues.length;
  analyse.stats.reference_inconnue = inconnues.length;
  analyse.stats.exemples_inconnues = inconnues.slice(0, 6);
  return analyse;
}

// Transforme les lignes analysées en enregistrements pour la base.
// Fichier de stock B2B → lignes prêtes pour la base, avec le détail de ce qui a été lu
// (les colonnes ayant été reconnues à l'intitulé, autant les montrer avant d'exécuter).
function preparerStockB2B(analyse) {
  const { ref, taille, qte, preco, magasin, gencod } = analyse.spec.colonnes;
  const parCle = new Map();
  let precommandes = 0, ignorees = 0, inconnus = new Set();
  for (const l of analyse.lignes) {
    const reference = (l[ref] || "").trim();
    if (!reference) { ignorees++; continue; }
    const t = ((taille ? l[taille] : "") || "").trim();
    // sans colonne magasin, tout va au central : c'est l'ancien comportement
    const brut = ((magasin ? l[magasin] : "") || "CENTRAL").trim().toUpperCase();
    const emplacement = EMPLACEMENTS[brut];
    if (!emplacement) { inconnus.add(brut); ignorees++; continue; }
    const illimite = preco ? estVrai(l[preco]) : false;
    const q = qte ? (parseInt(parseFloat((l[qte] || "0").replace(",", ".")), 10) || 0) : 0;
    if (!illimite && q <= 0) { ignorees++; continue; }
    const cle = emplacement + "|" + reference + "|" + t;
    const e = parCle.get(cle)
      || { magasin: emplacement, reference, taille: t, quantite: 0, illimite: false, gencod: null };
    e.quantite += q;
    e.illimite = e.illimite || illimite;
    e.gencod ??= gencod ? ((l[gencod] || "").trim() || null) : null;
    parCle.set(cle, e);
  }
  const rows = [...parCle.values()];
  for (const e of rows) if (e.illimite) precommandes++;
  return {
    rows, precommandes, ignorees,
    central: rows.filter(r => r.magasin === "CENTRAL").length,
    web: rows.filter(r => r.magasin === "WEB").length,
    emplacementsInconnus: [...inconnus],
  };
}

function mapperVersTables(analyse) {
  const L = analyse.lignes;
  switch (analyse.modele) {
    case "fiches_produits": {
      const vus = new Set();
      const uniques = L.filter(l => l.Produit && !vus.has(l.Produit) && vus.add(l.Produit));
      analyse.stats.doublons = L.filter(l => l.Produit).length - uniques.length;
      return [{ table: "variantes", rows: uniques.map(l => ({
        id_fastmag: l.Produit, reference: l.Reference_Article, couleur: l.Couleur,
        taille: l.Taille, ean: l.Gencod || null, designation: l.Designation,
        coloris_fournisseur: l.Designation2, marque: l.Marque, famille: l.Famille,
        sous_famille: l.Sous_Famille, rayon: l.Rayon, saison: l.Saison })) }];
    }
    case "stock":
      return [{ table: "stocks", vider: true, activer: true,
        rows: L.filter(l => parseInt(l["Total Stock"], 10) > 0).map(l => ({
          magasin: l.Code_Origine, reference: l["BarCode V2"], taille: l.Taille,
          quantite: parseInt(l["Total Stock"], 10) })) }];
    case "tarifs": {
      // Le fichier contient quelques doublons sur la clé (référence, couleur, taille,
      // grille) — Postgres refuse d'appliquer deux fois la même clé dans un seul lot.
      // On garde le prix le plus bas, ce que le catalogue retiendrait de toute façon
      // s'il trouvait les deux (il lit min(prix)).
      const parCle = new Map();
      let doublons = 0;
      // Un prix à zéro n'est jamais un vrai tarif : c'est une fiche incomplète côté
      // Fastmag. L'importer rendrait le produit commandable pour rien — on le rejette
      // et on le liste, plutôt que de laisser passer une vente à 0 €.
      const rejets = [];
      for (const l of L) {
        if (!l.BarCode) continue;
        const prix = parseFloat(l.Prix);
        if (!l.Tarif || isNaN(prix)) continue;
        if (prix <= 0) {
          rejets.push({ reference: l.BarCode, couleur: l.Couleur || "", taille: l.Taille || "",
                        famille_tarifaire: l.Tarif, prix,
                        designation: l.Designation || l.DESIGNATION || "",
                        prix_achat: l.PrixAchat || "" });
          continue;
        }
        const r = { reference: l.BarCode, couleur: l.Couleur || "", taille: l.Taille || "",
                    famille_tarifaire: l.Tarif, prix,
                    prix_achat: l.PrixAchat ? parseFloat(l.PrixAchat) : null };
        const cle = [r.reference, r.couleur, r.taille, r.famille_tarifaire].join("\u0001");
        const vu = parCle.get(cle);
        if (!vu) { parCle.set(cle, r); continue; }
        doublons++;
        if (r.prix < vu.prix) parCle.set(cle, r);
      }
      analyse.stats.doublons = doublons;
      analyse.rejetsPrixZero = rejets;
      analyse.stats.prix_zero = rejets.length;
      return [{ table: "tarifs", rows: [...parCle.values()] }];
    }
    case "stock_shopify": {
      const REF = "Metafield: fmsync.reference [single_line_text_field]";
      const refParId = {}, statutParId = {};
      for (const l of L) {
        if (l.ID && l[REF]) refParId[l.ID] ??= l[REF].trim();
        if (l.ID && l.Status) statutParId[l.ID] ??= l.Status.trim();
      }
      const parCle = new Map();
      for (const l of L) {
        const ref = refParId[l.ID];
        if (!ref || !l["Variant ID"] || !l["Option1 Value"]) continue;
        if ((statutParId[l.ID] || "").toLowerCase() !== "active") continue; // seuls les produits actifs Shopify
        const q = parseInt(parseFloat(l["Inventory Available: Duhamel"] || 0), 10) || 0;
        if (q <= 0) continue;
        const cle = ref + "|" + l["Option1 Value"];
        parCle.set(cle, (parCle.get(cle) || 0) + q);
      }
      // le même fichier alimente aussi photos/galeries/promos : un dépôt = tout à jour
      const COLONNES_ASSOCIES = [
        "Metafield: shopify--discovery--product_recommendation.complementary_products [list.product_reference]",
        "Metafield: product.cross_sell [product_reference]",
        "Metafield: product.products_bundle [list.product_reference]",
      ];
      const galeries = {}, prix = {}, associesParId = {};
      const handleParId = {}, creeParId = {}, descriptionParId = {};
      for (const l of L) {
        if (!l.ID) continue;
        if (l.Handle) handleParId[l.ID] ??= l.Handle.trim();
        if (l["Created At"]) creeParId[l.ID] ??= l["Created At"].trim().slice(0, 10);
        if (l["Body HTML"]) descriptionParId[l.ID] ??= l["Body HTML"];
        if (l["Image Src"]) {
          const g = galeries[l.ID] ??= [];
          if (!g.includes(l["Image Src"])) g.push(l["Image Src"]);
        }
        for (const col of COLONNES_ASSOCIES) {
          const v = (l[col] || "").trim();
          if (!v) continue;
          const a = associesParId[l.ID] ??= [];
          for (const h of v.split(",").map(x => x.trim()).filter(Boolean)) if (!a.includes(h)) a.push(h);
        }
        const p = parseFloat(l["Variant Price"]);
        const cp = parseFloat(l["Variant Compare At Price"]);
        if (!isNaN(p)) {
          const e = prix[l.ID] ??= { prix: p, compare: isNaN(cp) ? null : cp };
          if (!isNaN(cp) && (!e.compare || cp > e.compare)) { e.prix = p; e.compare = cp; }
        }
      }
      const photosParRef = {};
      for (const [pid, g] of Object.entries(galeries)) {
        const ref = refParId[pid];
        if (!ref || !g.length) continue;
        const e = prix[pid] || {};
        const promo = e.compare && e.compare > e.prix
          ? Math.round(100 * (1 - e.prix / e.compare)) : 0;
        const candidat = { reference: ref, url: g[0], urls: g, handle: handleParId[pid] || null,
          prix_shopify: e.prix ?? null, prix_barre: e.compare ?? null, promo_pct: promo,
          associes: associesParId[pid] || [],
          cree_shopify: creeParId[pid] || null, description: descriptionParId[pid] || null };
        const ex = photosParRef[ref];
        if (!ex || g.length > ex.urls.length) {
          if (ex && ex.promo_pct > promo) candidat.promo_pct = ex.promo_pct;
          if (ex && !candidat.associes.length) candidat.associes = ex.associes;
          if (ex) { candidat.cree_shopify ??= ex.cree_shopify; candidat.description ??= ex.description; }
          photosParRef[ref] = candidat;
        } else {
          if (promo > ex.promo_pct) ex.promo_pct = promo;
          if (!ex.associes.length && associesParId[pid]?.length) ex.associes = associesParId[pid];
          ex.cree_shopify ??= creeParId[pid] || null;
          ex.description ??= descriptionParId[pid] || null;
        }
      }
      return [
        // vider: seulement les lignes Duhamel — le stock B2B, lui, vient du dépôt Fastmag
        { table: "stocks", vider: true, magasin: "DUHAMEL", activer: true,
          rows: [...parCle.entries()].map(([cle, q]) => {
            const [reference, taille] = cle.split("|");
            return { magasin: "DUHAMEL", reference, taille, quantite: q };
          }) },
        { table: "photos", rows: Object.values(photosParRef) },
      ];
    }
    case "ventes": {
      // agrégation par magasin+référence+taille+jour (le journal contient des doublons)
      const parCle = new Map();
      for (const l of L) {
        const ref = (l["BarCode V2"] || "").trim();
        const j = (l["Jours dans Date"] || "").trim();
        if (!ref || j.length !== 10) continue;
        const jour = `${j.slice(6, 10)}-${j.slice(3, 5)}-${j.slice(0, 2)}`;
        const cle = `${l.Code_Origine}|${ref}|${l.Taille}|${jour}`;
        const e = parCle.get(cle) || { magasin: l.Code_Origine, reference: ref,
          taille: l.Taille || "", jour, quantite: 0, montant_ttc: 0 };
        e.quantite += parseInt(parseFloat(l["Total QteVenteRetail"] || 0), 10) || 0;
        e.montant_ttc += parseFloat(l.MtVenteRetailTTC || 0) || 0;
        parCle.set(cle, e);
      }
      return [{ table: "ventes", rows: [...parCle.values()].filter(r => r.quantite !== 0) }];
    }
    case "clients": {
      const parCompte = new Map();
      // La colonne Remise n'existe que sur les exports récents : sans elle on ne
      // touche pas au champ, sinon un vieux fichier remettrait toutes les remises à 0.
      const avecRemise = L.some(l => "Remise" in l);
      for (const l of L) {
        if (!l.CompteClient) continue;
        const c = parCompte.get(l.CompteClient) || { compte: l.CompteClient };
        c.id_fastmag = c.id_fastmag || (l.Client || null);
        c.nom = c.nom || (l.Nom || null);
        c.famille_tarifaire = c.famille_tarifaire || (l.TarifVente || null);
        if (avecRemise && c.remise === undefined) c.remise = pourcentFr(l.Remise);
        parCompte.set(l.CompteClient, c);
      }
      return [{ table: "societes", rows: [...parCompte.values()]
        .map(c => ({ ...c, nom: c.nom || c.compte })) }];
    }
  }
  return [];
}

// « 10,00 » (décimale française) en pourcentage utilisable. Hors bornes ou illisible : 0.
function pourcentFr(v) {
  const n = parseFloat(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) && n > 0 && n < 100 ? Math.round(n * 100) / 100 : 0;
}

async function executerImport(analyse, surProgres) {
  // Le stock B2B passe par ses propres fonctions : il ne doit toucher que ses lignes
  // (le stock Duhamel reste en base pour le merch) et il solde les commandes en attente.
  if (analyse.modele === "stock_b2b") return executerStockB2B(analyse, surProgres);

  const plans = mapperVersTables(analyse);
  let total = 0;
  for (const plan of plans) {
    if (plan.vider) {
      surProgres(plan.magasin ? `vidage du stock ${plan.magasin}…` : "vidage de la table stocks…");
      await apiFonction("vider", { table: "stocks", magasin: plan.magasin || null });
    }
    for (let i = 0; i < plan.rows.length; i += 3000) {
      const lot = plan.rows.slice(i, i + 3000);
      await apiFonction("upsert", { table: plan.table, rows: lot });
      total += lot.length;
      surProgres(`${plan.table} : ${total}/${plan.rows.length} lignes…`);
    }
    if (plan.activer) {
      surProgres("recalcul des produits actifs…");
      try { await apiFonction("activer", {}); }
      catch (e) {
        // le recalcul peut dépasser le délai de l'API sur un gros volume : on retente une fois
        surProgres("recalcul long, nouvel essai…");
        await new Promise(r => setTimeout(r, 4000));
        try { await apiFonction("activer", {}); }
        catch (e2) { surProgres("⚠ stock importé, mais recalcul des actifs à relancer (réessayez dans 2 min via un nouvel import ou signalez-le)"); }
      }
    }
  }
  await apiFonction("journal", { entree: {
    fichier: analyse.fichier, modele: analyse.modele, empreinte: analyse.empreinte,
    lignes_lues: analyse.lues, crees: total, maj: 0, inchanges: 0,
    quarantaine: analyse.quarantaine.length, statut: "OK" } });
  return total;
}

// Dépôt de précommande : même fichier que le stock B2B, mais rangé dans une campagne
// et CUMULATIF — Anthony dépose marque par marque, rien n'est effacé entre deux dépôts.
async function executerPrecommande(analyse, surProgres) {
  const campagne = (document.getElementById("nom-campagne")?.value || "").trim();
  if (!campagne) throw new Error("donnez un nom de campagne (ex. FW26) avant de déposer");

  const { rows, precommandes, ignorees } = preparerStockB2B(analyse);
  if (!rows.length) throw new Error("aucune ligne exploitable dans ce fichier");

  let envoyees = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const lot = rows.slice(i, i + 2000);
    await api("/rest/v1/rpc/precommande_lot", { corps: { p_campagne: campagne, p_rows: lot } });
    envoyees += lot.length;
    surProgres(`campagne ${campagne} : ${envoyees}/${rows.length} lignes…`);
  }

  const etat = (await api("/rest/v1/rpc/campagnes_precommande", { corps: {} }).catch(() => []))
    .find(c => c.campagne === campagne);
  const mots = [`${envoyees} ligne(s) déposée(s) dans « ${campagne} »`];
  if (etat) mots.push(`la campagne compte maintenant ${etat.references} référence(s) et ${etat.lignes} ligne(s)`);
  if (precommandes) mots.push(`${precommandes} en quantité libre`);
  if (ignorees) mots.push(`${ignorees} ligne(s) ignorée(s) (sans référence ou quantité nulle)`);
  surProgres("✓ " + mots.join(" · "));

  await apiFonction("journal", { entree: {
    fichier: `${analyse.fichier} → précommande ${campagne}`, modele: "precommande",
    empreinte: analyse.empreinte, lignes_lues: analyse.lues, crees: envoyees, maj: 0, inchanges: 0,
    quarantaine: analyse.quarantaine.length, statut: "OK" } });
  return envoyees;
}

// Dépôt du stock B2B : préparation, envoi par lots, puis bascule côté serveur
// (remplacement du stock, solde des commandes en attente, recalcul des actifs).
async function executerStockB2B(analyse, surProgres) {
  const prepare = preparerStockB2B(analyse);
  const { rows, precommandes, ignorees } = prepare;
  if (!rows.length) throw new Error("aucune ligne de stock exploitable dans ce fichier");

  surProgres("préparation du dépôt…");
  await api("/rest/v1/rpc/stock_b2b_debut", { corps: {} });

  let envoyees = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const lot = rows.slice(i, i + 2000);
    await api("/rest/v1/rpc/stock_b2b_lot", { corps: { p_rows: lot } });
    envoyees += lot.length;
    surProgres(`stock B2B : ${envoyees}/${rows.length} lignes…`);
  }

  surProgres("remplacement du stock et recalcul des produits actifs…");
  const bilan = await api("/rest/v1/rpc/stock_b2b_fin", { corps: {} });

  const mots = [`${bilan.lignes} lignes de stock`];
  if (bilan.central || bilan.web) mots.push(`${bilan.central || 0} au central · ${bilan.web || 0} au web`);
  if (prepare.emplacementsInconnus?.length) {
    mots.push(`⚠ emplacement inconnu ignoré : ${prepare.emplacementsInconnus.join(", ")}`);
  }
  if (precommandes) mots.push(`${precommandes} en précommande`);
  if (bilan.commandes_soldees) mots.push(`${bilan.commandes_soldees} commande(s) en attente soldée(s)`);
  if (ignorees) mots.push(`${ignorees} ligne(s) ignorée(s) (sans référence ou quantité nulle)`);
  surProgres("✓ " + mots.join(" · "));
  // une référence+taille absente des fiches produits n'apparaîtra jamais au catalogue :
  // on le dit franchement plutôt que de laisser du stock invisible
  if (bilan.inconnues) {
    surProgres(`⚠ ${bilan.inconnues} ligne(s) sans fiche produit correspondante — invisibles au catalogue`
      + (bilan.exemples_inconnues ? ` (ex. ${bilan.exemples_inconnues})` : ""));
  }

  await apiFonction("journal", { entree: {
    fichier: analyse.fichier, modele: analyse.modele, empreinte: analyse.empreinte,
    lignes_lues: analyse.lues, crees: bilan.lignes, maj: 0, inchanges: 0,
    quarantaine: analyse.quarantaine.length, statut: "OK" } });
  return bilan.lignes;
}
