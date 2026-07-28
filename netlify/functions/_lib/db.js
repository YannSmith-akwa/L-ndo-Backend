const { neon } = require('@neondatabase/serverless');

// Le driver HTTP de Neon ouvre une connexion par requête sans pool
// persistant à gérer — c'est justement ce qu'il faut pour des fonctions
// serverless (chaque invocation Lambda est isolée, un pool classique
// s'épuiserait vite avec beaucoup d'invocations concurrentes).
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
