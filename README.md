# Backend Lōndo

API pour l'app Lōndo — Netlify Functions + Neon (Postgres) + Twilio Verify
(OTP SMS/WhatsApp) + MTN MoMo / Orange Money.

## 1. Base de données (Neon)

1. Créer un compte sur https://neon.tech, créer un projet "londo".
2. Copier la chaîne de connexion (Dashboard > Connection string).
3. `cp .env.example .env` puis coller cette chaîne dans `DATABASE_URL`.
4. Appliquer le schéma :
