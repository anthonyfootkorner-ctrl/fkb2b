#!/usr/bin/env python3
"""Sauvegarde FKB2B : exporte les tables « travail humain » de Supabase en JSON.

Usage : SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=... python3 exporter_supabase.py DOSSIER
Écrit DOSSIER/<table>.json (une ligne JSON par enregistrement) et DOSSIER/RESUME.md.
Les tables ré-importables depuis Fastmag ou Shopify (variantes, tarifs, stocks, photos, ventes)
ne sont pas prises : elles se reconstruisent par un dépôt dans le Centre d'import.
"""
import json, os, sys, urllib.request, urllib.error, datetime

TABLES = [
    "societes", "profils", "acces_societes", "adresses",
    "commandes", "commande_lignes", "commandes_journal", "commandes_supprimees", "paniers",
    "campagnes", "campagne_acces", "precommandes", "precommande_categories",
    "precommande_paniers", "precommande_saisie", "precommande_envois",
    "merch_positions", "merch_shopify_suivi", "exclusions_marques", "stock_ajustements", "journal_imports",
]
PAGE = 1000

def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    cle = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not cle:
        print("ERREUR : SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définis dans l'environnement.", file=sys.stderr)
        sys.exit(2)
    dossier = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(dossier, exist_ok=True)
    resume = [f"# Sauvegarde FKB2B — {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", "", "| Table | Lignes |", "|---|---|"]
    erreurs = 0
    for table in TABLES:
        lignes, debut = [], 0
        try:
            while True:
                req = urllib.request.Request(f"{url}/rest/v1/{table}?select=*", headers={
                    "apikey": cle, "Authorization": f"Bearer {cle}",
                    "Range-Unit": "items", "Range": f"{debut}-{debut + PAGE - 1}", "Prefer": "count=exact"})
                with urllib.request.urlopen(req, timeout=120) as rep:
                    page = json.loads(rep.read().decode("utf-8"))
                lignes.extend(page)
                if len(page) < PAGE:
                    break
                debut += PAGE
        except urllib.error.HTTPError as e:
            corps = e.read().decode("utf-8", "replace")[:200]
            print(f"ERREUR {table} : HTTP {e.code} {corps}", file=sys.stderr)
            resume.append(f"| {table} | ERREUR HTTP {e.code} |")
            erreurs += 1
            continue
        except Exception as e:  # réseau, JSON…
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
