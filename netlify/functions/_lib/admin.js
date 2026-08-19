const crypto = require('crypto');

// Comparaison à temps constant : évite qu'un attaquant puisse deviner
// ADMIN_TOKEN caractère par caractère en mesurant le temps de réponse
// d'un simple `===` (peu probable à exploiter ici vu la latence réseau
// naturelle, mais ça ne coûte rien de le faire correctement).
function verifierAdmin(event) {
  const fourni = event.headers?.['x-admin-token'] || event.headers?.['X-Admin-Token'] || '';
  const attendu = process.env.ADMIN_TOKEN;
  if (!attendu) throw new Error('ADMIN_NON_CONFIGURE');
  const a = Buffer.from(String(fourni));
  const b = Buffer.from(String(attendu));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifierAdmin };
