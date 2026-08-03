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
      const agences = await sql(
        'select id, nom, couleur, couleur_pale as "couleurPale", slogan, tel, note from agences order by nom'
      );
      return json(200, { agences });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { nom, couleur, couleurPale, slogan, tel, note } = body;
      if (!nom || !couleur || !couleurPale) {
        return erreur(400, 'Champs manquants (nom, couleur, couleurPale requis).');
      }
      const [agence] = await sql(
        'insert into agences (nom, couleur, couleur_pale, slogan, tel, note) values ($1,$2,$3,$4,$5,$6) returning id',
        [nom, couleur, couleurPale, slogan || null, tel || null, note ?? null]
      );
      return json(200, { id: agence.id });
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { id, nom, couleur, couleurPale, slogan, tel, note } = body;
      if (!id) return erreur(400, 'id requis.');
      await sql(
        `update agences set nom = coalesce($2, nom), couleur = coalesce($3, couleur),
         couleur_pale = coalesce($4, couleur_pale), slogan = coalesce($5, slogan),
         tel = coalesce($6, tel), note = coalesce($7, note) where id = $1`,
        [id, nom ?? null, couleur ?? null, couleurPale ?? null, slogan ?? null, tel ?? null, note ?? null]
      );
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      const [{ count: nbTrajets }] = await sql('select count(*)::int as count from trajets where agence_id = $1', [id]);
      if (nbTrajets > 0) {
        return erreur(409, `Impossible de supprimer : ${nbTrajets} trajet(s) encore rattaché(s) à cette agence. Supprimez-les d'abord.`);
      }
      await sql('delete from agences where id = $1', [id]);
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('admin-agences', err);
    return erreur(500, 'Erreur serveur.');
  }
};
