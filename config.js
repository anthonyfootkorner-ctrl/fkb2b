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
