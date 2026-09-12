const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');
const { hacher } = require('./_lib/motDePasse');
const { enregistrerAudit } = require('./_lib/audit');

function texteValide(s, max = 60) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
}
const ROLES_VALIDES = ['super_admin', 'comptable', 'support_client'];

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  // Réservé au super_admin (et à ADMIN_TOKEN pour le tout premier
  // bootstrap, avant qu'aucun compte super_admin n'existe) — c'est ici
  // que sont distribués les rôles, donc la fonctionnalité la plus
  // sensible de tout le RBAC. "Créer de nouveaux accès" est
  // explicitement hors de portée de comptable et support_client (voir
  // la matrice de droits), d'où rolesAutorises = [] : aucun rôle autre
  // que super_admin n'est autorisé ici.
  const acces = accesAdmin(event, []);
  if (!acces) return erreur(401, 'Accès administrateur requis.');
  if (acces.role !== 'super_admin') return erreur(403, 'Réservé au super administrateur.');

  const sql = getSql();

  try {
    if (event.httpMethod === 'GET') {
      const utilisateurs = await sql(
        'select id, identifiant, nom, role, actif, cree_le as "creeLe" from utilisateurs_admin order by identifiant'
      );
      return json(200, { utilisateurs });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!texteValide(body.identifiant) || !texteValide(body.motDePasse, 100) || !ROLES_VALIDES.includes(body.role)) {
        return erreur(400, `identifiant, motDePasse et role (${ROLES_VALIDES.join('/')}) requis.`);
      }
      if (body.motDePasse.length < 8) return erreur(400, 'Le mot de passe doit faire au moins 8 caractères.');
      const hash = await hacher(body.motDePasse);
      try {
        const [u] = await sql(
          'insert into utilisateurs_admin (identifiant, mot_de_passe_hash, nom, role) values ($1, $2, $3, $4) returning id',
          [body.identifiant.trim(), hash, body.nom?.trim() || null, body.role]
        );
        await enregistrerAudit(sql, event, {
          acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
          action: 'utilisateur_admin.creer', cibleType: 'utilisateur_admin', cibleId: u.id,
          details: { identifiant: body.identifiant.trim(), role: body.role },
        });
        return json(201, { id: u.id });
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
      if (body.role !== undefined) {
        if (!ROLES_VALIDES.includes(body.role)) return erreur(400, `role invalide (${ROLES_VALIDES.join('/')}).`);
        champs.push(`role = $${champs.length + 1}`); valeurs.push(body.role); details.role = body.role;
      }
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
      valeurs.push(body.id);
      const [u] = await sql(
        `update utilisateurs_admin set ${champs.join(', ')} where id = $${valeurs.length} returning id`,
        valeurs
      );
      if (!u) return erreur(404, 'Utilisateur introuvable.');
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'utilisateur_admin.modifier', cibleType: 'utilisateur_admin', cibleId: u.id, details,
      });
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      // Empêche un super_admin de se supprimer lui-même par erreur (et
      // de se retrouver bloqué hors du back-office s'il n'a que
      // ADMIN_TOKEN en secours et l'a oublié).
      if (acces.id && String(acces.id) === String(id)) return erreur(400, 'Impossible de supprimer votre propre compte.');
      const [u] = await sql('delete from utilisateurs_admin where id = $1 returning id, identifiant', [id]);
      if (!u) return erreur(404, 'Utilisateur introuvable.');
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'utilisateur_admin.supprimer', cibleType: 'utilisateur_admin', cibleId: u.id,
        details: { identifiant: u.identifiant },
      });
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/utilisateurs', err);
    return erreur(500, 'Erreur serveur.');
  }
};
