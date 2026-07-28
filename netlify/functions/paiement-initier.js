const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { reference, telephone } = body;
  if (!reference || !telephone) return erreur(400, 'reference et telephone requis.');

  try {
    const sql = getSql();
    const [reservation] = await sql('select id, total, statut from reservations where reference = $1', [reference]);
    if (!reservation) return erreur(404, 'Réservation introuvable.');
    if (reservation.statut === 'payé') return erreur(409, 'Cette réservation est déjà payée.');

    const referenceOperateur = genererUuid();
    const client = operateur === 'mtn' ? momo : orange;

    await client.initierPaiement({
      referenceOperateur,
      montant: reservation.total,
      telephone,
      note: `Lōndo — ${reference}`,
    });

    await sql('update reservations set reference_operateur = $1 where id = $2', [referenceOperateur, reservation.id]);

    return json(200, { ok: true });
  } catch (err) {
    console.error('POST /paiement/:operateur/initier', err);
    if (err.message === 'MOMO_NON_CONFIGURE' || err.message === 'ORANGE_NON_CONFIGURE') {
      return erreur(503, "Le paiement mobile n'est pas encore configuré côté serveur.");
    }
    return erreur(502, "Échec de l'initiation du paiement auprès de l'opérateur.");
  }
};
