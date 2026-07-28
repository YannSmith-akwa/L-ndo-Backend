# Backend Lōndo

API pour l'app Lōndo — Netlify Functions + Neon (Postgres) + Twilio Verify
(OTP SMS/WhatsApp) + MTN MoMo / Orange Money.

## 1. Base de données (Neon)

1. Créer un compte sur https://neon.tech, créer un projet "londo".
2. Copier la chaîne de connexion (Dashboard > Connection string).
3. `cp .env.example .env` puis coller cette chaîne dans `DATABASE_URL`.
4. Appliquer le schéma :
Ça crée les tables et insère les 2 agences (United Express, Cerise
Express) avec leurs trajets, déjà utilisées côté client.

## 2. Codes OTP (Twilio Verify)

1. Créer un compte sur https://www.twilio.com (offre d'essai gratuite).
2. Dans la Console Twilio : **Verify > Services > Create new Service**
→ donne un `TWILIO_VERIFY_SERVICE_SID`.
3. Récupérer `TWILIO_ACCOUNT_SID` et `TWILIO_AUTH_TOKEN` sur la page
d'accueil de la Console.
4. Remplir ces 3 valeurs dans `.env`.
5. Pour le canal WhatsApp : Twilio propose un numéro sandbox WhatsApp
gratuit pour les tests (Messaging > Try it out > WhatsApp) ; en
production il faut un numéro WhatsApp Business validé par Meta —
démarche séparée à faire quand vous serez prêts à sortir du sandbox.

Tant que ces variables ne sont pas configurées, `/auth/otp/envoyer` et
`/auth/otp/verifier` répondent explicitement `503` (jamais un faux succès).

## 3. Paiement — MTN MoMo

1. Créer un compte sur https://momodeveloper.mtn.com.
2. S'abonner au produit **Collections** → récupère `MOMO_SUBSCRIPTION_KEY`.
3. Créer un "API User" puis une "API Key" pour cet utilisateur (voir
commentaires dans `netlify/functions/_lib/momo.js`) → remplit
`MOMO_API_USER` / `MOMO_API_KEY`.
4. Tester en sandbox (`MOMO_TARGET_ENVIRONMENT=sandbox`,
`MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com`) avec les
numéros de test fournis par MTN.
5. Pour la production : contacter MTN Cameroun pour l'activation
marchande, puis basculer `MOMO_BASE_URL` sur
`https://momodeveloper.mtn.com` et `MOMO_TARGET_ENVIRONMENT` sur la
valeur qu'ils vous communiquent pour le Cameroun.

## 4. Paiement — Orange Money

⚠️ Ce module (`netlify/functions/_lib/orange.js`) est un **squelette** :
je n'ai pas pu vérifier les noms exacts des champs de requête/réponse
dans une documentation publique fiable. Étapes :

1. Devenir marchand Orange Money Cameroun (contact opérateur Orange
local — démarche business, pas seulement technique).
2. Une fois l'accès obtenu, demander la documentation complète de
l'API Web Payment/M Payment (https://developer.orange.com/apis/om-webpay).
3. Comparer chaque endpoint de `orange.js` à cette documentation et
corriger les noms de champs si besoin avant tout déploiement en
production.

## 5. Déploiement sur Netlify

1. Pousser ce dossier sur un repo Git (GitHub/GitLab/Bitbucket).
2. Sur https://app.netlify.com : **Add new site > Import an existing
project**, connecter le repo.
3. Dans **Site configuration > Environment variables**, ajouter
toutes les variables de `.env.example` avec vos vraies valeurs.
4. Déployer. L'API est alors disponible sur
`https://<votre-site>.netlify.app/api/...`
5. Pour utiliser `api.londo.cm` comme dans le client : **Domain
management > Add a custom domain** et pointer le DNS de
`api.londo.cm` vers Netlify.
6. Mettre à jour `API_URL` dans `App.js` (client) si l'URL finale
diffère de `https://api.londo.cm/api`.

## Développement local
Lance l'API en local sur `http://localhost:8888/api/...` — pratique
pour tester avant de déployer (nécessite le `.env` rempli).

## Contrat API (déjà implémenté côté client, App.js)

| Route | Méthode | Description |
|---|---|---|
| `/api/agences` | GET | Liste des agences + leurs trajets |
| `/api/tarifs` | GET | Prix aller simple / AR / commission |
| `/api/reservations` | POST | Crée une réservation (total et fidélité calculés ici) |
| `/api/paiement/{mtn,orange}/initier` | POST | Déclenche le prompt de paiement mobile |
| `/api/paiement/statut/:reference` | GET | Statut du paiement (`en_attente`/`payé`/`echoue`) |
| `/api/auth/otp/envoyer` | POST | Envoie un code par SMS ou WhatsApp |
| `/api/auth/otp/verifier` | POST | Vérifie le code, crée le compte si besoin |
Lance l'API en local sur `http://localhost:8888/api/...` — pratique
pour tester avant de déployer (nécessite le `.env` rempli).

## Contrat API (déjà implémenté côté client, App.js)

| Route | Méthode | Description |
|---|---|---|
| `/api/agences` | GET | Liste des agences + leurs trajets |
| `/api/tarifs` | GET | Prix aller simple / AR / commission |
| `/api/reservations` | POST | Crée une réservation (total et fidélité calculés ici) |
| `/api/paiement/{mtn,orange}/initier` | POST | Déclenche le prompt de paiement mobile |
| `/api/paiement/statut/:reference` | GET | Statut du paiement (`en_attente`/`payé`/`echoue`) |
| `/api/auth/otp/envoyer` | POST | Envoie un code par SMS ou WhatsApp |
| `/api/auth/otp/verifier` | POST | Vérifie le code, crée le compte si besoin |
