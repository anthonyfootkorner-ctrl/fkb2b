// Configuration Supabase du portail FKB2B (clé publique — les droits réels sont côté serveur, via RLS).
const FKB2B = {
  url: "https://jklubjblmqwlhiumnlet.supabase.co",
  cle: "sb_publishable_tm6jIDHxOuWDDdgj54rFPQ_uEFYBcZS",
};

function sessionCourante() {
  try {
    const s = JSON.parse(localStorage.getItem("fkb2b-session") || "null");
    if (s && s.expire_a > Date.now() / 1000 + 30) return s;
    if (s && s.refresh_token) return s; // expirée mais rafraîchissable
  } catch (e) { /* session illisible */ }
  return null;
}

// Rafraîchit la session si elle expire dans moins de 5 minutes (jetons d'une heure).
let rafraichissementEnCours = null;
async function sessionValide() {
  const s = sessionCourante();
  if (!s) return null;
  if (s.expire_a > Date.now() / 1000 + 300) return s;
  rafraichissementEnCours ??= (async () => {
    try {
      const rep = await fetch(FKB2B.url + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "apikey": FKB2B.cle, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (!rep.ok) throw new Error("rafraîchissement refusé");
      const r = await rep.json();
      const neuf = { access_token: r.access_token, refresh_token: r.refresh_token,
                     expire_a: r.expires_at, email: r.user.email };
      localStorage.setItem("fkb2b-session", JSON.stringify(neuf));
      return neuf;
    } catch (e) {
      localStorage.removeItem("fkb2b-session");
      return null;
    } finally {
      setTimeout(() => { rafraichissementEnCours = null; }, 1000);
    }
  })();
  return rafraichissementEnCours;
}

async function api(chemin, { corps, methode, jwt } = {}) {
  const session = jwt ? null : await sessionValide();
  const rep = await fetch(FKB2B.url + chemin, {
    method: methode || (corps !== undefined ? "POST" : "GET"),
    headers: {
      "apikey": FKB2B.cle,
      "Content-Type": "application/json",
      ...(jwt || session ? { "Authorization": `Bearer ${jwt || session.access_token}` } : {}),
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await rep.text();
  let donnees = null;
  try { donnees = texte ? JSON.parse(texte) : null; } catch (e) { donnees = texte; }
  if (!rep.ok) throw Object.assign(new Error(donnees?.message || donnees?.msg || rep.statusText), {donnees, statut: rep.status});
  return donnees;
}

// Dépôt d'un fichier dans un bucket public (visuels de campagne). Renvoie l'URL publique.
async function envoyerFichier(bucket, chemin, fichier) {
  const session = await sessionValide();
  const rep = await fetch(`${FKB2B.url}/storage/v1/object/${bucket}/${encodeURIComponent(chemin)}`, {
    method: "POST",
    headers: {
      "apikey": FKB2B.cle,
      "Authorization": `Bearer ${session.access_token}`,
      "Content-Type": fichier.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: fichier,
  });
  if (!rep.ok) {
    const texte = await rep.text();
    throw new Error(texte.slice(0, 200) || `dépôt refusé (${rep.status})`);
  }
  return `${FKB2B.url}/storage/v1/object/public/${bucket}/${encodeURIComponent(chemin)}`;
}

// Lecture complète d'une table/vue en pages de 1000 (PostgREST plafonne chaque réponse).
async function apiTout(chemin) {
  const tout = [];
  for (let debut = 0; ; debut += 1000) {
    const sep = chemin.includes("?") ? "&" : "?";
    const page = await api(`${chemin}${sep}limit=1000&offset=${debut}`);
    tout.push(...page);
    if (page.length < 1000) break;
  }
  return tout;
}

function deconnexion() {
  localStorage.removeItem("fkb2b-session");
  location.href = "login.html";
}

// Lit un ZIP (exports Matrixify) sans bibliothèque externe : répertoire central
// + DecompressionStream natif du navigateur. Renvoie [{ nom, tampon }].
async function dezipper(tampon) {
  const dv = new DataView(tampon), u8 = new Uint8Array(tampon);
  let eocd = -1;
  for (let i = tampon.byteLength - 22; i >= Math.max(0, tampon.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("archive illisible");
  let nb = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  // Zip64 (exports Matrixify) : compteurs/offsets réels dans l'enregistrement dédié
  if (nb === 0xffff || pos === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const e64 = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(e64, true) === 0x06064b50) {
        nb = Number(dv.getBigUint64(e64 + 32, true));
        pos = Number(dv.getBigUint64(e64 + 48, true));
      }
    }
  }
  const fichiers = [];
  for (let n = 0; n < nb; n++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break;
    const methode = dv.getUint16(pos + 10, true);
    let tailleComp = dv.getUint32(pos + 20, true);
    const tailleDecomp = dv.getUint32(pos + 24, true);
    const lNom = dv.getUint16(pos + 28, true), lExtra = dv.getUint16(pos + 30, true), lComm = dv.getUint16(pos + 32, true);
    let offset = dv.getUint32(pos + 42, true);
    const nom = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + lNom));
    // champ d'extension Zip64 : les valeurs 0xFFFFFFFF sont remplacées, dans l'ordre
    let px = pos + 46 + lNom;
    const finExtra = px + lExtra;
    while (px + 4 <= finExtra) {
      const id = dv.getUint16(px, true), taille = dv.getUint16(px + 2, true);
      if (id === 0x0001) {
        let q = px + 4;
        if (tailleDecomp === 0xffffffff) q += 8;
        if (tailleComp === 0xffffffff) { tailleComp = Number(dv.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) offset = Number(dv.getBigUint64(q, true));
        break;
      }
      px += 4 + taille;
    }
    // longueurs nom/extra de l'en-tête LOCAL (peuvent différer du répertoire central)
    const lNomL = dv.getUint16(offset + 26, true), lExtraL = dv.getUint16(offset + 28, true);
    const debut = offset + 30 + lNomL + lExtraL;
    const comp = tampon.slice(debut, debut + tailleComp);
    let donnees;
    if (methode === 0) donnees = comp;
    else if (methode === 8) donnees = await new Response(new Blob([comp]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    else throw new Error("compression non geree (" + methode + ")");
    if (!nom.endsWith("/")) fichiers.push({ nom, tampon: donnees });
    pos += 46 + lNom + lExtra + lComm;
  }
  return fichiers;
}

function estZip(tampon) {
  return tampon.byteLength > 4 && new DataView(tampon).getUint32(0, true) === 0x04034b50;
}

// Compression gzip native (mémorisation du fichier collections côté serveur)
async function gzipVersBase64(texte) {
  const flux = new Blob([texte]).stream().pipeThrough(new CompressionStream("gzip"));
  const octets = new Uint8Array(await new Response(flux).arrayBuffer());
  let s = "";
  for (let i = 0; i < octets.length; i += 0x8000) s += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(s);
}
async function base64VersTexte(b64) {
  const octets = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
  const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(flux).text();
}
