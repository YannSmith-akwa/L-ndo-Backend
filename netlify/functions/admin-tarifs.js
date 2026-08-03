const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  const auth = verifierAdmin(event);
  if (!auth.ok) return erreur(auth.raison === 'ADMIN_NON_CONFIGURE' ? 503 : 401, auth.raison);

  try {
    const sql = getSql();

    if (event.httpMethod === 'GET') {
      const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
      return json(200, t || {});
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { prixSimple, prixAr, commission } = body;
      if (!prixSimple || !prixAr || commission === undefined) {
        return erreur(400, 'Champs manquants (prixSimple, prixAr, commission).');
      }
      await sql(
        'update tarifs set prix_simple = $1, prix_ar = $2, commission = $3 where id = 1',
        [prixSimple, prixAr, commission]
      );
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('admin-tarifs', err);
    return erreur(500, 'Erreur serveur.');
  }
};
