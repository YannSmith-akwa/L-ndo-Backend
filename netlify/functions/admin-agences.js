const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');
const { hacher } = require('./_lib/motDePasse');

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
      const agences = await sql(
        `select id, nom, tel, slogan, note, couleur, couleur_pale as "couleurPale",
                identifiant, (mot_de_passe_hash is not null) as "compteActif"
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
      const [a] = await sql(
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
      const [{ count }] = await sql('select count(*)::int as count from trajets where agence_id = $1', [id]);
      if (count > 0) return erreur(409, `Impossible de supprimer : ${count} trajet(s) encore rattaché(s) à cette agence.`);
      const [a] = await sql('delete from agences where id = $1 returning id', [id]);
      if (!a) return erreur(404, 'Agence introuvable.');
      return json(200, { ok: true });
    }

    // Définit ou réinitialise les identifiants de connexion d'une
    // agence — c'est l'administrateur qui choisit et communique ces
    // identifiants à l'agence, pas d'auto-inscription. Renvoyer
    // motDePasse permet aussi de changer un mot de passe existant
    // (identifiant seul ne suffit pas à se reconnecter).
    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id || !texteValide(body.identifiant, 60) || !texteValide(body.motDePasse, 100)) {
        return erreur(400, 'id, identifiant et motDePasse requis.');
      }
      if (body.motDePasse.length < 8) return erreur(400, 'Le mot de passe doit faire au moins 8 caractères.');
      const hash = await hacher(body.motDePasse);
      try {
        const [a] = await sql(
          'update agences set identifiant = $1, mot_de_passe_hash = $2 where id = $3 returning id',
          [body.identifiant.trim(), hash, body.id]
        );
        if (!a) return erreur(404, 'Agence introuvable.');
        return json(200, { ok: true });
      } catch (err) {
        if (err.code === '23505') return erreur(409, 'Cet identifiant est déjà utilisé par une autre agence.');
        throw err;
      }
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/agences', err);
    return erreur(500, 'Erreur serveur.');
  }
};
