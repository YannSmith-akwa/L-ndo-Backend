const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  try {
    const sql = getSql();
    const agences = await sql('select id, nom, couleur, couleur_pale as "couleurPale", slogan, tel, note from agences order by id');
    const trajets = await sql('select id, agence_id as "agenceId", depart, arrivee, heure, places from trajets order by agence_id, id');

    const resultat = agences.map(a => ({
      ...a,
      note: a.note !== null ? Number(a.note) : null,
      trajets: trajets.filter(t => t.agenceId === a.id).map(({ agenceId, ...t }) => t),
    }));

    return json(200, { agences: resultat });
  } catch (err) {
    console.error('GET /agences', err);
    return erreur(500, 'Erreur serveur lors du chargement des agences.');
  }
};
