const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');
const { hacher } = require('./_lib/motDePasse');
const { enregistrerAudit } = require('./_lib/audit');

function texteValide(s, max = 60) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
}
function couleurValide(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  // Lecture (GET) ouverte au comptable, en plus du super_admin, pour la
  // configuration de la commission par agence. Créer/renommer/supprimer
  // une agence ou (re)définir ses identifiants de connexion reste
  // réservé au super_admin (voir les gardes ci-dessous sur chaque
  // méthode) — "créer de nouveaux accès agences" est explicitement
  // hors de portée du comptable dans la matrice de droits.
  const acces = accesAdmin(event, ['comptable']);
  if (!acces) return erreur(401, 'Accès administrateur requis.');

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

    // Créer/supprimer une agence ou (re)définir ses identifiants reste
    // réservé au super_admin — d'où la vérification systématique
    // ci-dessous sur chacune de ces trois méthodes (le GET plus haut,
    // lui, admet aussi le comptable).
    if (event.httpMethod === 'POST') {
      if (acces.role !== 'super_admin') return erreur(403, 'Réservé au super administrateur.');
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
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'agence.creer', cibleType: 'agence', cibleId: a.id, details: { nom: body.nom.trim() },
      });
      return json(201, { id: a.id });
    }

    if (event.httpMethod === 'DELETE') {
      if (acces.role !== 'super_admin') return erreur(403, 'Réservé au super administrateur.');
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      // Garde explicite (en plus de la contrainte de clé étrangère) pour
      // renvoyer un message clair plutôt qu'une erreur SQL brute.
      const [{ count }] = await sql('select count(*)::int as count from trajets where agence_id = $1', [id]);
      if (count > 0) return erreur(409, `Impossible de supprimer : ${count} trajet(s) encore rattaché(s) à cette agence.`);
      const [a] = await sql('delete from agences where id = $1 returning id, nom', [id]);
      if (!a) return erreur(404, 'Agence introuvable.');
      await enregistrerAudit(sql, event, {
        acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
        action: 'agence.supprimer', cibleType: 'agence', cibleId: a.id, details: { nom: a.nom },
      });
      return json(200, { ok: true });
    }

    // Définit ou réinitialise les identifiants de connexion d'une
    // agence — c'est l'administrateur qui choisit et communique ces
    // identifiants à l'agence, pas d'auto-inscription. Renvoyer
    // motDePasse permet aussi de changer un mot de passe existant
    // (identifiant seul ne suffit pas à se reconnecter).
    if (event.httpMethod === 'PUT') {
      if (acces.role !== 'super_admin') return erreur(403, 'Réservé au super administrateur.');
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
        await enregistrerAudit(sql, event, {
          acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role,
          action: 'agence.definir_identifiants', cibleType: 'agence', cibleId: a.id,
          details: { identifiant: body.identifiant.trim() },
        });
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
