# Lōndo — à quoi sert chaque fichier, et comment déployer

D'après ce qu'on avait déjà noté sur le projet, ce backend n'a encore
jamais été déployé (l'API_URL dans le client est toujours un
placeholder) — ce guide part donc d'une mise en production complète
depuis zéro, pas d'une mise à jour d'un système déjà en ligne.

## 1. Architecture en une phrase

Le client (app mobile Expo) parle en HTTPS à des fonctions Netlify
(`/api/...`), qui elles-mêmes parlent à une base Postgres Neon, à
Twilio (SMS), et aux API MTN MoMo / Orange Money.

```
App mobile (Expo) → Netlify Functions → Neon (Postgres)
                                       → Twilio Verify (OTP)
                                       → MTN MoMo / Orange Money
```

## 2. À quoi sert chaque fichier

### Backend — racine

| Fichier | Rôle |
|---|---|
| `package.json` | Dépendances (`@neondatabase/serverless`, `twilio`, `jsonwebtoken`) et le script `npm run migrate` |
| `netlify.toml` | Config Netlify : dossier des fonctions, redirections `/api/...` → fonctions, planification de `expirer-reservations` |
| `db/schema.sql` | Définit toutes les tables. À exécuter une fois sur Neon pour créer la base |
| `db/migrer.js` | Exécute `schema.sql` automatiquement (`npm run migrate`) |
| `index.html` | Page statique de courtoisie servie à la racine du site (aucun rôle fonctionnel) |

### Backend — `netlify/functions/_lib/` (code partagé, pas des endpoints)

| Fichier | Rôle |
|---|---|
| `db.js` | Ouvre la connexion à Neon (une seule fonction `getSql()` réutilisée partout) |
| `reponse.js` | Petits formatteurs de réponse HTTP (JSON, erreurs, CORS) communs à tous les endpoints |
| `telephone.js` | Normalise un numéro camerounais en un seul format, quelle que soit la façon dont il a été tapé |
| `auth.js` | Crée et vérifie le jeton de session émis après un OTP réussi |
| `twilio.js` | Envoie/vérifie les codes OTP via Twilio Verify |
| `momo.js` | Dialogue avec l'API MTN MoMo (jeton, requête de paiement, statut) |
| `orange.js` | Dialogue avec l'API Orange Money (jeton, requête de paiement par redirection, statut) |

### Backend — `netlify/functions/` (les endpoints réels, exposés sous `/api/...`)

| Fichier | Route | Rôle |
|---|---|---|
| `agences.js` | `GET /api/agences` | Liste des agences et de leurs trajets, avec les places disponibles pour une date donnée |
| `tarifs.js` | `GET /api/tarifs` | Prix simple/aller-retour et commission |
| `otp-envoyer.js` | `POST /api/auth/otp/envoyer` | Envoie le code de vérification par SMS/WhatsApp |
| `otp-verifier.js` | `POST /api/auth/otp/verifier` | Vérifie le code et renvoie le jeton de session |
| `reservations.js` | `POST /api/reservations` | Crée une réservation (le cœur de la logique métier) |
| `paiement-initier.js` | `POST /api/paiement/:operateur/initier` | Déclenche le paiement MTN ou Orange |
| `paiement-statut.js` | `GET /api/paiement/statut/:reference` | Interroge le statut d'un paiement en cours |
| `expirer-reservations.js` | (aucune — planifiée toutes les 10 min) | Libère les places des réservations abandonnées, purge les vieux OTP |
| `admin-trajets.js` | `GET/POST/PUT/DELETE /api/admin/trajets` | CRUD trajets pour le back-office (protégé par `ADMIN_TOKEN`) |
| `admin-agences.js` | `GET/POST/DELETE /api/admin/agences` | CRUD agences pour le back-office |
| `admin-tarifs.js` | `GET/PUT /api/admin/tarifs` | Consultation/modification des tarifs pour le back-office |
| `admin-reservations.js` | `GET /api/admin/reservations` | Liste (lecture seule) des 100 dernières réservations |

### Client

