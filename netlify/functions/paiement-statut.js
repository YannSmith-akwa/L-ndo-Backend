const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const reference = event.queryStringParameters?.reference;
  if (!reference) return erreur(400, 'reference requise.');

  try {
    const sql = getSql();
    const [reservation] = await sql(
      'select id, statut, mode_paiement as "modePaiement", reference_operateur as "referenceOperateur" from reservations where reference = $1',
      [reference]
    );
    if (!reservation) return erreur(404, 'Réservation introuvable.');

    // Déjà connu en base (payé ou définitivement échoué) : pas besoin
    // de rappeler l'opérateur, on répond directement.
    if (reservation.statut === 'payé' || reservation.statut === 'echoue') {
      return json(200, { statut: reservation.statut });
    }
    if (!reservation.referenceOperateur) {
      // Paiement pas encore initié côté opérateur.
      return json(200, { statut: 'en_attente' });
    }

    const client = reservation.modePaiement === 'mtn_momo' ? momo : orange;
    const statut = await client.verifierStatut(reservation.referenceOperateur);

    if (statut !== reservation.statut) {
      await sql('update reservations set statut = $1 where id = $2', [statut, reservation.id]);
      // Si le paiement a échoué (PIN refusé, solde insuffisant...), on
      // libère les places réservées lors de la création — sinon elles
      // resteraient bloquées indéfiniment pour rien.
      if (statut === 'echoue') {
        await sql(
          `update trajets set places = places + r.nb_voyageurs
           from reservations r where trajets.id = r.trajet_id and r.id = $1`,
          [reservation.id]
        );
      }
    }

    return json(200, { statut });
  } catch (err) {
    console.error('GET /paiement/statut', err);
    return erreur(502, 'Impossible de vérifier le statut auprès de l\u2019opérateur.');
  }
};
