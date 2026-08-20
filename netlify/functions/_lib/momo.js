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
// ⚠️ partyId (MSISDN) : les exemples officiels MTN MoMo (Ouganda,
// Ghana, Nigeria) utilisent systématiquement le numéro COMPLET avec
// indicatif pays, sans "+" (ex. "233555123456"). La version précédente
// de ce fichier retirait l'indicatif au lieu de l'ajouter, envoyant
// probablement un numéro à 9 chiffres au lieu de 12 — ce qui aurait
// fait échouer 100% des paiements réels. Ce fichier reçoit maintenant
// directement `telephoneMsisdn` (déjà au bon format, "237677123456")
// depuis _lib/telephone.js. À VALIDER EN SANDBOX avant mise en
// production réelle : je n'ai pas pu tester contre l'API MTN Cameroun
// réelle, cette correction s'appuie sur la convention documentée pour
// d'autres pays MTN MoMo, pas sur un test direct.

let jetonCache = null; // { valeur, expireA }

function baseHeaders() {
  const { MOMO_SUBSCRIPTION_KEY, MOMO_TARGET_ENVIRONMENT } = process.env;
  if (!MOMO_SUBSCRIPTION_KEY) throw new Error('MOMO_NON_CONFIGURE');
  return {
    'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY,
    'X-Target-Environment': MOMO_TARGET_ENVIRONMENT || 'sandbox',
    'Content-Type': 'application/json',
  };
}

function avecTimeout(ms = 9000) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), ms);
  return { signal: controleur.signal, annuler: () => clearTimeout(minuteur) };
}

// Les tokens MTN sont valables ~1h (access_expires_in, en secondes).
// Avant ce cache, un nouveau token était redemandé à CHAQUE appel
// (initierPaiement ET verifierStatut) — soit un aller-retour HTTP
// supplémentaire à chaque poll du client (toutes les 6s pendant
// l'attente de paiement). Rafraîchi 60s avant l'expiration réelle par
// prudence.
async function obtenirToken() {
  if (jetonCache && jetonCache.expireA > Date.now()) return jetonCache.valeur;

  const { MOMO_BASE_URL, MOMO_API_USER, MOMO_API_KEY, MOMO_SUBSCRIPTION_KEY } = process.env;
  if (!MOMO_BASE_URL || !MOMO_API_USER || !MOMO_API_KEY || !MOMO_SUBSCRIPTION_KEY) throw new Error('MOMO_NON_CONFIGURE');
  const identifiants = Buffer.from(`${MOMO_API_USER}:${MOMO_API_KEY}`).toString('base64');
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    res = await fetch(`${MOMO_BASE_URL}/collection/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${identifiants}`, 'Ocp-Apim-Subscription-Key': MOMO_SUBSCRIPTION_KEY },
      signal,
    });
  } finally {
    annuler();
  }
  if (!res.ok) throw new Error(`MOMO_TOKEN_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
  const data = await res.json();
  jetonCache = { valeur: data.access_token, expireA: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
  return jetonCache.valeur;
}

// referenceOperateur : UUID v4 généré par nous, sert d'identifiant unique
// pour cette transaction — c'est lui qu'on réutilise pour vérifier le
// statut ensuite (voir paiement-statut.js).
// telephoneMsisdn : numéro complet avec indicatif, sans "+", ex.
// "237677123456" — voir _lib/telephone.js.
async function initierPaiement({ referenceOperateur, montant, telephoneMsisdn, note }) {
  const { MOMO_BASE_URL } = process.env;
  if (!MOMO_BASE_URL) throw new Error('MOMO_NON_CONFIGURE');
  const token = await obtenirToken();
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    res = await fetch(`${MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: { ...baseHeaders(), Authorization: `Bearer ${token}`, 'X-Reference-Id': referenceOperateur },
      body: JSON.stringify({
        amount: String(montant),
        currency: 'XAF',
        externalId: referenceOperateur,
        payer: { partyIdType: 'MSISDN', partyId: telephoneMsisdn },
        payerMessage: note || 'Réservation Lōndo',
        payeeNote: note || 'Réservation Lōndo',
      }),
      signal,
    });
  } finally {
    annuler();
  }
  // 202 Accepted = requête bien reçue, statut encore "PENDING" (le
  // client doit valider par PIN) — ce n'est PAS encore une confirmation.
  if (res.status !== 202) throw new Error(`MOMO_INITIATION_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
}

// Retourne 'payé' | 'en_attente' | 'echoue' — traduit directement le
// statut MTN (SUCCESSFUL / PENDING / FAILED) dans le vocabulaire déjà
// utilisé par le client React Native.
async function verifierStatut(referenceOperateur) {
  const { MOMO_BASE_URL } = process.env;
  if (!MOMO_BASE_URL) throw new Error('MOMO_NON_CONFIGURE');
  const token = await obtenirToken();
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    res = await fetch(`${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceOperateur}`, {
      headers: { ...baseHeaders(), Authorization: `Bearer ${token}` },
      signal,
    });
  } finally {
    annuler();
  }
  if (!res.ok) throw new Error(`MOMO_STATUT_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (data.status === 'SUCCESSFUL') return 'payé';
  if (data.status === 'FAILED') return 'echoue';
  return 'en_attente';
}

module.exports = { initierPaiement, verifierStatut };
