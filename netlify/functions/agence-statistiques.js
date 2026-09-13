const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { identiteAgence } = require('./_lib/auth');

// date_voyage est de type `date` (sans heure) — même format que celui
// déjà envoyé par le client ailleurs (reservations.js).
function dateValide(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const identite = identiteAgence(event);
  if (!identite) return erreur(401, 'Authentification agence requise.');
  // Le chiffre d'affaires global de l'agence est explicitement hors de
  // portée de l'agent de guichet dans la matrice de droits — ce tableau
  // de bord n'a de toute façon pas d'utilité pour valider des
  // embarquements ou vendre au guichet.
  if (identite.role === 'agent_guichet') return erreur(403, "Réservé au chef d'agence.");
  const agenceId = identite.agenceId;

  // Bornes de période optionnelles (AAAA-MM-JJ), filtrent sur
  // date_voyage. Absentes par défaut : contrairement à
  // /agence/reservations (les 100 réservations les plus RÉCEMMENT
  // CRÉÉES), ce endpoint agrège TOUT l'historique de l'agence — c'est
  // justement le problème qu'il corrige (voir échange du 11/09/2026,
  // les KPI du tableau de bord front ne portaient jusqu'ici que sur
  // ces 100 lignes, silencieusement faux dès qu'une agence dépasse ce
  // volume).
  const qs = event.queryStringParameters || {};
  const depuis = qs.depuis;
  const jusqua = qs.jusqua;
  if (depuis !== undefined && !dateValide(depuis)) return erreur(400, 'depuis invalide (format attendu : AAAA-MM-JJ).');
  if (jusqua !== undefined && !dateValide(jusqua)) return erreur(400, 'jusqua invalide (format attendu : AAAA-MM-JJ).');

  // Toutes les clauses qualifiées `r.` explicitement : nécessaire pour
  // la requête par trajet plus bas, qui joint `trajets` — table qui a,
  // elle aussi, une colonne `agence_id`. Sans le préfixe, `agence_id =
  // $1` y serait ambigu entre les deux tables.
  const clauses = ['r.agence_id = $1'];
  const valeurs = [agenceId];
  if (depuis) { clauses.push(`r.date_voyage >= $${valeurs.length + 1}`); valeurs.push(depuis); }
  if (jusqua) { clauses.push(`r.date_voyage <= $${valeurs.length + 1}`); valeurs.push(jusqua); }
  const ou = clauses.join(' and ');

  try {
    const sql = getSql();

    // idx_reservations_agence(agence_id, cree_le desc) (voir schema.sql,
    // section 11 du changelog) a `agence_id` en colonne de tête : il
    // suffit à restreindre les trois requêtes ci-dessous à cette seule
    // agence sans scan de toute la table `reservations`, même si le
    // filtre optionnel sur date_voyage, lui, n'est pas couvert par cet
    // index. Pas un problème au volume actuel — à revisiter (index
    // dédié sur (agence_id, date_voyage)) si le filtre par période
    // devient un usage fréquent sur une base volumineuse.
    const [totaux] = await sql(
      `select
         count(*)::int as reservations,
         coalesce(sum(r.total) filter (where r.statut = 'payé'), 0)::int as "chiffreAffaires",
         count(*) filter (where r.embarque_le is not null)::int as embarques,
         count(*) filter (where r.statut = 'payé')::int as "reservationsPayees"
       from reservations r
       where ${ou}`,
      valeurs
    );

    const parStatut = await sql(
      `select r.statut, count(*)::int as nombre
       from reservations r
       where ${ou}
       group by r.statut
       order by r.statut`,
      valeurs
    );

    // Top 20 trajets par nombre de réservations — pas de pagination
    // pour l'instant, un dashboard agence n'a normalement qu'une
    // poignée de trajets actifs à la fois (voir agence-trajets.js).
    const parTrajet = await sql(
      `select t.depart, t.arrivee, t.heure,
              count(r.*)::int as reservations,
              coalesce(sum(r.nb_voyageurs), 0)::int as voyageurs,
              coalesce(sum(r.total) filter (where r.statut = 'payé'), 0)::int as "chiffreAffaires"
       from reservations r
       join trajets t on t.id = r.trajet_id
       where ${ou}
       group by t.id, t.depart, t.arrivee, t.heure
       order by reservations desc
       limit 20`,
      valeurs
    );

    const tauxEmbarquement = totaux.reservationsPayees > 0
      ? Math.round((totaux.embarques / totaux.reservationsPayees) * 100)
      : null;

    return json(200, {
      periode: { depuis: depuis || null, jusqua: jusqua || null },
      totaux: {
        reservations: totaux.reservations,
        chiffreAffaires: totaux.chiffreAffaires,
        embarques: totaux.embarques,
        tauxEmbarquement, // null si aucune réservation payée sur la période — à distinguer de 0% côté front
      },
      parStatut,
      parTrajet,
    });
  } catch (err) {
    console.error('/agence/statistiques', err);
    return erreur(500, 'Erreur serveur.');
  }
};
