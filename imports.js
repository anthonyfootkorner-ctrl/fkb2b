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
    strip_prefixe: true, decimale_virgule: true,
  },
  clients: {
    libelle: "Comptes clients",
    sep: ";", encodage: "windows-1252",
    signature: ["CompteClient", "TarifVente", "Client", "AdrLivraison"],
  },
  stock_shopify: {
    libelle: "Stock Shopify — emplacement Duhamel (stock B2B)",
    sep: ",", encodage: "utf-8",
    signature: ["ID", "Handle", "Variant ID", "Option1 Value", "Inventory Available: Duhamel"],
    remplacement_complet: true,
  },
  ventes: {
    libelle: "Ventes quotidiennes (journal VENTE)",
    sep: ",", encodage: "utf-8",
    signature: ["Code_Origine", "BarCode V2", "Jours dans Date", "Total QteVenteRetail"],
  },
};
const RE_PREFIXE_FOURNISSEUR = /^[A-Z]{2,4}-/;
const RE_REF_VALIDE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;

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

async function analyserFichierFastmag(fichier) {
  const tampon = await fichier.arrayBuffer();
  const empreinte = [...new Uint8Array(await crypto.subtle.digest("SHA-256", tampon))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // détection du modèle par la signature de l'en-tête, dans l'encodage du modèle
  let modele = null, spec = null, entete = null, texte = null;
  for (const [nom, s] of Object.entries(MODELES_IMPORT)) {
    const essai = new TextDecoder(s.encodage).decode(tampon);
    const premiere = essai.slice(0, 8000).split(/\r?\n/)[0].replace(/^﻿/, "");
    const colonnes = decouperLigne(premiere, s.sep).map(c => c.trim());
    if (s.signature.every(sig => colonnes.includes(sig))) {
      modele = nom; spec = s; texte = essai; entete = colonnes; break;
    }
  }
  if (!modele) return { erreur: "format non reconnu : l'en-tête ne correspond à aucun modèle connu", empreinte };

  const lignesBrutes = texte.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.length);
  const stats = { trim: 0, prefixe: 0, decimales: 0 };
  const quarantaine = [];
  const lignes = [];
  const colRef = ["BarCode", "BarCode V2", "Reference_Article"].find(c => entete.includes(c));

  for (let n = 1; n < lignesBrutes.length; n++) {
    const champs = decouperLigne(lignesBrutes[n], spec.sep);
    const obj = {};
    entete.forEach((c, i) => {
      let v = champs[i] ?? "";
      const propre = v.trim();
      if (propre !== v) stats.trim++;
      obj[c] = propre;
    });
    if (spec.strip_prefixe && obj[colRef]) {
      const neuf = obj[colRef].replace(RE_PREFIXE_FOURNISSEUR, "");
      if (neuf !== obj[colRef]) { obj[colRef] = neuf; stats.prefixe++; }
    }
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

  return { modele, libelle: spec.libelle, spec, empreinte, fichier: fichier.name,
           lignes, lues: lignesBrutes.length - 1, quarantaine, stats };
}

// Transforme les lignes analysées en enregistrements pour la base.
function mapperVersTables(analyse) {
  const L = analyse.lignes;
  switch (analyse.modele) {
    case "fiches_produits":
      return [{ table: "variantes", rows: L.filter(l => l.Produit).map(l => ({
        id_fastmag: l.Produit, reference: l.Reference_Article, couleur: l.Couleur,
        taille: l.Taille, ean: l.Gencod || null, designation: l.Designation,
        coloris_fournisseur: l.Designation2, marque: l.Marque, famille: l.Famille,
        sous_famille: l.Sous_Famille, rayon: l.Rayon, saison: l.Saison })) }];
    case "stock":
      return [{ table: "stocks", vider: true, activer: true,
        rows: L.filter(l => parseInt(l["Total Stock"], 10) > 0).map(l => ({
          magasin: l.Code_Origine, reference: l["BarCode V2"], taille: l.Taille,
          quantite: parseInt(l["Total Stock"], 10) })) }];
    case "tarifs":
      return [{ table: "tarifs", rows: L.filter(l => l.BarCode).map(l => ({
        reference: l.BarCode, couleur: l.Couleur || "", taille: l.Taille || "",
        famille_tarifaire: l.Tarif, prix: parseFloat(l.Prix),
        prix_achat: l.PrixAchat ? parseFloat(l.PrixAchat) : null }))
        .filter(r => r.famille_tarifaire && !isNaN(r.prix)) }];
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
      return [{ table: "stocks", vider: true, activer: true,
        rows: [...parCle.entries()].map(([cle, q]) => {
          const [reference, taille] = cle.split("|");
          return { magasin: "DUHAMEL", reference, taille, quantite: q };
        }) }];
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
      for (const l of L) {
        if (!l.CompteClient) continue;
        const c = parCompte.get(l.CompteClient) || { compte: l.CompteClient };
        c.id_fastmag = c.id_fastmag || (l.Client || null);
        c.nom = c.nom || (l.Nom || null);
        c.famille_tarifaire = c.famille_tarifaire || (l.TarifVente || null);
        parCompte.set(l.CompteClient, c);
      }
      return [{ table: "societes", rows: [...parCompte.values()]
        .map(c => ({ ...c, nom: c.nom || c.compte })) }];
    }
  }
  return [];
}

async function executerImport(analyse, surProgres) {
  const plans = mapperVersTables(analyse);
  let total = 0;
  for (const plan of plans) {
    if (plan.vider) { surProgres("vidage de la table stocks…"); await apiFonction("vider", { table: "stocks" }); }
    for (let i = 0; i < plan.rows.length; i += 3000) {
      const lot = plan.rows.slice(i, i + 3000);
      await apiFonction("upsert", { table: plan.table, rows: lot });
      total += lot.length;
      surProgres(`${plan.table} : ${total}/${plan.rows.length} lignes…`);
    }
    if (plan.activer) { surProgres("recalcul des produits actifs…"); await apiFonction("activer", {}); }
  }
  await apiFonction("journal", { entree: {
    fichier: analyse.fichier, modele: analyse.modele, empreinte: analyse.empreinte,
    lignes_lues: analyse.lues, crees: total, maj: 0, inchanges: 0,
    quarantaine: analyse.quarantaine.length, statut: "OK" } });
  return total;
}
