const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifier } = require('./_lib/motDePasse');
const { creerJetonAdmin } = require('./_lib/auth');

// Même anti-abus qu'agence-connexion.js (5 essais / 15 min), sur la
// même table tentatives_connexion — un identifiant admin et un
// identifiant agence ne se confondent pas en pratique, et même s'ils se
// recoupaient, partager le compteur ne poserait aucun problème de
// sécurité (seulement un blocage un peu plus rapide, sans faux négatif).
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

    const [compte] = await sql(
      'select id, identifiant, mot_de_passe_hash, nom, role, actif from utilisateurs_admin where identifiant = $1',
      [identifiant]
    );

    // Même message générique et même bcrypt.compare exécuté que le
    // compte existe ou non (voir agence-connexion.js) : évite qu'une
    // différence de temps de réponse laisse deviner quels identifiants
    // administrateurs existent réellement.
    const valide = await verifier(motDePasse, compte?.mot_de_passe_hash || '$2a$10$invalidsaltinvalidsaltin');
    if (!compte || !compte.actif || !valide) {
      return erreur(401, 'Identifiant ou mot de passe incorrect.');
    }

    const jeton = creerJetonAdmin(compte.id, compte.identifiant, compte.role);
    return json(200, {
      jeton,
      utilisateur: { id: compte.id, identifiant: compte.identifiant, nom: compte.nom, role: compte.role },
    });
  } catch (err) {
    console.error('POST /admin/connexion', err);
    return erreur(500, 'Erreur serveur.');
  }
};
