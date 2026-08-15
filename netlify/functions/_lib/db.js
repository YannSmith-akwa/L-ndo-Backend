const { neon } = require('@neondatabase/serverless');

// Le driver HTTP de Neon ouvre une connexion par requête sans pool
// persistant à gérer — c'est justement ce qu'il faut pour des fonctions
// serverless (chaque invocation Lambda est isolée, un pool classique
// s'épuiserait vite avec beaucoup d'invocations concurrentes).
//
// ⚠️ Appelez toujours sql.query(texte, params) dans le code appelant —
// jamais sql(texte, params) ni sql(texte) directement. Depuis la
// version 1.0 de @neondatabase/serverless, cette forme lève une erreur
// à l'exécution (elle était auparavant tolérée). package.json fixe
// aujourd'hui "^0.10.4", qui reste sous la 1.0 et n'est donc pas
// affecté tout de suite — mais tout le code de ce projet est écrit
// avec sql.query(...) pour rester valide même après une montée de
// version future du driver.
let sql;
function getSql() {
  if (!sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL non configurée (voir .env.example).');
    }
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

module.exports = { getSql };
