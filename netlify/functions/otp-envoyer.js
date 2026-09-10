const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { envoyerCode } = require('./_lib/twilio');
const { normaliserTelephoneCM } = require('./_lib/telephone');

// Anti-abus léger : max 5 envois par numéro sur 15 minutes, ET max 5
// envois par IP sur la même fenêtre. Évite qu'un script (ou une erreur
// côté client) déclenche des SMS/WhatsApp payants en boucle — sur un
// seul numéro, mais aussi en ciblant beaucoup de numéros différents
// depuis une même source. Twilio Verify a ses propres protections
// aussi, mais autant ne pas compter uniquement dessus.
//
// ⚠️ Correctif (voir audit, point 2.1) : le numéro est maintenant
// TOUJOURS normalisé en E.164 avant d'être comparé ou stocké. Avant, le
// numéro brut tapé par le client servait tel quel de clé pour ce
// compteur — "677123456", "0677123456" et "+237677123456" désignaient
// le même numéro réel mais comptaient comme trois numéros différents,
// ce qui permettait de contourner la limite en variant simplement le
// format d'un envoi à l'autre.
const FENETRE_MINUTES = 15;
const MAX_ENVOIS = 5;

// x-nf-client-connection-ip : en-tête fournie par Netlify lui-même
// (adresse IP réelle du client, déjà résolue derrière leur proxy) —
// plus fiable que x-forwarded-for, qu'un client pourrait falsifier tant
// que Netlify ne l'a pas déjà nettoyée. Repli sur x-forwarded-for si
// absente (ex. `netlify dev` en local), sinon pas de contrôle par IP
// pour cette requête (on ne bloque jamais faute d'IP disponible — le
// contrôle par numéro reste actif dans tous les cas).
function ipClient(event) {
  const brut = event.headers?.['x-nf-client-connection-ip']
    || event.headers?.['x-forwarded-for']
    || '';
  return brut.split(',')[0].trim() || null;
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { canal } = body;
  const tel = normaliserTelephoneCM(body.telephone);
  if (!tel) return erreur(400, 'Numéro camerounais invalide (9 chiffres, ex : 677 000 000).');
  if (!['sms', 'whatsapp'].includes(canal)) return erreur(400, 'canal invalide (sms ou whatsapp).');
  const ip = ipClient(event);

  try {
    const sql = getSql();

    const [{ count }] = await sql(
      `select count(*)::int as count from otp_tentatives
       where telephone = $1 and cree_le > now() - interval '${FENETRE_MINUTES} minutes'`,
      [tel.e164]
    );
    if (count >= MAX_ENVOIS) {
      return erreur(429, 'Trop de tentatives — réessayez dans quelques minutes.');
    }
    if (ip) {
      const [{ count: countIp }] = await sql(
        `select count(*)::int as count from otp_tentatives
         where ip = $1 and cree_le > now() - interval '${FENETRE_MINUTES} minutes'`,
        [ip]
      );
      if (countIp >= MAX_ENVOIS) {
        return erreur(429, 'Trop de tentatives — réessayez dans quelques minutes.');
      }
    }

    await envoyerCode(tel.e164, canal);
    await sql('insert into otp_tentatives (telephone, ip) values ($1, $2)', [tel.e164, ip]);

    // ⚠️ Pas de "codeDemo" ici, volontairement : ce champ n'existe QUE
    // dans la simulation locale côté client (MODE_DEMO). Un vrai
    // backend ne renvoie jamais le code — ce serait une faille de
    // sécurité qui rendrait toute la vérification inutile.
    return json(200, { ok: true });
  } catch (err) {
    console.error('POST /auth/otp/envoyer', err);
    if (err.message === 'TWILIO_NON_CONFIGURE') {
      return erreur(503, "L'envoi de code n'est pas encore configuré côté serveur.");
    }
    return erreur(502, "Échec de l'envoi du code.");
  }
};
