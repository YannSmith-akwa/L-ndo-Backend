// Twilio Verify gère lui-même la génération, l'expiration (10 min par
// défaut) et la vérification des codes — on ne stocke aucun code
// nous-mêmes, ce qui évite une classe entière de bugs/failles.
// Doc : https://www.twilio.com/docs/verify/api
//
// ⚠️ `telephoneE164` doit déjà être normalisé (format "+237677123456")
// par l'appelant via _lib/telephone.js — ce module ne fait plus sa
// propre recomposition d'indicatif : avant, la même logique de
// préfixage existait ici et nulle part ailleurs (otp-envoyer.js
// stockait le numéro brut pour son compteur anti-abus, momo.js ne la
// reprenait pas du tout), ce qui permettait de contourner l'anti-abus
// en variant simplement le format du numéro d'un envoi à l'autre.

function client() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_NON_CONFIGURE');
  }
  // require() différé : évite un crash au chargement du module si les
  // clés ne sont pas encore configurées (dev sans backend complet).
  const twilio = require('twilio');
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// canal: 'sms' | 'whatsapp' — correspond exactement au choix fait côté
// client (EcranAuthTelephone).
async function envoyerCode(telephoneE164, canal) {
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) throw new Error('TWILIO_NON_CONFIGURE');
  const t = client();
  await t.verify.v2.services(serviceSid).verifications.create({
    to: telephoneE164,
    channel: canal === 'whatsapp' ? 'whatsapp' : 'sms',
  });
}

// Retourne true si le code correspond, false sinon (ne lève pas
// d'exception pour un code simplement incorrect — seulement pour une
// vraie erreur de configuration/réseau).
async function verifierCode(telephoneE164, code) {
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) throw new Error('TWILIO_NON_CONFIGURE');
  const t = client();
  const verification = await t.verify.v2.services(serviceSid).verificationChecks.create({
    to: telephoneE164,
    code,
  });
  return verification.status === 'approved';
}

module.exports = { envoyerCode, verifierCode };
