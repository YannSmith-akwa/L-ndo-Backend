const { neon } = require('@neondatabase/serverless');

// Le driver HTTP de Neon ouvre une connexion par requête sans pool
// persistant à gérer — c'est justement ce qu'il faut pour des fonctions
// serverless (chaque invocation Lambda est isolée, un pool classique
// s'épuiserait vite avec beaucoup d'invocations concurrentes).
//
// ⚠️ IMPORTANT — appelez toujours sql(texte, params) dans le code
// appelant, PAS sql.query(texte, params). J'avais introduit sql.query()
// par erreur dans une passe de correctifs précédente, en anticipant à
// tort un changement futur du driver : sql.query() n'existe QUE depuis
// la version 1.0 de @neondatabase/serverless (introduite pour remplacer
// l'ancienne forme sql(texte, params), devenue interdite à partir de
// cette même version 1.0). package.json fixe "^0.10.4", une version
// ANTÉRIEURE à 1.0 — sql.query n'y existe donc pas du tout, et son
// appel lève "sql.query is not a function" à l'exécution (capturé par
// le catch générique de chaque fonction, d'où le "Erreur serveur."
// affiché sans plus de détail). sql(texte, params) reste la forme
// correcte tant que cette version reste fixée à 0.10.x.
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
