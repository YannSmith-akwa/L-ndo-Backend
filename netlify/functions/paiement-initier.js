const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { normaliserTelephoneCM } = require('./_lib/telephone');
const { telephoneAuthentifie } = require('./_lib/auth');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

// Anti double-déclenchement (voir audit, point 2.3) : un double-tap ou
// un retry réseau côté client ne doit pas envoyer un second prompt
// USSD/redirection tant qu'une tentative récente est déjà en cours.
const COOLDOWN_SECONDES = 30;

function genererUuid() {
  // crypto.randomUUID() est disponible nativement (Node 18+, runtime
  // Netlify Functions par défaut) — pas besoin de dépendance externe.
  return require('crypto').randomUUID();
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  const operateur = event.queryStringParameters?.operateur; // 'mtn' | 'orange'
  if (!['mtn', 'orange'].includes(operateur)) return erreur(400, 'Opérateur invalide.');

  // Correctif (voir audit, point 1.2) : sans ceci, n'importe qui
  // connaissant une référence pouvait déclencher un prompt de paiement
  // vers le numéro de son choix pour la réservation de quelqu'un d'autre.
  const telephoneCompte = telephoneAuthentifie(event);
  if (!telephoneCompte) return erreur(401, 'Authentification requise.');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { reference } = body;
  const tel = normaliserTelephoneCM(body.telephone);
  if (!reference || !tel) return erreur(400, 'reference et telephone (valide) requis.');

  try {
    const sql = getSql();
    const [reservation] = await sql(
      `select id, total, statut, telephone_compte, reference_operateur, jeton_operateur, paiement_initie_le
       from reservations where reference = $1`,
      [reference]
    );
    if (!reservation) return erreur(404, 'Réservation introuvable.');
    // Une réservation créée avant ce correctif peut ne pas avoir de
    // telephone_compte : par prudence, on refuse plutôt que d'autoriser
    // un paiement dont on ne peut pas vérifier le propriétaire.
    if (reservation.telephone_compte !== telephoneCompte) return erreur(403, 'Cette réservation ne vous appartient pas.');
    if (reservation.statut === 'payé') return erreur(409, 'Cette réservation est déjà payée.');

    if (reservation.paiement_initie_le) {
      const ecouleSecondes = (Date.now() - new Date(reservation.paiement_initie_le).getTime()) / 1000;
      if (ecouleSecondes < COOLDOWN_SECONDES) {
        return erreur(429, `Un paiement a déjà été initié il y a ${Math.round(ecouleSecondes)}s — patientez avant de réessayer.`);
      }
    }

    const referenceOperateur = genererUuid();
    let reponseSupplementaire = {};

    if (operateur === 'mtn') {
      await momo.initierPaiement({
        referenceOperateur,
        montant: reservation.total,
        telephoneMsisdn: tel.msisdn,
        note: `Lōndo — ${reference}`,
      });
      await sql(
        'update reservations set reference_operateur = $1, paiement_initie_le = now() where id = $2',
        [referenceOperateur, reservation.id]
      );
    } else {
      // Orange Money : flux par redirection (voir _lib/orange.js) — le
      // client doit ouvrir paymentUrl, ce n'est PAS un prompt automatique.
      const { paymentUrl, payToken } = await orange.initierPaiement({
        referenceOperateur,
        montant: reservation.total,
        note: `Lōndo — ${reference}`,
      });
      await sql(
        'update reservations set reference_operateur = $1, jeton_operateur = $2, paiement_initie_le = now() where id = $3',
        [referenceOperateur, payToken, reservation.id]
      );
      reponseSupplementaire = { paymentUrl };
    }

    return json(200, { ok: true, ...reponseSupplementaire });
  } catch (err) {
    console.error('POST /paiement/:operateur/initier', err);
    if (err.message === 'MOMO_NON_CONFIGURE' || err.message === 'ORANGE_NON_CONFIGURE') {
      return erreur(503, "Le paiement mobile n'est pas encore configuré côté serveur.");
    }
    return erreur(502, "Échec de l'initiation du paiement auprès de l'opérateur.");
  }
};
