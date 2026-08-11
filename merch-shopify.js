// Merch Shopify — réordonner les collections du site public depuis FKB2B.
// Principe : on ne réinvente aucun format. Le fichier Matrixify (export CSV de
// l'entité Custom Collections) entre tel quel, ressort tel quel — seules les
// valeurs de la colonne de position sont réécrites selon l'ordre choisi.

let shopifyDonnees = null; // { entete, lignes, colonnes:{handle, prodHandle, prodTitre, position}, collections }

function detecterColonnesShopify(entete) {
  // les motifs sont essayés PAR PRIORITÉ (le premier qui matche une colonne gagne),
  // sinon « ID » serait retenu avant « Handle » — format réel validé le 03/08/2026 :
  // ID, Handle, Product: ID, Product: Handle, Product: Position, Product: Command
  const trouver = (...tests) => {
    for (const t of tests) {
      const c = entete.find(col => t.test(col));
      if (c) return c;
    }
  };
  return {
    handle: trouver(/^Handle$/i, /^ID$/i),
    prodHandle: trouver(/^Product:? ?Handle$/i, /Product.*Handle/i),
    prodTitre: trouver(/^Product:? ?Title$/i, /Product.*Title/i),
    position: trouver(/^Product:? ?Position$/i, /Product.*Position/i, /Position/i),
    triCollection: trouver(/^Sort ?Order$/i, /Sort/i),
  };
}

// Analyse un CSV de collections (texte déjà décodé) → segment {entete, cols, lignes}
function analyserSegmentShopify(texte, nom) {
  const enregs = decouperTexte(texte.replace(/^\uFEFF/, ""), ",");
  if (!enregs.length) return { erreur: "fichier vide" };
  const entete = enregs[0].map(col => col.trim());
  const cols = detecterColonnesShopify(entete);
  if (!cols.handle || !cols.position || !(cols.prodHandle || cols.prodTitre)) {
    return { erreur: `colonnes non reconnues — trouvé : ${entete.slice(0, 8).join(", ")}…` };
  }
  return { nom, entete, cols, lignes: enregs.slice(1) };
}

async function analyserFichierShopify(fichier) {
  const tampon = await fichier.arrayBuffer();
  const sources = [];
  if (estZip(tampon)) {
    let entrees;
    try { entrees = await dezipper(tampon); }
    catch (e) { return { erreur: "lecture du ZIP impossible : " + e.message }; }
    for (const e of entrees) {
      if (!/\.csv$/i.test(e.nom) || /summary/i.test(e.nom)) continue;
      sources.push({ nom: e.nom, texte: new TextDecoder("utf-8").decode(e.tampon) });
    }
    if (!sources.length) return { erreur: "aucun CSV de collections dans ce ZIP" };
  } else {
    sources.push({ nom: fichier.name, texte: new TextDecoder("utf-8").decode(tampon) });
  }

  // chaque CSV (Smart + Custom Collections) devient un segment ; l'export ressortira
  // chaque collection dans le format EXACT de son fichier d'origine
  const segments = sources.map(s => analyserSegmentShopify(s.texte, s.nom)).filter(s => !s.erreur);
  if (!segments.length) {
    return { erreur: `colonnes non reconnues.
      Il faut un export Matrixify « Collections » (CSV ou ZIP) avec les colonnes produit (Handle/Title/Position).` };
  }

  // en-tête canonique = union des colonnes (fichier le plus fourni en premier)
  segments.sort((a, b) => b.lignes.length - a.lignes.length);
  const entete = [];
  for (const seg of segments) for (const col of seg.entete) if (!entete.includes(col)) entete.push(col);
  const cols = detecterColonnesShopify(entete);

  const lignes = [], collections = {}, sourcesParCollection = {};
  segments.forEach((seg, si) => {
    const projection = seg.entete.map(col => entete.indexOf(col));
    const iH = seg.entete.indexOf(seg.cols.handle);
    for (const champs of seg.lignes) {
      const ligne = entete.map(() => "");
      champs.forEach((v, j) => { if (projection[j] >= 0) ligne[projection[j]] = v; });
      const rang = lignes.length;
      lignes.push(ligne);
      const h = champs[iH];
      if (!h) continue;
      (collections[h] ??= []).push(rang);
      sourcesParCollection[h] ??= si;
    }
  });
  return { fichier: fichier.name, entete, lignes, cols, collections,
           segments: segments.map(s => ({ nom: s.nom, entete: s.entete })),
           sources: sourcesParCollection };
}

function champCSV(v) {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function genererCSVShopify(donnees, collection, ordreHandles) {
  const { entete, lignes, cols } = donnees;
  // format de sortie = celui du fichier d'où vient la collection (Smart ou Custom) ;
  // les anciens fichiers mémorisés (sans segments) gardent leur en-tête d'origine
  const seg = donnees.segments?.[donnees.sources?.[collection]];
  const enteteSortie = seg ? seg.entete : entete;
  const projection = enteteSortie.map(col => entete.indexOf(col));
  const iH = entete.indexOf(cols.handle);
  const iPH = entete.indexOf(cols.prodHandle || cols.prodTitre);
  const iPos = entete.indexOf(cols.position);
  const position = new Map(ordreHandles.map((h, i) => [h, i + 1]));
  // seule la collection travaillée est exportée : l'import Matrixify ne touche qu'elle
  const sortie = [enteteSortie.map(champCSV).join(",")];
  for (const champs of lignes) {
    if (champs[iH] !== collection) continue;
    const copie = [...champs];
    if (position.has(copie[iPH])) copie[iPos] = String(position.get(copie[iPH]));
    sortie.push(projection.map(j => champCSV(copie[j] ?? "")).join(","));
  }
  return sortie.join("\r\n") + "\r\n";
}

async function chargerVignettesShopify(handles) {
  const vignettes = {};
  for (let i = 0; i < handles.length; i += 80) {
    const lot = handles.slice(i, i + 80).map(h => '"' + h.replaceAll('"', "") + '"').join(",");
    const rows = await api(`/rest/v1/photos?handle=in.(${encodeURIComponent(lot)})&select=handle,url,reference,promo_pct`)
      .catch(() => []);
    for (const r of rows) vignettes[r.handle] = r;
  }
  return vignettes;
}
