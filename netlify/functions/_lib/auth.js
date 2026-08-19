// Jeton de session émis après vérification OTP réussie (otp-verifier.js)
// et exigé sur les endpoints qui créent une réservation ou déclenchent
// un paiement (reservations.js, paiement-initier.js).
//
// Avant ce module, otp-verifier.js renvoyait juste { telephone } sans
// aucun jeton : rien ne prouvait, côté serveur, qu'un appelant avait
// réellement vérifié un code — n'importe qui pouvait appeler
// /reservations avec le numéro de son choix (voir audit, point 1.2).
//
// JWT (HS256) plutôt qu'un schéma "maison" : format standard, largement
// audité, une seule dépendance (jsonwebtoken, déjà ajoutée à
// package.json) plutôt qu'une implémentation HMAC à la main.
//
// Durée de vie volontairement longue (180 jours) : le client actuel
// n'a pas de mécanisme de rafraîchissement de session (voir le
// commentaire "Pas d'expiration ni de token de session ici" dans
// App-26-1-7-2-corrige.js) — à la place, il redemande simplement un
// nouveau code OTP si le jeton stocké a expiré ou est absent.
//
// Ce module gère aussi les jetons des comptes agence (back-office),
// plus bas — même mécanisme JWT, claim `type` différent pour que les
// deux ne soient jamais interchangeables.

const jwt = require('jsonwebtoken');

function secret() {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s) throw new Error('AUTH_JWT_SECRET non configurée (voir .env.example).');
  return s;
}

// À appeler juste après succès de la vérification Twilio, avec le
// numéro déjà normalisé en E.164 (voir _lib/telephone.js).
function creerJeton(telephoneE164) {
  return jwt.sign({ tel: telephoneE164, type: 'client' }, secret(), { expiresIn: '180d' });
}

// Extrait et vérifie le jeton porté par l'en-tête Authorization: Bearer.
// Retourne le numéro E.164 authentifié, ou null si absent/invalide/expiré
// (à charge de l'appelant de répondre 401 dans ce cas).
function telephoneAuthentifie(event) {
  const entete = event.headers?.authorization || event.headers?.Authorization || '';
  const correspondance = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!correspondance) return null;
  try {
    const payload = jwt.verify(correspondance[1], secret());
    if (payload.type !== 'client' || !payload.tel) return null;
    return payload.tel;
  } catch {
    return null;
  }
}

// ── Comptes agence (back-office) ──
// Un jeton distinct de celui des clients (claim `type: 'agence'`
// explicite) : même s'il partage le même secret de signature, un jeton
// client ne peut jamais être accepté comme jeton agence et vice versa —
// chacun est rejeté par la vérification de l'autre type dès la première
// étape, avant même de regarder le reste du contenu.
// Émis par agence-connexion.js après vérification identifiant/mot de
// passe, exigé par agence-reservations.js et agence-trajets.js.
function creerJetonAgence(agenceId) {
  return jwt.sign({ agenceId, type: 'agence' }, secret(), { expiresIn: '30d' });
}

// Retourne l'agence_id authentifié, ou null si absent/invalide/expiré.
function agenceAuthentifiee(event) {
  const entete = event.headers?.authorization || event.headers?.Authorization || '';
  const correspondance = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!correspondance) return null;
  try {
    const payload = jwt.verify(correspondance[1], secret());
    if (payload.type !== 'agence' || !payload.agenceId) return null;
    return payload.agenceId;
  } catch {
    return null;
  }
}

module.exports = { creerJeton, telephoneAuthentifie, creerJetonAgence, agenceAuthentifiee };
