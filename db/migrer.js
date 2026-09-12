// Applique db/schema.sql sur la base pointée par DATABASE_URL.
// Usage : npm run migrate  (après avoir rempli .env)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL manquant — copiez .env.example vers .env et remplissez-le.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // neon() n'exécute qu'une requête à la fois : on découpe sur les ";"
  // en fin de ligne (suffisant pour ce schéma, pas de ";" dans les valeurs).
  // Les lignes de commentaire ("-- ...") sont ignorées avant la découpe
  // pour ne pas envoyer d'instructions vides (le bloc de migration en
  // bas de schema.sql est entièrement commenté, volontairement, pour ne
  // jamais s'exécuter automatiquement).
  const instructions = schema
    .split('\n')
    .filter(ligne => !ligne.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const instruction of instructions) {
    // sql(...) et non sql.query(...) : ce dernier n'existe qu'à partir de
    // la version 1.0 de @neondatabase/serverless. package.json fixe
    // "^0.10.4" — sql(...) est la forme correcte pour cette version.
    // Voir _lib/db.js pour le détail.
    await sql(instruction);
  }
  console.log(`Schéma appliqué : ${instructions.length} instructions exécutées.`);
}

main().catch(err => { console.error(err); process.exit(1); });
