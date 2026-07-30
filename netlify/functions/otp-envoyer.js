const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { envoyerCode } = require('./_lib/twilio');

// Anti-abus léger : max 5 envois par numéro sur 15 minutes. Évite qu'un
// script (ou une erreur côté client) déclenche des SMS/WhatsApp payants
// en boucle. Twilio Verify a ses propres protections aussi, mais autant
// ne pas compter uniquement dessus.
const FENETRE_MINUTES = 15;
const MAX_ENVOIS = 5;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { console.log('DIAGNOSTIC otp-envoyer: JSON invalide, body reçu =', event.body); return erreur(400, 'JSON invalide.'); }
  const { telephone, canal } = body;
  console.log('DIAGNOSTIC otp-envoyer: body reçu =', JSON.stringify(body));
  if (!telephone) { console.log('DIAGNOSTIC otp-envoyer: telephone manquant'); return erreur(400, 'telephone requis.'); }
  if (!['sms', 'whatsapp'].includes(canal)) { console.log('DIAGNOSTIC otp-envoyer: canal invalide =', canal); return erreur(400, 'canal invalide (sms ou whatsapp).'); }

  try {
    const sql = getSql();

    const [{ count }] = await sql(
      `select count(*)::int as count from otp_tentatives
       where telephone = $1 and cree_le > now() - interval '${FENETRE_MINUTES} minutes'`,
      [telephone]
    );
    if (count >= MAX_ENVOIS) {
      console.log('DIAGNOSTIC otp-envoyer: limite atteinte, count =', count);
      return erreur(429, 'Trop de tentatives — réessayez dans quelques minutes.');
    }

    console.log('DIAGNOSTIC otp-envoyer: appel de Twilio pour', telephone, canal);
    await envoyerCode(telephone, canal);
    await sql('insert into otp_tentatives (telephone) values ($1)', [telephone]);
    console.log('DIAGNOSTIC otp-envoyer: succès');

    // ⚠️ Pas de "codeDemo" ici, volontairement : ce champ n'existe QUE
    // dans la simulation locale côté client (MODE_DEMO). Un vrai
    // backend ne renvoie jamais le code — ce serait une faille de
    // sécurité qui rendrait toute la vérification inutile.
    return json(200, { ok: true });
  } catch (err) {
    console.error('DIAGNOSTIC otp-envoyer ERREUR:', err.message, err);
    if (err.message === 'TWILIO_NON_CONFIGURE') {
      return erreur(503, "L'envoi de code n'est pas encore configuré côté serveur.");
    }
    return erreur(502, "Échec de l'envoi du code.");
  }
};
