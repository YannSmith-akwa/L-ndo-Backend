const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { identiteAgence } = require('./_lib/auth');
const { hacher } = require('./_lib/motDePasse');
const { enregistrerAudit } = require('./_lib/audit');

function texteValide(s, max = 60) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  const identite = identiteAgence(event);
  if (!identite) return erreur(401, 'Authentification agence requise.');
  // Un agent de guichet ne gère pas les accès de ses collègues — seul
  // le compte agence historique ("proprietaire") ou un chef d'agence le
  // peut, même logique que "créer de nouveaux accès" côté matrice de
  // droits admin.
  if (identite.role === 'agent_guichet') return erreur(403, "Réservé au chef d'agence.");

  const sql = getSql();
  const { agenceId } = identite;
  const acteurIdentifiant = identite.identifiant || `agence#${agenceId}`;

  try {
    if (event.httpMethod === 'GET') {
      const employes = await sql(
        'select id, identifiant, nom, role, actif, cree_le as "creeLe" from employes_agence where agence_id = $1 order by identifiant',
        [agenceId]
      );
      return json(200, { employes });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!texteValide(body.identifiant) || !texteValide(body.motDePasse, 100)) {
        return erreur(400, 'identifiant et motDePasse requis.');
      }
      if (body.motDePasse.length < 8) return erreur(400, 'Le mot de passe doit faire au moins 8 caractères.');
      // Un chef d'agence ne peut créer que des agents de guichet, jamais
      // d'autres chefs d'agence — évite qu'un compte compromis se
      // multiplie tout seul avec les pleins droits sur l'agence.
      const role = 'agent_guichet';
      const hash = await hacher(body.motDePasse);
      try {
        const [e] = await sql(
          'insert into employes_agence (agence_id, identifiant, mot_de_passe_hash, nom, role) values ($1, $2, $3, $4, $5) returning id',
          [agenceId, body.identifiant.trim(), hash, body.nom?.trim() || null, role]
        );
        await enregistrerAudit(sql, event, {
          acteurType: 'agence', acteurId: identite.employeId, acteurIdentifiant, acteurRole: identite.role,
          action: 'employe_agence.creer', cibleType: 'employe_agence', cibleId: e.id,
          details: { identifiant: body.identifiant.trim() },
        });
        return json(201, { id: e.id });
      } catch (err) {
        if (err.code === '23505') return erreur(409, 'Cet identifiant est déjà utilisé.');
        throw err;
      }
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) return erreur(400, 'id requis.');
      const champs = [];
      const valeurs = [];
      const details = {};
      if (body.actif !== undefined) {
        champs.push(`actif = $${champs.length + 1}`); valeurs.push(!!body.actif); details.actif = !!body.actif;
      }
      if (body.motDePasse !== undefined) {
        if (!texteValide(body.motDePasse, 100) || body.motDePasse.length < 8) {
          return erreur(400, 'motDePasse doit faire au moins 8 caractères.');
        }
        const hash = await hacher(body.motDePasse);
        champs.push(`mot_de_passe_hash = $${champs.length + 1}`); valeurs.push(hash); details.motDePasseChange = true;
      }
      if (champs.length === 0) return erreur(400, 'Aucun champ à modifier.');
      valeurs.push(body.id, agenceId);
      // Le WHERE agence_id = $N empêche un chef d'agence de modifier un
      // employé d'une autre agence, même en devinant un autre id.
      const [e] = await sql(
        `update employes_agence set ${champs.join(', ')} where id = $${valeurs.length - 1} and agence_id = $${valeurs.length} returning id`,
        valeurs
      );
      if (!e) return erreur(404, 'Employé introuvable pour votre agence.');
      await enregistrerAudit(sql, event, {
        acteurType: 'agence', acteurId: identite.employeId, acteurIdentifiant, acteurRole: identite.role,
        action: 'employe_agence.modifier', cibleType: 'employe_agence', cibleId: e.id, details,
      });
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      const [e] = await sql('delete from employes_agence where id = $1 and agence_id = $2 returning id, identifiant', [id, agenceId]);
      if (!e) return erreur(404, 'Employé introuvable pour votre agence.');
      await enregistrerAudit(sql, event, {
        acteurType: 'agence', acteurId: identite.employeId, acteurIdentifiant, acteurRole: identite.role,
        action: 'employe_agence.supprimer', cibleType: 'employe_agence', cibleId: e.id,
        details: { identifiant: e.identifiant },
      });
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/agence/employes', err);
    return erreur(500, 'Erreur serveur.');
  }
};
