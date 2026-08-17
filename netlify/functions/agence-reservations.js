const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { agenceAuthentifiee } = require('./_lib/auth');

const LIMITE = 100;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const agenceId = agenceAuthentifiee(event);
  if (!agenceId) return erreur(401, 'Authentification agence requise.');

  try {
    const sql = getSql();
    // Filtré par agence_id dérivé du jeton — jamais par une valeur
    // envoyée dans la requête, pour qu'une agence ne puisse par
    // construction jamais voir les réservations d'une autre (voir la
    // discussion sur la séparation par agence, l'ancien
    // admin-reservations.js reste, lui, volontairement non filtré, pour
    // la vue d'ensemble de l'administrateur uniquement).
    const reservations = await sql(
      `select r.reference, t.depart, t.arrivee, t.heure, r.date_voyage as "dateVoyage",
              r.nom_voyageur_principal as "nomVoyageur", r.nb_voyageurs as "nbVoyageurs",
              r.total, r.statut
       from reservations r
       join trajets t on t.id = r.trajet_id
       where r.agence_id = $1
       order by r.cree_le desc
       limit ${LIMITE}`,
      [agenceId]
    );
    return json(200, { reservations });
  } catch (err) {
    console.error('/agence/reservations', err);
    return erreur(500, 'Erreur serveur.');
  }
};
