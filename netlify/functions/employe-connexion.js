const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifier } = require('./_lib/motDePasse');
const { creerJetonEmploye } = require('./_lib/auth');

const FENETRE_MINUTES = 15;
const MAX_ESSAIS = 5;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const identifiant = typeof body.identifiant === 'string' ? body.identifiant.trim() : '';
  const motDePasse = typeof body.motDePasse === 'string' ? body.motDePasse : '';
  if (!identifiant || !motDePasse) return erreur(400, 'identifiant et motDePasse requis.');

  try {
    const sql = getSql();

    const [{ count }] = await sql(
      `select count(*)::int as count from tentatives_connexion
       where identifiant = $1 and cree_le > now() - interval '${FENETRE_MINUTES} minutes'`,
      [identifiant]
    );
    if (count >= MAX_ESSAIS) return erreur(429, 'Trop de tentatives — réessayez dans quelques minutes.');
    await sql('insert into tentatives_connexion (identifiant) values ($1)', [identifiant]);

    const [employe] = await sql(
      `select e.id, e.agence_id as "agenceId", e.mot_de_passe_hash, e.nom, e.role, e.actif,
              a.nom as "agenceNom"
       from employes_agence e
       join agences a on a.id = e.agence_id
       where e.identifiant = $1`,
      [identifiant]
    );

    const valide = await verifier(motDePasse, employe?.mot_de_passe_hash || '$2a$10$invalidsaltinvalidsaltin');
    if (!employe || !employe.actif || !valide) {
      return erreur(401, 'Identifiant ou mot de passe incorrect.');
    }

    const jeton = creerJetonEmploye(employe.id, employe.agenceId, identifiant, employe.role);
    return json(200, {
      jeton,
      employe: {
        id: employe.id, nom: employe.nom, role: employe.role,
        agence: { id: employe.agenceId, nom: employe.agenceNom },
      },
    });
  } catch (err) {
    console.error('POST /employe/connexion', err);
    return erreur(500, 'Erreur serveur.');
  }
};
