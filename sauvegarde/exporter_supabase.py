#!/usr/bin/env python3
"""Sauvegarde FKB2B : exporte les tables « travail humain » de Supabase en JSON.

Usage : SUPABASE_URL=https://xxx.supabase.co python3 exporter_supabase.py DOSSIER
Écrit DOSSIER/<table>.json (une ligne JSON par enregistrement) et DOSSIER/RESUME.md.
La clé service_role n'est PAS lue par le script : dans l'environnement cloud Claude Code, un
« identifiant API » ajoute lui-même les en-têtes `apikey` et `Authorization` aux requêtes vers
l'hôte Supabase (le script ne voit jamais la clé). En local, SUPABASE_SERVICE_KEY peut être
fournie et les en-têtes sont alors envoyés par le script. Les appels passent par curl, qui
respecte le proxy et le certificat de l'environnement.
Les tables ré-importables depuis Fastmag ou Shopify (variantes, tarifs, stocks, photos, ventes)
ne sont pas prises : elles se reconstruisent par un dépôt dans le Centre d'import.
"""
import json, os, sys, subprocess, datetime

TABLES = [
    "societes", "profils", "acces_societes", "adresses",
    "commandes", "commande_lignes", "commandes_journal", "commandes_supprimees", "paniers",
    "campagnes", "campagne_acces", "precommandes", "precommande_categories",
    "precommande_paniers", "precommande_saisie", "precommande_envois",
    "merch_positions", "merch_shopify_suivi", "exclusions_marques", "stock_ajustements", "journal_imports",
]
PAGE = 1000

def lire_page(url, cle, table, debut):
    entetes = ["-H", "Range-Unit: items", "-H", f"Range: {debut}-{debut + PAGE - 1}", "-H", "Prefer: count=exact"]
    if cle:
        entetes += ["-H", f"apikey: {cle}", "-H", f"Authorization: Bearer {cle}"]
    r = subprocess.run(["curl", "-sS", "--fail-with-body", "--max-time", "120", *entetes, f"{url}/rest/v1/{table}?select=*"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stdout or r.stderr).strip()[:300] or f"curl code {r.returncode}")
    return json.loads(r.stdout)

def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    cle = os.environ.get("SUPABASE_SERVICE_KEY", "")   # facultative : absente dans le cloud (proxy d'identifiants)
    if not url:
        print("ERREUR : SUPABASE_URL doit être définie dans l'environnement.", file=sys.stderr)
        sys.exit(2)
    dossier = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(dossier, exist_ok=True)
    resume = [f"# Sauvegarde FKB2B — {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", "", "| Table | Lignes |", "|---|---|"]
    erreurs = 0
    for table in TABLES:
        lignes, debut = [], 0
        try:
            while True:
                page = lire_page(url, cle, table, debut)
                if not isinstance(page, list):
                    raise RuntimeError(f"réponse inattendue : {str(page)[:200]}")
                lignes.extend(page)
                if len(page) < PAGE:
                    break
                debut += PAGE
        except Exception as e:  # HTTP, réseau, JSON…
            print(f"ERREUR {table} : {e}", file=sys.stderr)
            resume.append(f"| {table} | ERREUR {type(e).__name__} |")
            erreurs += 1
            continue
        with open(os.path.join(dossier, f"{table}.json"), "w", encoding="utf-8") as f:
            for l in lignes:
                f.write(json.dumps(l, ensure_ascii=False, sort_keys=True) + "\n")
        resume.append(f"| {table} | {len(lignes)} |")
        print(f"{table}: {len(lignes)} lignes")
    with open(os.path.join(dossier, "RESUME.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(resume) + "\n")
    sys.exit(1 if erreurs else 0)

if __name__ == "__main__":
    main()
