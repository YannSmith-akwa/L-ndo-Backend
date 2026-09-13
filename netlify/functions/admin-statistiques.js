const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');

// date_voyage/cree_le : même format AAAA-MM-JJ que partout ailleurs
// (voir agence-statistiques.js).
function dateValide(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  // Pas de chiffre d'affaires ici, seulement des volumes de réservation
  // — rien qui corresponde aux "marges de la plateforme" hors de portée
  // de support_client dans la matrice de droits, donc ouvert aux trois
  // rôles admin comme /admin/reservations.
  const acces = accesAdmin(event, ['comptable', 'support_client']);
  if (!acces) return erreur(401, 'Accès administrateur requis.');

  const qs = event.queryStringParameters || {};
  const depuis = qs.depuis;
  const jusqua = qs.jusqua;
  if (depuis !== undefined && !dateValide(depuis)) return erreur(400, 'depuis invalide (format attendu : AAAA-MM-JJ).');
  if (jusqua !== undefined && !dateValide(jusqua)) return erreur(400, 'jusqua invalide (format attendu : AAAA-MM-JJ).');
  const agenceId = qs.agenceId ? Number(qs.agenceId) : null;
  if (qs.agenceId !== undefined && (!Number.isInteger(agenceId) || agenceId < 1)) return erreur(400, 'agenceId invalide.');

  // Filtre sur cree_le (date d'ACHAT du billet), pas date_voyage : la
  // question posée est "à quelle heure les gens achètent-ils", pas "à
  // quelle heure partent les bus" — voir agence-trajets.js pour l'heure
  // de départ, une donnée différente.
  const clauses = [];
  const valeurs = [];
  if (depuis) { clauses.push(`r.cree_le >= $${valeurs.length + 1}::date`); valeurs.push(depuis); }
  if (jusqua) { clauses.push(`r.cree_le < ($${valeurs.length + 1}::date + interval '1 day')`); valeurs.push(jusqua); }
  if (agenceId) { clauses.push(`r.agence_id = $${valeurs.length + 1}`); valeurs.push(agenceId); }
  const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';

  try {
    const sql = getSql();

    // Bucketing en heure LOCALE (Afrique/Douala, UTC+1 toute l'année,
    // pas d'heure d'été) : cree_le est stocké en UTC (comportement par
    // défaut de now()), un bucketing sans conversion décalerait chaque
    // réservation d'une heure par rapport à l'horloge murale des
    // agences.
    const lignes = await sql(
      `select extract(hour from r.cree_le at time zone 'Africa/Douala')::int as heure,
              count(*)::int as reservations
       from reservations r
       ${ou}
       group by heure`,
      valeurs
    );

    // 24 cases toujours présentes (0 à 23), y compris les heures sans
    // aucune réservation — un graphique en barres avec des trous
    // silencieux plutôt que des barres à zéro serait trompeur.
    const parHeure = Array.from({ length: 24 }, (_, heure) => ({ heure, reservations: 0 }));
    for (const l of lignes) parHeure[l.heure].reservations = l.reservations;

    const total = parHeure.reduce((somme, h) => somme + h.reservations, 0);

    return json(200, {
      periode: { depuis: depuis || null, jusqua: jusqua || null, agenceId },
      total,
      parHeure,
    });
  } catch (err) {
    console.error('/admin/statistiques', err);
    return erreur(500, 'Erreur serveur.');
  }
};
