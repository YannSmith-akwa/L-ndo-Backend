const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { agenceAuthentifiee } = require('./_lib/auth');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  const agenceId = agenceAuthentifiee(event);
  if (!agenceId) return erreur(401, 'Authentification agence requise.');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (!reference) return erreur(400, 'reference requise.');

  try {
    const sql = getSql();

    // Bascule atomique et gardée : `embarque_le is null` dans le WHERE
    // garantit qu'un même billet ne peut être validé qu'une seule fois
    // même si deux membres du personnel scannent au même instant (le
    // second trouve 0 ligne, exactement comme le verrou de places dans
    // reservations.js).
    const [ok] = await sql(
      `update reservations set embarque_le = now()
       where reference = $1 and agence_id = $2 and statut = 'payé' and embarque_le is null
       returning nom_voyageur_principal as "nomVoyageur", piece_id as "pieceId", date_voyage as "dateVoyage"`,
      [reference, agenceId]
    );

    if (ok) {
      return json(200, { statut: 'valide', ...ok });
    }

    // La mise à jour n'a rien trouvé : on interroge une seconde fois
    // pour donner un message précis (introuvable / pas payé / déjà
    // utilisé) plutôt qu'un simple échec générique. Ce deuxième temps
    // ne casse pas l'atomicité du cas de succès ci-dessus, qui est le
    // seul qui compte pour éviter un double embarquement.
    const [existe] = await sql(
      `select statut, embarque_le as "embarqueLe", nom_voyageur_principal as "nomVoyageur"
       from reservations where reference = $1 and agence_id = $2`,
      [reference, agenceId]
    );

    if (!existe) return erreur(404, 'Référence introuvable pour votre agence.');
    if (existe.embarqueLe) return erreur(409, `Billet déjà utilisé le ${new Date(existe.embarqueLe).toLocaleString('fr-FR')} (${existe.nomVoyageur}).`);
    return erreur(409, `Ce billet n'est pas payé (statut actuel : ${existe.statut}).`);
  } catch (err) {
    console.error('/agence/embarquement', err);
    return erreur(500, 'Erreur serveur.');
  }
};
