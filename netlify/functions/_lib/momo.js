// MTN MoMo Collections API ("Request to Pay").
// Portail : https://momodeveloper.mtn.com
// Sandbox : https://sandbox.momodeveloper.mtn.com
//
// Prérequis avant que ce module fonctionne (voir .env.example) :
//   1. Créer un compte sur momodeveloper.mtn.com, s'abonner au produit
//      "Collections" → récupère MOMO_SUBSCRIPTION_KEY.
//   2. Créer un "API User" (POST /v1_0/apiuser) puis une "API Key" pour
//      cet utilisateur → MOMO_API_USER / MOMO_API_KEY.
//   3. Passer en production (momodeveloper.mtn.com, sans "sandbox.")
//      une fois le compte marchand validé par MTN Cameroun.
//
// Le flux ci-dessous (obtenir un token, puis POST requesttopay, puis
// GET son statut) est le flux standard documenté par MTN ; les valeurs
// exactes de MOMO_TARGET_ENVIRONMENT pour la production Cameroun sont
// à confirmer avec votre contact MTN au moment de l'activation.

function baseHeaders() {
  const { MOMO_SUBSCRIPTION_KEY, MOMO_TARGET_ENVIRONMENT } = process.env;
  if (!MOMO_SUBSCRIPTION_KEY) throw new Error('MOMO_NON_CONFIGURE');
  return {
    'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
    'X-Target-Environment': MOMO_TARGET_ENVIRONMENT || 'sandbox',
    'Content-Type': 'application/json',
  };
}

async function obtenirToken() {
  const { MOMO_BASE_URL, MOMO_API_USER, MOMO_API_KEY, MOMO_SUBSCRIPTION_KEY } = process.env;
  if (!MOMO_API_USER || !MOMO_API_KEY || !MOMO_SUBSCRIPTION_KEY) throw new Error('MOMO_NON_CONFIGURE');
  const identifiants = Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString('base64');
  const res = await fetch(`${MOMO_BASE_URL}/collection/token/`, {
    method: 'POST',
    headers: { Authorization: `Basic ${identifiants}`, 'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY },
  });
  if (!res.ok) throw new Error(`MOMO_TOKEN_ECHEC (${res.status})`);
  const data = await res.json();
  return data.access_token;
}

// referenceOperateur : UUID v4 généré par nous, sert d'identifiant unique
// pour cette transaction — c'est lui qu'on réutilise pour vérifier le
// statut ensuite (voir paiement-statut.js).
async function initierPaiement({ referenceOperateur, montant, telephone, note }) {
  const { MOMO_BASE_URL } = process.env;
  const token = await obtenirToken();
  const res = await fetch(`${MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers: { ...baseHeaders(), Authorization: `Bearer ${token}`, 'X-Reference-Id': referenceOperateur },
    body: JSON.stringify({
      amount: String(montant),
      currency: 'XAF',
      externalId: referenceOperateur,
      payer: { partyIdType: 'MSISDN', partyId: telephone.replace(/^\+?237/, '') },
      payerMessage: note || 'Réservation Lōndo',
      payeeNote: note || 'Réservation Lōndo',
    }),
  });
  // 202 Accepted = requête bien reçue, statut encore "PENDING" (le
  // client doit valider par PIN) — ce n'est PAS encore une confirmation.
  if (res.status !== 202) throw new Error(`MOMO_INITIATION_ECHEC (${res.status})`);
}

// Retourne 'payé' | 'en_attente' | 'echoue' — traduit directement le
// statut MTN (SUCCESSFUL / PENDING / FAILED) dans le vocabulaire déjà
// utilisé par le client React Native.
async function verifierStatut(referenceOperateur) {
  const { MOMO_BASE_URL } = process.env;
  const token = await obtenirToken();
  const res = await fetch(`${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceOperateur}`, {
    headers: { ...baseHeaders(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`MOMO_STATUT_ECHEC (${res.status})`);
  const data = await res.json();
  if (data.status === 'SUCCESSFUL') return 'payé';
  if (data.status === 'FAILED') return 'echoue';
  return 'en_attente';
}

module.exports = { initierPaiement, verifierStatut };
