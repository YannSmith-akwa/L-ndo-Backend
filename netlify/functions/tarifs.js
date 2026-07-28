const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  try {
    const sql = getSql();
    const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
    if (!t) return erreur(404, 'Tarifs non configurés.');
    return json(200, t);
  } catch (err) {
    console.error('GET /tarifs', err);
    return erreur(500, 'Erreur serveur lors du chargement des tarifs.');
  }
};
