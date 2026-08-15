const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

function texteValide(s, max = 60) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
}
function couleurValide(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  let estAdmin;
  try { estAdmin = verifierAdmin(event); }
  catch { return erreur(503, "L'administration n'est pas encore configurée côté serveur."); }
  if (!estAdmin) return erreur(401, 'Jeton administrateur invalide.');

  const sql = getSql();

  try {
    if (event.httpMethod === 'GET') {
      const agences = await sql.query(
        `select id, nom, tel, slogan, note, couleur, couleur_pale as "couleurPale"
         from agences order by nom`
      );
      return json(200, { agences: agences.map(a => ({ ...a, note: a.note !== null ? Number(a.note) : null })) });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!texteValide(body.nom) || !couleurValide(body.couleur) || !couleurValide(body.couleurPale)) {
        return erreur(400, 'nom et deux couleurs valides (#RRGGBB) requis.');
      }
      if (body.note !== null && body.note !== undefined && (Number(body.note) < 0 || Number(body.note) > 5)) {
        return erreur(400, 'note doit être comprise entre 0 et 5.');
      }
      const [a] = await sql.query(
        `insert into agences (nom, couleur, couleur_pale, slogan, tel, note)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          body.nom.trim(), body.couleur.trim(), body.couleurPale.trim(),
          body.slogan?.trim() || null, body.tel?.trim() || null,
          body.note !== null && body.note !== undefined ? Number(body.note) : null,
        ]
      );
      return json(201, { id: a.id });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      // Garde explicite (en plus de la contrainte de clé étrangère) pour
      // renvoyer un message clair plutôt qu'une erreur SQL brute.
      const [{ count }] = await sql.query('select count(*)::int as count from trajets where agence_id = $1', [id]);
      if (count > 0) return erreur(409, `Impossible de supprimer : ${count} trajet(s) encore rattaché(s) à cette agence.`);
      const [a] = await sql.query('delete from agences where id = $1 returning id', [id]);
      if (!a) return erreur(404, 'Agence introuvable.');
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/agences', err);
    return erreur(500, 'Erreur serveur.');
  }
};
