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
// Durée de vie : 60 jours (réduite depuis 180 le 31/08/2026 — voir
// simulation d'attaque, point « pas de révocation de jeton »). Le
// client n'a pas de mécanisme de rafraîchissement de session (voir le
// commentaire « Pas d'expiration ni de token de session ici » dans
// App-26-1-7-2-corrige.js) — à la place, il redemande simplement un
// nouveau code OTP si le jeton stocké a expiré ou est absent. Un jeton
// volé (téléphone perdu, session copiée) ne peut aujourd'hui être
// invalidé individuellement — seule option, faire tourner
// AUTH_JWT_SECRET, ce qui déconnecte tout le monde d'un coup. 60 jours
// réduit la fenêtre d'exposition d'un facteur 3 sans construire de
// vraie révocation (liste de jetons révoqués + vérification à chaque
// requête, ce qui ajouterait un aller-retour base de données à CHAQUE
// appel authentifié, aujourd'hui purement sans état) — pas justifié
// tant qu'il n'y a pas d'utilisateurs réels pour qui ce risque devient
// concret. À reconstruire en vraie révocation une fois l'app lancée,
// pas avant.
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
  return jwt.sign({ tel: telephoneE164, type: 'client' }, secret(), { expiresIn: '60d' });
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
// Accepte aussi bien un jeton "agence" historique qu'un jeton "employe"
// (voir plus bas) : les deux donnent au minimum le droit de lire/agir
// pour cette agence, ce qui suffit à tous les endpoints qui n'ont pas
// besoin de distinguer les rôles (agence-reservations.js,
// agence-embarquement.js). Les endpoints qui doivent, eux, savoir QUI
// agit et avec quel rôle utilisent identiteAgence() ci-dessous.
function agenceAuthentifiee(event) {
  const entete = event.headers?.authorization || event.headers?.Authorization || '';
  const correspondance = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!correspondance) return null;
  try {
    const payload = jwt.verify(correspondance[1], secret());
    if (payload.type === 'agence' && payload.agenceId) return payload.agenceId;
    if (payload.type === 'employe' && payload.agenceId) return payload.agenceId;
    return null;
  } catch {
    return null;
  }
}

// ── Comptes back-office individuels (utilisateurs_admin) — RBAC 12/09/2026 ──
// Distinct du jeton client et du jeton agence (claim `type: 'admin'`).
// Durée volontairement courte (12h, à comparer aux 60/30 jours des
// jetons client/agence) : un compte back-office peut supprimer des
// agences ou changer des tarifs, la fenêtre d'exposition d'un jeton
// volé doit rester courte, quitte à demander une reconnexion plus
// fréquente. Émis par admin-connexion.js.
function creerJetonAdmin(id, identifiant, role) {
  return jwt.sign({ id, identifiant, role, type: 'admin' }, secret(), { expiresIn: '12h' });
}

// Retourne { id, identifiant, role } ou null si absent/invalide/expiré.
// À combiner avec _lib/rbac.js (accesAdmin) plutôt qu'à appeler
// directement dans un handler, pour garder la coexistence avec
// l'ancien ADMIN_TOKEN à un seul endroit.
function adminAuthentifie(event) {
  const entete = event.headers?.authorization || event.headers?.Authorization || '';
  const correspondance = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!correspondance) return null;
  try {
    const payload = jwt.verify(correspondance[1], secret());
    if (payload.type !== 'admin' || !payload.id || !payload.role) return null;
    return { id: payload.id, identifiant: payload.identifiant, role: payload.role };
  } catch {
    return null;
  }
}

// ── Comptes employé d'agence individuels (employes_agence) — RBAC 12/09/2026 ──
// Claim `type: 'employe'`, distinct du jeton "agence" historique
// (partagé par toute l'équipe). Émis par employe-connexion.js.
function creerJetonEmploye(id, agenceId, identifiant, role) {
  return jwt.sign({ id, agenceId, identifiant, role, type: 'employe' }, secret(), { expiresIn: '30d' });
}

// Donne le détail (rôle, employeId) nécessaire aux endpoints qui
// doivent distinguer les droits à l'intérieur d'une même agence —
// contrairement à agenceAuthentifiee() qui ne renvoie que l'agence_id.
// Retourne :
//   { agenceId, role: 'proprietaire', employeId: null, identifiant: null }
//     pour un jeton agence historique (droits pleins, par compatibilité) ;
//   { agenceId, role: 'chef_agence'|'agent_guichet', employeId, identifiant }
//     pour un jeton employé individuel ;
//   null si absent/invalide/expiré.
function identiteAgence(event) {
  const entete = event.headers?.authorization || event.headers?.Authorization || '';
  const correspondance = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!correspondance) return null;
  try {
    const payload = jwt.verify(correspondance[1], secret());
    if (payload.type === 'agence' && payload.agenceId) {
      return { agenceId: payload.agenceId, role: 'proprietaire', employeId: null, identifiant: null };
    }
    if (payload.type === 'employe' && payload.agenceId && payload.id) {
      return { agenceId: payload.agenceId, role: payload.role, employeId: payload.id, identifiant: payload.identifiant };
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  creerJeton, telephoneAuthentifie,
  creerJetonAgence, agenceAuthentifiee,
  creerJetonAdmin, adminAuthentifie,
  creerJetonEmploye, identiteAgence,
};
