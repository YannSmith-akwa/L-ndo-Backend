const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

// Le back-office parle de "places" (nombre de sièges du trajet), ce qui
// correspond exactement à trajets.capacite dans le nouveau schéma (la
// capacité NOMINALE du trajet — pas le stock du jour, qui vit dans
// `departs` et n'est géré nulle part ici). On garde le nom "places"
// côté JSON pour ne rien changer à londo-backoffice-2.html.

function heureValide(h) {
  return typeof h === 'string' && /^\d{2}h\d{2}$/.test(h);
}
function texteValide(s) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 60;
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
      const trajets = await sql.query(
        `select t.id, t.agence_id as "agenceId", a.nom as "agenceNom",
                t.depart, t.arrivee, t.heure, t.capacite as places
         from trajets t join agences a on a.id = t.agence_id
         order by a.nom, t.depart, t.heure`
      );
      return json(200, { trajets });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const places = Number(body.places);
      if (!body.agence_id || !texteValide(body.depart) || !texteValide(body.arrivee) || !heureValide(body.heure) || !Number.isInteger(places) || places < 0) {
        return erreur(400, 'Champs invalides (agence_id, depart, arrivee, heure au format 07h30, places entier ≥ 0).');
      }
      try {
        const [t] = await sql.query(
          `insert into trajets (agence_id, depart, arrivee, heure, capacite)
           values ($1, $2, $3, $4, $5)
           returning id`,
          [body.agence_id, body.depart.trim(), body.arrivee.trim(), body.heure.trim(), places]
        );
        return json(201, { id: t.id });
      } catch (err) {
        if (err.code === '23505') return erreur(409, 'Ce trajet (agence, départ, arrivée, heure) existe déjà.');
        if (err.code === '23503') return erreur(404, 'Agence introuvable.');
        throw err;
      }
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) return erreur(400, 'id requis.');
      const champs = [];
      const valeurs = [];
      if (body.heure !== undefined) {
        if (!heureValide(body.heure)) return erreur(400, 'heure invalide (format attendu : 07h30).');
        champs.push(`heure = $${champs.length + 1}`); valeurs.push(body.heure.trim());
      }
      if (body.places !== undefined) {
        const places = Number(body.places);
        if (!Number.isInteger(places) || places < 0) return erreur(400, 'places doit être un entier ≥ 0.');
        champs.push(`capacite = $${champs.length + 1}`); valeurs.push(places);
      }
      if (champs.length === 0) return erreur(400, 'Aucun champ à modifier.');
      valeurs.push(body.id);
      const [t] = await sql.query(`update trajets set ${champs.join(', ')} where id = $${valeurs.length} returning id`, valeurs);
      if (!t) return erreur(404, 'Trajet introuvable.');
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      try {
        const [t] = await sql.query('delete from trajets where id = $1 returning id', [id]);
        if (!t) return erreur(404, 'Trajet introuvable.');
        return json(200, { ok: true });
      } catch (err) {
        // Contrainte de clé étrangère : des réservations existent encore
        // pour ce trajet (reservations.trajet_id n'a pas de cascade,
        // volontairement — supprimer un trajet ne doit jamais faire
        // disparaître silencieusement l'historique des réservations).
        if (err.code === '23503') return erreur(409, 'Impossible de supprimer : des réservations existent encore pour ce trajet.');
        throw err;
      }
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/trajets', err);
    return erreur(500, 'Erreur serveur.');
  }
};
