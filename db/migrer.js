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
  const instructions = schema
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const instruction of instructions) {
    await sql(instruction);
  }
  console.log(`Schéma appliqué : ${instructions.length} instructions exécutées.`);
}

main().catch(err => { console.error(err); process.exit(1); });
