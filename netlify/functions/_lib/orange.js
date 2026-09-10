// Orange Money Web Payment / M Payment API.
// Portail : https://developer.orange.com/apis/om-webpay
//
// ⚠️ Correctif structurel (voir audit, point 1.5) : la documentation
// publique d'Orange Money Web Payment décrit un flux PAR REDIRECTION,
// pas un "push" USSD déclenché uniquement par un numéro de téléphone
// comme MTN. L'appel d'initialisation doit inclure return_url,
// cancel_url et notif_url, et la réponse contient un payment_url (+ un
// pay_token) vers lequel le CLIENT doit être redirigé pour saisir son
// code confidentiel — la version précédente de ce fichier n'envoyait
// aucun de ces trois champs et ignorait entièrement la réponse, ce qui
// rendait le paiement Orange impossible à finaliser quel que soit le
// nom exact des champs.
//
// Je n'ai toujours pas de compte marchand Orange Cameroun réel pour
// tester ces appels. Les noms de champs ci-dessous ont depuis été
// recoupés avec plusieurs implémentations open-source indépendantes
// (voir commentaires dans initierPaiement/verifierStatut) plutôt que
// construits à partir de la seule doc publique — ça augmente la
// confiance mais ne remplace pas un vrai test. Ne pas déployer en
// production sans avoir comparé ce fichier à la doc fournie par votre
// contact Orange, et sans avoir testé le flux complet (redirection →
// saisie PIN → retour) en sandbox.

function avecTimeout(ms = 9000) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), ms);
  return { signal: controleur.signal, annuler: () => clearTimeout(minuteur) };
}

async function obtenirToken() {
  const { ORANGE_BASE_URL, ORANGE_CLIENT_ID, ORANGE_CLIENT_SECRET } = process.env;
  if (!ORANGE_BASE_URL || !ORANGE_CLIENT_ID || !ORANGE_CLIENT_SECRET) throw new Error('ORANGE_NON_CONFIGURE');
  const identifiants = Buffer.from(`${ORANGE_CLIENT_ID}:${ORANGE_CLIENT_SECRET}`).toString('base64');
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    res = await fetch(`${ORANGE_BASE_URL}/oauth/v3/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${identifiants}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal,
    });
  } finally {
    annuler();
  }
  if (!res.ok) throw new Error(`ORANGE_TOKEN_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.access_token;
}

// referenceOperateur : notre référence interne, envoyée comme order_id.
// Retourne { paymentUrl, payToken } — l'appelant (paiement-initier.js)
// doit stocker payToken (nécessaire à verifierStatut ci-dessous) ET
// renvoyer paymentUrl au client, qui doit alors ouvrir cette page pour
// que l'utilisateur y saisisse son code confidentiel Orange Money.
// Contrairement à MTN, il n'y a PAS de prompt automatique sur le
// téléphone : sans ouvrir paymentUrl, le paiement ne peut pas aboutir.
async function initierPaiement({ referenceOperateur, montant, note }) {
  const { ORANGE_BASE_URL, ORANGE_MERCHANT_KEY, ORANGE_RETURN_URL, ORANGE_CANCEL_URL, ORANGE_NOTIF_URL } = process.env;
  if (!ORANGE_BASE_URL || !ORANGE_MERCHANT_KEY || !ORANGE_RETURN_URL || !ORANGE_CANCEL_URL || !ORANGE_NOTIF_URL) {
    throw new Error('ORANGE_NON_CONFIGURE');
  }
  const token = await obtenirToken();
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    // Endpoint et noms de champs confirmés par plusieurs implémentations
    // open-source indépendantes (mêmes noms de champs que ci-dessous —
    // voir verifierStatut plus bas pour le détail des sources). Un point
    // reste incertain : ces mêmes sources utilisent toutes 'OUV' comme
    // valeur de currency plutôt que 'XAF' (le vrai code ISO du F CFA
    // centrafricain) — 'OUV' pourrait être une valeur spécifique au
    // bac à sable Orange plutôt qu'à la production. Je garde 'XAF' ici
    // (cohérent avec un vrai marchand Cameroun) mais si le premier test
    // en sandbox échoue précisément sur ce champ, essayer 'OUV'.
    res = await fetch(`${ORANGE_BASE_URL}/orange-money-webpay/cm/v1/webpayment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: ORANGE_MERCHANT_KEY,
        currency: 'XAF',
        order_id: referenceOperateur,
        amount: montant,
        return_url: ORANGE_RETURN_URL,
        cancel_url: ORANGE_CANCEL_URL,
        notif_url: ORANGE_NOTIF_URL,
        lang: 'fr',
        reference: note || 'Réservation Lōndo',
      }),
      signal,
    });
  } finally {
    annuler();
  }
  if (!res.ok) throw new Error(`ORANGE_INITIATION_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.payment_url || !data.pay_token) throw new Error('ORANGE_REPONSE_INATTENDUE');
  return { paymentUrl: data.payment_url, payToken: data.pay_token };
}

// Retourne 'payé' | 'en_attente' | 'echoue'.
// payToken : celui renvoyé par initierPaiement, stocké sur la
// réservation (reservations.jeton_operateur) — sans lui, le contrôle
// de statut échoue systématiquement côté Orange.
//
// ⚠️ Corrigé sur la base de plusieurs implémentations open-source
// indépendantes et concordantes (ex. github.com/Ibracilinks/OrangeMoney,
// packagist foris-master/orange-money-sdk) : cet endpoint attend un
// **POST** avec un corps **JSON** {order_id, amount, pay_token} — la
// version précédente envoyait un GET avec ces mêmes champs en query
// string (+ merchant_key, absent de ces implémentations de référence,
// qui ne l'utilisent que pour l'initiation). Ces sources concordent
// entre elles mais restent non officielles et non testées ici avec de
// vrais identifiants marchand — à vérifier malgré tout en sandbox réel
// avant la mise en production (voir README).
async function verifierStatut({ referenceOperateur, payToken, montant }) {
  const { ORANGE_BASE_URL, ORANGE_MERCHANT_KEY } = process.env;
  if (!ORANGE_BASE_URL || !ORANGE_MERCHANT_KEY) throw new Error('ORANGE_NON_CONFIGURE');
  if (!payToken) throw new Error('ORANGE_PAY_TOKEN_MANQUANT');
  const token = await obtenirToken();
  const { signal, annuler } = avecTimeout();
  let res;
  try {
    res = await fetch(`${ORANGE_BASE_URL}/orange-money-webpay/cm/v1/transactionstatus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: referenceOperateur,
        amount: montant,
        pay_token: payToken,
      }),
      signal,
    });
  } finally {
    annuler();
  }
  if (!res.ok) throw new Error(`ORANGE_STATUT_ECHEC (${res.status}) ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (data.status === 'SUCCESS') return 'payé';
  if (data.status === 'FAILED' || data.status === 'EXPIRED') return 'echoue';
  return 'en_attente';
}

module.exports = { initierPaiement, verifierStatut };
