const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');

function dateValide(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  // Correctif (voir audit, point 1.1) : `places` est maintenant calculé
  // pour une DATE précise (celle choisie par le client, sinon aujourd'hui
  // par défaut) au lieu d'un compteur global partagé par toutes les
  // dates. La forme de la réponse (trajets[].places) ne change pas —
  // aucune adaptation nécessaire côté client au-delà de l'ajout du
  // paramètre ?date=.
  //
  // ⚠️ Limite connue : cette liste est chargée une fois par écran (voir
  // EcranAccueil côté client) ; si l'utilisateur change ensuite la date
  // sur EcranTrajetsAgence sans revenir à l'écran d'accueil, les
  // pastilles "places" affichées restent celles de la date initialement
  // demandée. Cosmétique seulement : la vraie vérification, elle,
  // est toujours refaite pour la bonne date au moment de réserver
  // (reservations.js) — impossible de survendre à cause de ce décalage.
  const date = dateValide(event.queryStringParameters?.date)
    ? event.queryStringParameters.date
    : new Date().toISOString().slice(0, 10);

  try {
    const sql = getSql();
    const agences = await sql.query('select id, nom, couleur, couleur_pale as "couleurPale", slogan, tel, note from agences order by id');
    const trajets = await sql.query(
      `select t.id, t.agence_id as "agenceId", t.depart, t.arrivee, t.heure,
              coalesce(d.places, t.capacite) as places
       from trajets t
       left join departs d on d.trajet_id = t.id and d.date_voyage = $1::date
       order by t.agence_id, t.id`,
      [date]
    );

    const resultat = agences.map(a => ({
      ...a,
      note: a.note !== null ? Number(a.note) : null,
      trajets: trajets.filter(t => t.agenceId === a.id).map(({ agenceId, ...t }) => t),
    }));

    const reponse = json(200, { agences: resultat, date });
    // Données quasi statiques (agences) + un instantané de disponibilité
    // qui bouge peu à l'échelle de quelques dizaines de secondes :
    // un court cache réduit la charge sur la base sans afficher de
    // nombres perceptiblement obsolètes (voir audit, point 3.4).
    reponse.headers = { ...reponse.headers, 'Cache-Control': 'public, max-age=30' };
    return reponse;
  } catch (err) {
    console.error('GET /agences', err);
    return erreur(500, 'Erreur serveur lors du chargement des agences.');
  }
};
