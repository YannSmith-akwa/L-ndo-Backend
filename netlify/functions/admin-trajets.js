const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');
const { enregistrerAudit } = require('./_lib/audit');

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

  // Ajouter/modifier/supprimer un trajet reste réservé au super_admin
  // (voir matrice de droits : "ajouter, modifier ou supprimer des
  // trajets" est explicitement hors de portée du comptable). La
  // lecture (GET), elle, reste ouverte à tout compte admin authentifié
  // — comptable et support_client ont tous deux besoin de voir les
  // trajets pour leur travail.
  const acces = accesAdmin(event, ['comptable', 'support_client']);
  if (!acces) return erreur(401, 'Accès administrateur requis.');
  if (event.httpMethod !== 'GET' && acces.role !== 'super_admin') {
    return erreur(403, 'Réservé au super administrateur.');
  }

  const sql = getSql();

  try {
    if (event.httpMethod === 'GET') {
      const trajets = await sql(
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
        const [t] = await sql(
          `insert into trajets (agence_id, depart, arrivee, heure, capacite)
           values ($1, $2, $3, $4, $5)
           returning id`,
          [body.agence_id, body.depart.trim(), body.arrivee.trim(), body.heure.trim(), places]
        );
        await enregistrerAudit(sql, event, {
          acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
          action: 'trajet.creer', cibleType: 'trajet', cibleId: t.id,
          details: { agenceId: body.agence_id, depart: body.depart.trim(), arrivee: body.arrivee.trim(), heure: body.heure.trim(), places },
        });
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
      const [t] = await sql(`update trajets set ${champs.join(', ')} where id = $${valeurs.length} returning id`, valeurs);
      if (!t) return erreur(404, 'Trajet introuvable.');
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'trajet.modifier', cibleType: 'trajet', cibleId: t.id,
        details: { heure: body.heure, places: body.places },
      });
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      try {
        const [t] = await sql('delete from trajets where id = $1 returning id', [id]);
        if (!t) return erreur(404, 'Trajet introuvable.');
        await enregistrerAudit(sql, event, {
          acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
          action: 'trajet.supprimer', cibleType: 'trajet', cibleId: t.id,
        });
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
