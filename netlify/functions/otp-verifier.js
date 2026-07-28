const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierCode } = require('./_lib/twilio');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { telephone, code } = body;
  if (!telephone || !code) return erreur(400, 'telephone et code requis.');

  try {
    const valide = await verifierCode(telephone, code);
    if (!valide) return erreur(400, 'CODE_INVALIDE');

    // Le compte est créé (ou retrouvé) seulement une fois le numéro
    // réellement vérifié — jamais avant.
    const sql = getSql();
    await sql(
      `insert into utilisateurs (telephone) values ($1)
       on conflict (telephone) do nothing`,
      [telephone]
    );

    return json(200, { telephone });
  } catch (err) {
    console.error('POST /auth/otp/verifier', err);
    if (err.message === 'TWILIO_NON_CONFIGURE') {
      return erreur(503, "La vérification n'est pas encore configurée côté serveur.");
    }
    return erreur(502, 'Échec de la vérification du code.');
  }
};
