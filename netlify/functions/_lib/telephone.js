// Normalisation des numéros mobiles camerounais.
//
// Avant ce module, chaque fichier faisait sa propre normalisation
// (ou aucune) : otp-envoyer.js stockait le numéro brut tel que tapé
// par le client pour son compteur anti-abus, momo.js retirait un
// éventuel préfixe +237/237 sans jamais l'ajouter, twilio.js
// recomposait correctement le E.164... Résultat (voir audit) :
// "677123456", "0677123456", "+237677123456" et "237677123456"
// pouvaient être traités comme quatre numéros différents selon le
// fichier, ce qui cassait l'anti-abus OTP et, plus grave, faisait
// probablement échouer les paiements MTN réels (partyId envoyé sans
// indicatif pays). Un seul point de normalisation, utilisé partout.
//
// Ne couvre que les numéros mobiles camerounais (6[5-9]xxxxxxx,
// 9 chiffres locaux) — c'est la seule plage acceptée par le
// formulaire de réservation et par les opérateurs Mobile Money visés.

function normaliserTelephoneCM(brut) {
  if (typeof brut !== 'string') return null;
  const nettoye = brut.replace(/[\s.\-()]/g, '');
  let local;
  if (nettoye.startsWith('+237')) local = nettoye.slice(4);
  else if (nettoye.startsWith('237')) local = nettoye.slice(3);
  else if (nettoye.startsWith('0')) local = nettoye.slice(1);
  else local = nettoye;

  if (!/^6[5-9]\d{7}$/.test(local)) return null;

  return {
    local,                 // "677123456"      — affichage, formulaires
    e164: `+237${local}`,  // "+237677123456"  — Twilio
    msisdn: `237${local}`, // "237677123456"   — partyId MTN MoMo (à vérifier en sandbox, voir README)
  };
}

module.exports = { normaliserTelephoneCM };
