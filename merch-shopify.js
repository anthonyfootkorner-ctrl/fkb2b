// Merch Shopify — réordonner les collections du site public depuis FKB2B.
// Principe : on ne réinvente aucun format. Le fichier Matrixify (export CSV de
// l'entité Custom Collections) entre tel quel, ressort tel quel — seules les
// valeurs de la colonne de position sont réécrites selon l'ordre choisi.

let shopifyDonnees = null; // { entete, lignes, colonnes:{handle, prodHandle, prodTitre, position}, collections }

function detecterColonnesShopify(entete) {
  const trouver = (...tests) => entete.find(c => tests.some(t => t.test(c)));
  return {
    handle: trouver(/^Handle$/i, /^ID$/i),
    prodHandle: trouver(/^Product:? ?Handle$/i, /Product.*Handle/i),
    prodTitre: trouver(/^Product:? ?Title$/i, /Product.*Title/i),
    position: trouver(/^Product:? ?Position$/i, /Product.*Position/i, /Position/i),
    triCollection: trouver(/^Sort ?Order$/i, /Sort/i),
  };
}

async function analyserFichierShopify(fichier) {
  const texte = new TextDecoder("utf-8").decode(await fichier.arrayBuffer()).replace(/^﻿/, "");
  const lignesBrutes = texte.split(/\r?\n/).filter(l => l.length);
  const entete = decouperLigne(lignesBrutes[0], ",").map(c => c.trim());
  const cols = detecterColonnesShopify(entete);
  if (!cols.handle || !cols.position || !(cols.prodHandle || cols.prodTitre)) {
    return { erreur: `colonnes non reconnues — trouvé : ${entete.slice(0, 8).join(", ")}…
      Il faut un export Matrixify « Custom Collections » en CSV avec les colonnes produit (Handle/Title/Position).` };
  }
  const iH = entete.indexOf(cols.handle);
  const lignes = lignesBrutes.slice(1).map(l => decouperLigne(l, ","));
  const collections = {};
  lignes.forEach((champs, i) => {
    const h = champs[iH];
    if (!h) return;
    (collections[h] ??= []).push(i);
  });
  return { fichier: fichier.name, entete, lignes, cols, collections };
}

function champCSV(v) {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function genererCSVShopify(donnees, collection, ordreHandles) {
  const { entete, lignes, cols } = donnees;
  const iH = entete.indexOf(cols.handle);
  const iPH = entete.indexOf(cols.prodHandle >= "" ? cols.prodHandle : cols.prodTitre);
  const iPos = entete.indexOf(cols.position);
  const position = new Map(ordreHandles.map((h, i) => [h, i + 1]));
  const sortie = [entete.map(champCSV).join(",")];
  for (const champs of lignes) {
    const copie = [...champs];
    if (copie[iH] === collection && position.has(copie[iPH])) {
      copie[iPos] = String(position.get(copie[iPH]));
    }
    sortie.push(copie.map(champCSV).join(","));
  }
  return sortie.join("\r\n") + "\r\n";
}

async function chargerVignettesShopify(handles) {
  const vignettes = {};
  for (let i = 0; i < handles.length; i += 80) {
    const lot = handles.slice(i, i + 80).map(h => '"' + h.replaceAll('"', "") + '"').join(",");
    const rows = await api(`/rest/v1/photos?handle=in.(${encodeURIComponent(lot)})&select=handle,url,reference`)
      .catch(() => []);
    for (const r of rows) vignettes[r.handle] = r;
  }
  return vignettes;
}
