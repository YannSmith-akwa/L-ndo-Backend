const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierCode } = require('./_lib/twilio');
const { normaliserTelephoneCM } = require('./_lib/telephone');
const { creerJeton } = require('./_lib/auth');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { code } = body;
  const tel = normaliserTelephoneCM(body.telephone);
  if (!tel || !code) return erreur(400, 'telephone et code requis.');

  try {
    const valide = await verifierCode(tel.e164, code);
    if (!valide) return erreur(400, 'CODE_INVALIDE');

    // Le compte est créé (ou retrouvé) seulement une fois le numéro
    // réellement vérifié — jamais avant.
    const sql = getSql();
    await sql.query(
      `insert into utilisateurs (telephone) values ($1)
       on conflict (telephone) do nothing`,
      [tel.e164]
    );

    // Correctif (voir audit, point 1.2) : avant, cette réponse ne
    // contenait que { telephone }, sans aucune preuve vérifiable côté
    // serveur — n'importe qui pouvait ensuite appeler /reservations ou
    // /paiement/*/initier avec le numéro de son choix, sans jamais
    // passer par cette vérification. Le jeton ci-dessous est désormais
    // exigé (Authorization: Bearer ...) par ces deux endpoints.
    const jeton = creerJeton(tel.e164);

    return json(200, { telephone: tel.local, jeton });
  } catch (err) {
    console.error('POST /auth/otp/verifier', err);
    if (err.message === 'TWILIO_NON_CONFIGURE') {
      return erreur(503, "La vérification n'est pas encore configurée côté serveur.");
    }
    if (err.message === 'AUTH_JWT_SECRET non configurée (voir .env.example).') {
      return erreur(503, "L'authentification n'est pas encore configurée côté serveur.");
    }
    return erreur(502, 'Échec de la vérification du code.');
  }
};
