const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

const LIMITE = 100;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  let estAdmin;
  try { estAdmin = verifierAdmin(event); }
  catch { return erreur(503, "L'administration n'est pas encore configurée côté serveur."); }
  if (!estAdmin) return erreur(401, 'Jeton administrateur invalide.');

  try {
    const sql = getSql();
    // Lecture seule volontairement : ce back-office ne modifie jamais le
    // statut d'une réservation à la main — paiement-statut.js et
    // expirer-reservations.js restent les deux seuls chemins qui touchent
    // reservations.statut, pour ne jamais désynchroniser le stock
    // `departs` d'un changement fait ici sans recrédit correspondant.
    const reservations = await sql(
      `select r.reference, a.nom as "agenceNom", t.depart, t.arrivee,
              r.nom_voyageur_principal as "nomVoyageur", r.total, r.statut
       from reservations r
       join agences a on a.id = r.agence_id
       join trajets t on t.id = r.trajet_id
       order by r.cree_le desc
       limit ${LIMITE}`
    );
    return json(200, { reservations });
  } catch (err) {
    console.error('/admin/reservations', err);
    return erreur(500, 'Erreur serveur.');
  }
};
