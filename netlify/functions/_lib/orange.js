// Orange Money Web Payment / M Payment API.
// Portail : https://developer.orange.com/apis/om-webpay
//
// ⚠️ Contrairement à momo.js, je n'ai PAS pu vérifier les noms exacts
// des champs de requête/réponse de cette API dans une documentation
// publique fiable — l'accès aux specs détaillées d'Orange Money Web
// Payment nécessite un compte marchand Orange Cameroun validé. Le squelette
// ci-dessous suit le schéma générique OAuth2 + paiement + statut que la
// quasi-totalité des passerelles de paiement utilisent, mais les noms de
// champs (webpayment_url, order_id, etc.) sont à AJUSTER avec la vraie
// documentation fournie par votre contact Orange une fois l'accès obtenu.
// Ne pas déployer en production sans avoir comparé ce fichier à la doc réelle.

async function obtenirToken() {
  const { ORANGE_BASE_URL, ORANGE_CLIENT_ID, ORANGE_CLIENT_SECRET } = process.env;
  if (!ORANGE_CLIENT_ID || !ORANGE_CLIENT_SECRET) throw new Error('ORANGE_NON_CONFIGURE');
  const identifiants = Buffer.from(`${ORANGE_CLIENT_ID}:${ORANGE_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ORANGE_BASE_URL}/oauth/v3/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${identifiants}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`ORANGE_TOKEN_ECHEC (${res.status})`);
  const data = await res.json();
  return data.access_token;
}

// referenceOperateur : notre référence interne, à faire correspondre au
// champ "order_id" (ou équivalent réel) attendu par Orange.
async function initierPaiement({ referenceOperateur, montant, telephone, note }) {
  const { ORANGE_BASE_URL, ORANGE_MERCHANT_KEY } = process.env;
  if (!ORANGE_MERCHANT_KEY) throw new Error('ORANGE_NON_CONFIGURE');
  const token = await obtenirToken();
  // ⚠️ Endpoint et corps de requête À CONFIRMER avec la doc marchand réelle.
  const res = await fetch(`${ORANGE_BASE_URL}/orange-money-webpay/cm/v1/webpayment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      merchant_key: ORANGE_MERCHANT_KEY,
      currency: 'XAF',
      order_id: referenceOperateur,
      amount: montant,
      lang: 'fr',
      reference: note || 'Réservation Lōndo',
    }),
  });
  if (!res.ok) throw new Error(`ORANGE_INITIATION_ECHEC (${res.status})`);
}

// Retourne 'payé' | 'en_attente' | 'echoue'.
async function verifierStatut(referenceOperateur) {
  const { ORANGE_BASE_URL, ORANGE_MERCHANT_KEY } = process.env;
  const token = await obtenirToken();
  // ⚠️ Endpoint À CONFIRMER avec la doc marchand réelle.
  const res = await fetch(`${ORANGE_BASE_URL}/orange-money-webpay/cm/v1/transactionstatus?order_id=${referenceOperateur}&merchant_key=${ORANGE_MERCHANT_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ORANGE_STATUT_ECHEC (${res.status})`);
  const data = await res.json();
  if (data.status === 'SUCCESS') return 'payé';
  if (data.status === 'FAILED' || data.status === 'EXPIRED') return 'echoue';
  return 'en_attente';
}

module.exports = { initierPaiement, verifierStatut };