| Fichier | Rôle |
|---|---|
| `App-26-1-7-2-corrige.js` | L'app mobile complète (React Native / Expo) — tous les écrans, du choix d'agence au billet final |
| `londo-backoffice-2.html` | Page unique d'administration (trajets, agences, tarifs, réservations) — à héberger séparément (voir Phase 4bis) |

## 3. Étapes pour la mise en production

### Phase 1 — Base de données (Neon)

1. Créer un compte sur [neon.tech](https://neon.tech), créer un projet.
2. Copier la chaîne de connexion (`DATABASE_URL`, commence par `postgres://...`).
3. En local : créer un fichier `.env` à la racine du backend avec `DATABASE_URL=...`, puis lancer `npm install` puis `npm run migrate`.
   - Alternative sans rien installer localement : coller tout le contenu de `db/schema.sql` dans l'onglet **SQL Editor** du tableau de bord Neon et l'exécuter.

### Phase 2 — Comptes opérateurs

- **Twilio** : créer un compte sur [twilio.com](https://twilio.com), créer un service **Verify** → récupérer `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`.
- **MTN MoMo** : créer un compte sur [momodeveloper.mtn.com](https://momodeveloper.mtn.com), s'abonner au produit **Collections** (sandbox pour commencer) → `MOMO_SUBSCRIPTION_KEY`, `MOMO_API_USER`, `MOMO_API_KEY`, `MOMO_BASE_URL` (URL sandbox au début), `MOMO_TARGET_ENVIRONMENT=sandbox`.
- **Orange Money** : contacter votre interlocuteur Orange Cameroun pour un accès marchand (Web Payment) → `ORANGE_CLIENT_ID`, `ORANGE_CLIENT_SECRET`, `ORANGE_MERCHANT_KEY`, `ORANGE_BASE_URL`, et les trois URL `ORANGE_RETURN_URL` / `ORANGE_CANCEL_URL` / `ORANGE_NOTIF_URL` (des pages/endpoints que vous contrôlez — voir Phase 5).
  - ⚠️ Comme déjà signalé, je n'ai pas pu tester `_lib/orange.js` contre un vrai compte marchand — à valider en sandbox avec votre contact Orange avant d'annoncer ce moyen de paiement comme disponible.

### Phase 3 — Variables d'environnement

Toutes les clés ci-dessus, plus :
- `AUTH_JWT_SECRET` — une chaîne aléatoire longue (ex. générée par `openssl rand -hex 32`).
- `ORIGINE_AUTORISEE` — optionnel, restreint le CORS à votre domaine plutôt que `*`.

En local, elles vont dans `.env`. Sur Netlify, elles se configurent dans
**Site settings → Environment variables** (Phase 4).

### Phase 4 — Déployer le backend sur Netlify

1. Pousser le dossier backend (racine avec `netlify.toml`, `package.json`, `db/`, `netlify/`) sur un dépôt Git (GitHub/GitLab).
2. Sur [app.netlify.com](https://app.netlify.com) : **Add new site → Import an existing project**, connecter le dépôt.
3. Dans **Site settings → Environment variables**, ajouter toutes les variables de la Phase 3.
4. Déployer. Netlify lit `netlify.toml` automatiquement (dossier des fonctions, redirections, planification).
5. Vérifier dans l'onglet **Functions** du site que les 8 fonctions apparaissent, et que `expirer-reservations` est bien listée comme planifiée (icône horloge) — les fonctions planifiées consomment simplement des crédits comme les autres, elles fonctionnent sur le plan gratuit, mais ça vaut la peine de confirmer visuellement qu'elle s'est bien enregistrée après le premier déploiement.
6. Noter l'URL du site (ex. `https://meek-strudel-659f09.netlify.app` si c'est le site déjà existant, ou une nouvelle URL sinon).

### Phase 4bis — Héberger le back-office

`londo-backoffice-2.html` est un fichier statique autonome (HTML + JS,
aucune compilation) — le plus simple est de le déposer dans le dossier
`public/` du même site Netlify (à côté d'`index.html`) : il sera alors
accessible à `https://votre-site.netlify.app/londo-backoffice-2.html`.
Vous pouvez aussi le déployer ailleurs (autre site Netlify, hébergement
statique quelconque) tant que la constante `API_URL` en haut de son
`<script>` pointe vers le bon backend. Une fois ouvert, il demande le
jeton `ADMIN_TOKEN` défini en Phase 3 — gardez-le uniquement entre vous,
quiconque le possède peut modifier trajets, tarifs et agences.

### Phase 5 — Pages de retour Orange Money

`ORANGE_RETURN_URL` / `ORANGE_CANCEL_URL` doivent pointer vers des
pages simples ("Paiement terminé, vous pouvez revenir à l'app") — un
fichier HTML statique de plus dans le dossier `public/` du site
Netlify suffit. `ORANGE_NOTIF_URL` est un webhook serveur-à-serveur :
il n'existe pas encore de fonction pour le recevoir dans ce lot de
correctifs (voir `CHANGEMENTS.md`, section 4) — sans elle, le paiement
Orange continue de fonctionner par sondage (polling) côté client, donc
ce n'est pas bloquant, mais la variable doit tout de même être définie
(non vide) pour que `_lib/orange.js` accepte de démarrer.

### Phase 6 — Basculer le client sur la vraie API

Dans `App-26-1-7-2-corrige.js`, `API_URL` lit
`process.env.EXPO_PUBLIC_LONDO_API_URL`, avec comme repli l'URL codée
en dur. Deux options :
- Définir `EXPO_PUBLIC_LONDO_API_URL=https://votre-site.netlify.app/api` dans la config Expo (`.env` ou `eas.json` selon votre configuration de build).
- Ou mettre à jour directement la valeur de repli dans le fichier si vous préférez ne pas gérer de variable d'environnement côté app.

Vérifier aussi que `MODE_DEMO` est bien désactivé pour le build de
production (sinon l'app continue de tout simuler localement, sans
jamais appeler le vrai backend).

### Phase 7 — Tester avant d'ouvrir au public

1. Avec les clés **sandbox** MTN/Orange encore actives, faire une réservation complète de bout en bout depuis l'app (choix trajet → formulaire → paiement → billet).
2. Vérifier dans Neon que les lignes `reservations`, `voyageurs` et `departs` se créent correctement.
3. Tester un paiement qui échoue exprès (sandbox), vérifier que les places sont bien recréditées.
4. Laisser une réservation sans payer, attendre ~20 minutes, vérifier dans les logs Netlify que `expirer-reservations` l'a bien fait passer à `expire` et recrédité les places.
5. Une fois validé, remplacer les clés sandbox par les vraies clés de production MTN/Orange (nouvelles variables d'environnement sur Netlify), et repasser un test réel avec un petit montant.

### Phase 8 — Publier l'app mobile

Ceci dépend de votre configuration Expo/EAS actuelle, que je n'ai pas
sous les yeux — dans les grandes lignes :
1. `eas build` pour générer les binaires iOS/Android (nécessite un compte Expo/EAS).
2. Soumission sur App Store Connect (iOS) et Google Play Console (Android) — comptes développeur payants requis sur les deux (Apple ~99 $/an, Google ~25 $ une fois).
3. Renseigner les métadonnées, captures d'écran, politique de confidentialité (obligatoire vu que l'app collecte un numéro de téléphone et déclenche des paiements).

## 4. Checklist rapide avant l'ouverture au public

- [ ] `npm run migrate` exécuté sur la base Neon de production
- [ ] Toutes les variables d'environnement Phase 3 renseignées sur Netlify
- [ ] `expirer-reservations` visible comme fonction planifiée sur Netlify
- [ ] `EXPO_PUBLIC_LONDO_API_URL` pointe vers le bon site Netlify, `MODE_DEMO` désactivé
- [ ] Réservation + paiement + échec + expiration testés en sandbox
- [ ] Clés MTN/Orange basculées de sandbox à production, retest avec un petit montant réel
- [ ] Contrôle à l'embarquement (QR code) : flux à définir — voir `CHANGEMENTS.md` section 4
