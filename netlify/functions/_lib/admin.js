// Vérification du jeton admin — protège les endpoints /api/admin/*.
// Le jeton (ADMIN_TOKEN) est un secret long et aléatoire que VOUS
// choisissez, stocké uniquement en variable d'environnement Netlify —
// jamais dans le code, jamais côté client de façon lisible en clair
// autrement que dans le stockage local du navigateur après connexion.
function verifierAdmin(event) {
  const attendu = process.env.ADMIN_TOKEN;
  if (!attendu) return { ok: false, raison: 'ADMIN_NON_CONFIGURE' };
  const recu = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
  if (!recu || recu !== attendu) return { ok: false, raison: 'NON_AUTORISE' };
  return { ok: true };
}

module.exports = { verifierAdmin };
