const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { identiteAgence } = require('./_lib/auth');
const { enregistrerAudit } = require('./_lib/audit');

function heureValide(h) {
  return typeof h === 'string' && /^\d{2}h\d{2}$/.test(h);
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  const identite = identiteAgence(event);
  if (!identite) return erreur(401, 'Authentification agence requise.');
  const agenceId = identite.agenceId;
  // Modifier l'horaire/la capacité d'un trajet reste réservé au chef
  // d'agence (ou au compte agence historique) — un agent de guichet ne
  // doit pas pouvoir changer l'heure de départ d'un bus depuis son
  // poste, même par erreur (voir matrice de droits).
  if (event.httpMethod === 'PUT' && identite.role === 'agent_guichet') {
    return erreur(403, "Réservé au chef d'agence.");
  }

  const sql = getSql();

  try {
    if (event.httpMethod === 'GET') {
      const trajets = await sql(
        'select id, depart, arrivee, heure, capacite as places from trajets where agence_id = $1 order by depart, heure',
        [agenceId]
      );
      return json(200, { trajets });
    }

    if (event.httpMethod === 'PUT') {
      // Volontairement limité à heure/capacité (voir la discussion sur
      // les droits d'un compte agence) : créer ou supprimer des trajets
      // reste réservé à l'administrateur, pour éviter qu'une agence ne
      // crée par erreur un trajet en double ou ne supprime un trajet
      // qui a un historique de réservations.
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
      valeurs.push(body.id, agenceId);
      // Le WHERE agence_id = $N est ce qui empêche une agence de modifier
      // le trajet d'une autre, même en devinant/essayant un autre id.
      const [t] = await sql(
        `update trajets set ${champs.join(', ')} where id = $${valeurs.length - 1} and agence_id = $${valeurs.length} returning id`,
        valeurs
      );
      if (!t) return erreur(404, 'Trajet introuvable pour votre agence.');
      await enregistrerAudit(sql, event, {
        acteurType: 'agence', acteurId: identite.employeId, acteurIdentifiant: identite.identifiant || `agence#${agenceId}`,
        acteurRole: identite.role, action: 'trajet.modifier', cibleType: 'trajet', cibleId: t.id,
        details: { heure: body.heure, places: body.places },
      });
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/agence/trajets', err);
    return erreur(500, 'Erreur serveur.');
  }
};
