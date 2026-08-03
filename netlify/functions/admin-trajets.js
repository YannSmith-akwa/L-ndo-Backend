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
      const trajets = await sql(
        `select t.id, t.agence_id as "agenceId", a.nom as "agenceNom", t.depart, t.arrivee, t.heure, t.places
         from trajets t join agences a on a.id = t.agence_id
         order by a.nom, t.depart, t.heure`
      );
      return json(200, { trajets });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { agence_id, depart, arrivee, heure, places } = body;
      if (!agence_id || !depart || !arrivee || !heure || places === undefined) {
        return erreur(400, 'Champs manquants (agence_id, depart, arrivee, heure, places).');
      }
      const [trajet] = await sql(
        'insert into trajets (agence_id, depart, arrivee, heure, places) values ($1,$2,$3,$4,$5) returning id',
        [agence_id, depart, arrivee, heure, places]
      );
      return json(200, { id: trajet.id });
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { id, depart, arrivee, heure, places } = body;
      if (!id) return erreur(400, 'id requis.');
      await sql(
        `update trajets set depart = coalesce($2, depart), arrivee = coalesce($3, arrivee),
         heure = coalesce($4, heure), places = coalesce($5, places) where id = $1`,
        [id, depart ?? null, arrivee ?? null, heure ?? null, places ?? null]
      );
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      await sql('delete from trajets where id = $1', [id]);
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('admin-trajets', err);
    return erreur(500, 'Erreur serveur.');
  }
};
