const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifierAdmin } = require('./_lib/admin');

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
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/tarifs', err);
    return erreur(500, 'Erreur serveur.');
  }
};
