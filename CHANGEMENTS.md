# Changements apportés — récapitulatif

Ce document résume ce qui a changé par rapport aux fichiers d'origine, et
ce qu'il faut configurer avant de redéployer. Le détail de chaque bug
corrigé (avec fichier + ligne) reste dans `audit-londo-backend.md`.

## 1. Nouvelles variables d'environnement à ajouter

| Variable | Rôle | Exemple |
|---|---|---|
| `AUTH_JWT_SECRET` | Signe les jetons de session émis après OTP | une chaîne aléatoire longue, ex. `openssl rand -hex 32` |
| `ORANGE_RETURN_URL` | Page vers laquelle Orange redirige après paiement réussi | à définir avec votre contact Orange |
| `ORANGE_CANCEL_URL` | Page vers laquelle Orange redirige si l'utilisateur annule | idem |
| `ORANGE_NOTIF_URL` | Webhook serveur-à-serveur d'Orange (notification asynchrone) | idem — non traité par ce lot de correctifs, voir section 4 |
| `ADMIN_TOKEN` | Jeton d'accès au back-office (`londo-backoffice-2.html`) | une chaîne aléatoire longue, ex. `openssl rand -hex 24` |

Sans `AUTH_JWT_SECRET`, `/auth/otp/verifier`, `/reservations` et
`/paiement/*/initier` répondent 503. Sans les trois variables Orange,
`/paiement/orange/initier` répond 503 (MTN continue de fonctionner
indépendamment). Sans `ADMIN_TOKEN`, toutes les routes `/api/admin/*`
répondent 503 (le back-office affiche alors "jeton refusé").

## 2. Base de données

`db/schema.sql` a changé de façon structurelle (nouvelle table `departs`,
`trajets.places` → `trajets.capacite`, `reservations.reduction_fidelite`
supprimée, nouvelles colonnes `jeton_operateur` / `paiement_initie_le`,
nouvelle séquence `reservations_ref_seq`).

- **Base neuve, jamais migrée** : exécutez simplement `npm run migrate`
  (ou collez `schema.sql` dans le SQL Editor de Neon) — rien d'autre à faire.
- **Base déjà en place avec des données réelles** : `schema.sql` ne
  modifiera PAS les tables existantes (`create table if not exists` ne
  touche pas à une table déjà créée). Un bloc de commandes `alter table`
  commenté, prêt à l'emploi, se trouve tout en bas de `schema.sql` — à
  exécuter une fois, manuellement, avant de déployer ce code. C'est
  votre cas (vous avez confirmé que les tables existent déjà) : ce bloc
  inclut aussi une reconstruction du stock `departs` à partir de vos
  réservations existantes (en_attente/payé), pour que les places déjà
  prises par vos données de test restent correctement indisponibles au
  lieu de réapparaître comme libres. Faites une sauvegarde avant de
  l'exécuter.

## 3. Ce qui a été corrigé (voir audit-londo-backend.md pour le détail)

**Backend :**
- 1.1 — places scindées par date (table `departs`)
- 1.2 — authentification par jeton après OTP, exigée sur `/reservations` et `/paiement/*/initier`
- 1.3 — réservation atomique (guarded UPDATE + compensation), fini les lignes orphelines
- 1.4 — nouvelle fonction planifiée `expirer-reservations.js` (toutes les 10 min)
- 1.5 — Orange Money : champs requis ajoutés, `payment_url`/`pay_token` désormais capturés et utilisés
- 1.6 — MTN MoMo : numéro envoyé avec l'indicatif pays (237)
- 2.1 — normalisation téléphone centralisée (`_lib/telephone.js`)
- 2.2 — références générées par séquence (fini les collisions à 5 chiffres aléatoires)
- 2.3 — anti double-déclenchement sur l'initiation de paiement (cooldown 30s)
- 2.4 — recrédit des places rendu atomique (fini le double-comptage)
- 2.6 — `nb_voyageurs` recoupé avec le nombre réel de voyageurs envoyés
- Bonus découvert en cours de correction : tous les appels SQL sont passés
  de `sql(texte, params)` à `sql.query(texte, params)` — la première forme
  lève une erreur à l'exécution depuis la version 1.0 de
  `@neondatabase/serverless` (voir `_lib/db.js`). `package.json` reste
  fixé sur `^0.10.4`, donc ce n'est pas cassé aujourd'hui, mais l'aurait
  été à la prochaine montée de version du driver.

**Fidélité :** entièrement retirée (backend et client) — plus de seuil,
plus de réduction, plus aucune trace dans les traductions, l'écran de
réservation ou le billet.

**Performance :** cache du jeton MTN, timeout sur les appels sortants
MTN/Orange, cache HTTP léger sur `/agences` et `/tarifs`, insertion des
voyageurs regroupée en une seule requête (au lieu d'une boucle), purge
automatique de `otp_tentatives`.

## 4. Back-office admin

Reconstruit à partir de `londo-backoffice-2.html` (que vous m'avez
transmis) et de votre description du projet — je n'avais pas les
fichiers `admin-*.js` originaux, donc ceux livrés ici sont réécrits
directement contre le nouveau schéma plutôt qu'adaptés depuis les
vôtres :
- `_lib/admin.js` — vérifie l'en-tête `X-Admin-Token` (comparaison à
  temps constant) contre `ADMIN_TOKEN`
- `admin-trajets.js`, `admin-agences.js`, `admin-tarifs.js` — CRUD,
  alignés sur `trajets.capacite` (exposé en JSON sous le nom `places`,
  pour que `londo-backoffice-2.html` fonctionne sans aucune modification)
- `admin-reservations.js` — lecture seule (liste les 100 dernières)
- `netlify.toml` — 4 redirections `/api/admin/*` ajoutées (11 au total,
  cohérent avec ce que vous aviez déjà validé)

Le fichier `netlify.toml` que vous m'avez transmis dans cet échange
était en fait celui que je vous avais moi-même livré précédemment (pas
votre version avec les routes admin) — sans conséquence, je les ai
reconstruites à partir de votre description plus haut dans la
conversation.

## 5. Ce qui n'a PAS été traité, et pourquoi

- **2.5 (QR code / anti-rejeu à l'embarquement)** : nécessite de définir
  qui contrôle les billets et avec quelle interface (une colonne
  `embarque_le` seule ne sert à rien sans un endpoint et un écran pour
  la renseigner). Aucun fichier fourni ne couvre ce contrôle — je n'ai
  pas voulu inventer ce flux sans votre validation. Dites-moi comment
  le contrôle est censé se faire et je peux le construire.
- **Webhook Orange (`notif_url`)** : la valeur de la variable d'environnement
  est prévue et transmise à l'initiation, mais aucune fonction ne
  reçoit ce webhook pour l'instant — `paiement-statut.js` continue de
  fonctionner par sondage (polling) côté client, comme pour MTN. Un
  webhook dédié serait plus robuste mais sort du périmètre de cette
  passe de correctifs.
- **Orange Money reste à valider en sandbox réelle** : la structure du
  flux (redirection, `payment_url`, `pay_token`) s'appuie sur la
  documentation publique, pas sur un test contre un compte marchand
  réel — voir les avertissements laissés dans `_lib/orange.js`.

## 6. Fichiers livrés

- `londo-backend-corrige/` — tout le backend (db/, netlify/, netlify.toml, package.json)
- `client/App-26-1-7-2-corrige.js` — le client corrigé (même nom de fichier, à remplacer directement)
- `londo-backoffice-2.html` — inchangé, à redéployer tel quel (aucune modification nécessaire côté HTML)
