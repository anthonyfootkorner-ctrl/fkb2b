# Sauvegarde quotidienne FKB2B

`exporter_supabase.py` exporte les tables de travail (commandes, précommandes, paniers, campagnes, comptes, merch)
en JSON, une ligne par enregistrement. Il est lancé chaque nuit par une routine Claude Code (cloud) qui
dépose le résultat dans le dépôt privé `fkb2b-sauvegardes`, un dossier par jour, plus `dernier/`.

Il attend `SUPABASE_URL` en variable d’environnement ; la clé service_role est un « identifiant API » de l’environnement cloud (en-têtes `apikey` et `Authorization: Bearer` injectés par le proxy, jamais visibles) :
`SUPABASE_URL` et `SUPABASE_SERVICE_KEY` (clé service_role du projet).

Restauration : les fichiers sont du JSON lignes ; on recharge une table avec un simple `insert … select from json`.
Les sauvegardes complètes de la base (plan Supabase Pro) restent la première ligne de défense.
