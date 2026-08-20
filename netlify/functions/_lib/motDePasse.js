// bcryptjs plutôt que bcrypt : implémentation 100% JavaScript, sans
// module natif à recompiler — évite les soucis classiques de
// compilation native dans un environnement Lambda/Netlify Functions
// (le binaire natif de bcrypt doit correspondre exactement à l'OS/
// l'architecture du serveur qui l'exécute, ce qui échoue facilement en
// serverless). Le coût en performance est négligeable ici : un hachage
// par connexion, pas un flux à haut débit.

const bcrypt = require('bcryptjs');

const TOURS = 10; // valeur par défaut recommandée par bcrypt, bon compromis coût/sécurité pour ce volume d'utilisation

function hacher(motDePasse) {
  return bcrypt.hash(motDePasse, TOURS);
}

function verifier(motDePasse, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(motDePasse, hash);
}

module.exports = { hacher, verifier };
