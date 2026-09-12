// Autorisation du back-office — RBAC 12/09/2026.
//
// Gère la transition entre l'ancien ADMIN_TOKEN unique (une variable
// d'environnement, aucune identité individuelle) et les nouveaux
// comptes utilisateurs_admin (identifiant + mot de passe + rôle), voir
// admin-connexion.js et admin-utilisateurs.js.
//
// ADMIN_TOKEN reste accepté volontairement, pour deux raisons :
//   1. bootstrap — il faut bien un premier accès pour créer le tout
//      premier compte super_admin (admin-utilisateurs.js l'exige) ;
//   2. secours — si tous les comptes individuels sont bloqués (mot de
//      passe perdu, etc.), le jeton reste une porte de secours.
// Un accès par ADMIN_TOKEN est journalisé comme acteur "ADMIN_TOKEN
// (legacy)" plutôt qu'un identifiant réel (voir _lib/audit.js) — ce qui
// n'apporte donc PAS la traçabilité individuelle recherchée : à
// n'utiliser qu'en dépannage, pas au quotidien. Une fois tous les
// administrateurs réels migrés vers un compte individuel, envisager de
// retirer ADMIN_TOKEN complètement (supprimer verifierAdmin et son
// appel ci-dessous).

const { verifierAdmin } = require('./admin');
const { adminAuthentifie } = require('./auth');

// rolesAutorises : rôles suffisants pour l'action demandée, ex.
// ['comptable'] ou [] si réservé au seul super_admin. super_admin passe
// toujours, même absent du tableau (rôle le plus élevé).
// Retourne { type: 'legacy'|'compte', id, identifiant, role } si l'accès
// est autorisé, sinon null (à traiter comme un refus 401/403 par
// l'appelant).
function accesAdmin(event, rolesAutorises) {
  let viaLegacy = false;
  try { viaLegacy = verifierAdmin(event); }
  catch { /* ADMIN_TOKEN non configuré côté serveur — on retombe sur les comptes individuels */ }
  if (viaLegacy) {
    return { type: 'legacy', id: null, identifiant: 'ADMIN_TOKEN (legacy)', role: 'super_admin' };
  }

  const compte = adminAuthentifie(event);
  if (!compte) return null;
  if (compte.role === 'super_admin' || rolesAutorises.includes(compte.role)) {
    return { type: 'compte', id: compte.id, identifiant: compte.identifiant, role: compte.role };
  }
  return null;
}

module.exports = { accesAdmin };
