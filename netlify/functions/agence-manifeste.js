const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { identiteAgence } = require('./_lib/auth');

function dateValide(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  // Ouvert à tous les rôles agence, y compris agent_guichet : c'est
  // littéralement l'outil qu'il utilise au pied du bus, au même titre
  // que l'embarquement (voir agence-embarquement.js).
  const identite = identiteAgence(event);
  if (!identite) return erreur(401, 'Authentification agence requise.');
  const agenceId = identite.agenceId;

  const qs = event.queryStringParameters || {};
  const trajetId = Number(qs.trajetId);
  if (!Number.isInteger(trajetId) || trajetId < 1) return erreur(400, 'trajetId requis.');
  if (!dateValide(qs.dateVoyage)) return erreur(400, 'dateVoyage requis (format attendu : AAAA-MM-JJ).');

  try {
    const sql = getSql();

    const [trajet] = await sql(
      `select t.id, t.depart, t.arrivee, t.heure, a.nom as "agenceNom"
       from trajets t
       join agences a on a.id = t.agence_id
       where t.id = $1 and t.agence_id = $2`,
      [trajetId, agenceId]
    );
    if (!trajet) return erreur(404, 'Trajet introuvable pour votre agence.');

    // Ce que dit la conformité routière : la liste des personnes
    // PHYSIQUEMENT PRÉSENTES dans le véhicule (embarque_le renseigné),
    // pas une liste d'intentions d'achat — voir l'échange du 12/09.
    // Un même embarquement valide toute la réservation d'un coup
    // (embarque_le est sur reservations, pas par voyageur individuel),
    // d'où le join vers voyageurs pour éclater chaque nom/pièce.
    const passagers = await sql(
      `select r.reference, r.embarque_le as "embarqueLe",
              v.nom, v.telephone, v.piece_id as "pieceId"
       from reservations r
       join voyageurs v on v.reservation_id = r.id
       where r.trajet_id = $1 and r.date_voyage = $2::date and r.agence_id = $3
         and r.statut = 'payé' and r.embarque_le is not null
       order by r.embarque_le, v.id`,
      [trajetId, qs.dateVoyage, agenceId]
    );

    // Contexte informatif pour l'agent (pas dans le document imprimé) :
    // combien de réservations payées existent sur ce départ au total,
    // pour repérer si des passagers payés n'ont pas encore embarqué au
    // moment de l'impression.
    const [{ totalPayes }] = await sql(
      `select coalesce(sum(nb_voyageurs), 0)::int as "totalPayes"
       from reservations
       where trajet_id = $1 and date_voyage = $2::date and agence_id = $3 and statut = 'payé'`,
      [trajetId, qs.dateVoyage, agenceId]
    );

    return json(200, {
      trajet: { depart: trajet.depart, arrivee: trajet.arrivee, heure: trajet.heure },
      agenceNom: trajet.agenceNom,
      dateVoyage: qs.dateVoyage,
      totalEmbarques: passagers.length,
      totalPayes,
      passagers,
    });
  } catch (err) {
    console.error('/agence/manifeste', err);
    return erreur(500, 'Erreur serveur.');
  }
};
