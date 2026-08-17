const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { verifier } = require('./_lib/motDePasse');
const { creerJetonAgence } = require('./_lib/auth');

// Même anti-abus que otp-envoyer.js (5 essais / 15 min), sur
// l'identifiant plutôt que sur le numéro de téléphone.
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

    const [agence] = await sql(
      'select id, nom, mot_de_passe_hash from agences where identifiant = $1',
      [identifiant]
    );

    // Même message générique que l'identifiant existe ou non, et un
    // bcrypt.compare exécuté même si l'agence est introuvable (avec un
    // hash factice) : évite qu'une différence de temps de réponse laisse
    // deviner quels identifiants existent réellement (énumération de
    // comptes).
    const valide = await verifier(motDePasse, agence?.mot_de_passe_hash || '$2a$10$invalidsaltinvalidsaltin');
    if (!agence || !agence.mot_de_passe_hash || !valide) {
      return erreur(401, 'Identifiant ou mot de passe incorrect.');
    }

    const jeton = creerJetonAgence(agence.id);
    return json(200, { jeton, agence: { id: agence.id, nom: agence.nom } });
  } catch (err) {
    console.error('POST /agence/connexion', err);
    return erreur(500, 'Erreur serveur.');
  }
};
