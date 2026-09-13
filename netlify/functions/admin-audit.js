const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');

const LIMITE_DEFAUT = 100;
const LIMITE_MAX = 500;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const acces = accesAdmin(event, []);
  if (!acces) return erreur(401, 'Accès administrateur requis.');
  // Le journal lui-même n'est consultable que par le super_admin : un
  // comptable ou un agent support n'a pas besoin de savoir qui a changé
  // quel tarif ou supprimé quelle agence pour faire son travail, et
  // cette vue expose plus d'informations opérationnelles (adresses IP,
  // deltas avant/après) qu'aucune autre route du back-office.
  if (acces.role !== 'super_admin') return erreur(403, 'Réservé au super administrateur.');

  const qs = event.queryStringParameters || {};
  const clauses = [];
  const valeurs = [];
  if (qs.acteurType) { clauses.push(`acteur_type = $${valeurs.length + 1}`); valeurs.push(qs.acteurType); }
  if (qs.action) { clauses.push(`action = $${valeurs.length + 1}`); valeurs.push(qs.action); }
  if (qs.depuis) { clauses.push(`cree_le >= $${valeurs.length + 1}`); valeurs.push(qs.depuis); }
  if (qs.jusqua) { clauses.push(`cree_le <= $${valeurs.length + 1}`); valeurs.push(qs.jusqua); }
  const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const limite = Math.min(LIMITE_MAX, Math.max(1, Number(qs.limite) || LIMITE_DEFAUT));

  try {
    const sql = getSql();
    const entrees = await sql(
      `select id, acteur_type as "acteurType", acteur_identifiant as "acteurIdentifiant",
              acteur_role as "acteurRole", action, cible_type as "cibleType", cible_id as "cibleId",
              details, ip, cree_le as "creeLe"
       from journal_audit
       ${ou}
       order by cree_le desc
       limit ${limite}`,
      valeurs
    );
    return json(200, { entrees });
  } catch (err) {
    console.error('/admin/audit', err);
    return erreur(500, 'Erreur serveur.');
  }
};
