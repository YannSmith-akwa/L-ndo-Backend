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
    // sql.query(...) plutôt que sql(...) : depuis la v1.0 du driver
    // @neondatabase/serverless, appeler la fonction directement avec
    // une chaîne (avec ou sans tableau de paramètres) lève une erreur
    // à l'exécution — seule sql.query(...) reste garantie de fonctionner
    // dans la durée. Voir _lib/db.js pour le détail.
    await sql.query(instruction);
  }
  console.log(`Schéma appliqué : ${instructions.length} instructions exécutées.`);
}

main().catch(err => { console.error(err); process.exit(1); });
