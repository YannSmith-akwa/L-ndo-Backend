const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');
const { enregistrerAudit } = require('./_lib/audit');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  // Le comptable a explicitement le droit de "configurer la commission
  // de service" dans la matrice de droits — GET et PUT lui sont donc
  // ouverts au même titre qu'au super_admin, contrairement aux trajets
  // et agences.
  const acces = accesAdmin(event, ['comptable']);
  if (!acces) return erreur(401, 'Accès administrateur requis.');

  const sql = getSql();

  try {
    if (event.httpMethod === 'GET') {
      const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
      if (!t) return erreur(404, 'Tarifs non configurés.');
      return json(200, t);
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { prixSimple, prixAr, commission } = body;
      if (![prixSimple, prixAr, commission].every(v => Number.isInteger(v) && v >= 0)) {
        return erreur(400, 'prixSimple, prixAr et commission doivent être des entiers ≥ 0.');
      }
      await sql(
        `insert into tarifs (id, prix_simple, prix_ar, commission) values (1, $1, $2, $3)
         on conflict (id) do update set prix_simple = $1, prix_ar = $2, commission = $3`,
        [prixSimple, prixAr, commission]
      );
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'tarifs.modifier', cibleType: 'tarifs', cibleId: 1,
        details: { prixSimple, prixAr, commission },
      });
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/tarifs', err);
    return erreur(500, 'Erreur serveur.');
  }
};
