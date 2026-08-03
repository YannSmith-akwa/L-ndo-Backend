const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  const auth = verifierAdmin(event);
  if (!auth.ok) return erreur(auth.raison === 'ADMIN_NON_CONFIGURE' ? 503 : 401, auth.raison);
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  try {
    const sql = getSql();
    const reservations = await sql(
      `select r.reference, a.nom as "agenceNom", r.date_voyage as "dateVoyage", t.depart, t.arrivee, t.heure,
              r.nom_voyageur_principal as "nomVoyageur", r.telephone_voyageur_principal as "telephoneVoyageur",
              r.nb_voyageurs as "nbVoyageurs", r.type_voyage as "typeVoyage", r.mode_paiement as "modePaiement",
              r.total, r.statut, r.cree_le as "creeLe"
       from reservations r
       join agences a on a.id = r.agence_id
       join trajets t on t.id = r.trajet_id
       order by r.cree_le desc
       limit 200`
    );
    return json(200, { reservations });
  } catch (err) {
    console.error('admin-reservations', err);
    return erreur(500, 'Erreur serveur.');
  }
};
