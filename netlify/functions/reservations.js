const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');

// Mêmes règles que côté client (constantes SEUIL_FIDELITE / REDUCTION_
// FIDELITE de App.js) — mais ici c'est la version qui FAIT FOI : le
// client ne fait plus qu'afficher ce que cette fonction renvoie.
const SEUIL_FIDELITE = 25;
const REDUCTION_FIDELITE = 2500;

function genererReference(nomAgence) {
  const prefixe = (nomAgence || 'LN').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3) || 'LN';
  const annee = new Date().getFullYear();
  const suffixe = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `${prefixe}-${annee}-${suffixe}`;
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }

  const {
    nom, telephone, piece_id, telephone_paiement, trajet_id, agence_id,
    date_voyage, mode_paiement, nb_voyageurs, type_voyage, voyageurs, telephone_compte,
  } = body;

  if (!nom || !telephone || !piece_id || !telephone_paiement || !trajet_id || !agence_id || !date_voyage || !nb_voyageurs || !type_voyage) {
    return erreur(400, 'Champs de réservation manquants.');
  }
  if (!['simple', 'ar'].includes(type_voyage)) return erreur(400, 'type_voyage invalide.');
  if (!['mtn_momo', 'orange_money'].includes(mode_paiement)) return erreur(400, 'mode_paiement invalide.');

  try {
    const sql = getSql();

    const [agence] = await sql('select id, nom from agences where id = $1', [agence_id]);
    if (!agence) return erreur(404, 'Agence introuvable.');

    const [trajet] = await sql('select id, places from trajets where id = $1 and agence_id = $2', [trajet_id, agence_id]);
    if (!trajet) return erreur(404, 'Trajet introuvable.');
    if (trajet.places < nb_voyageurs) return erreur(409, 'Places insuffisantes sur ce trajet.');

    const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
    if (!t) return erreur(500, 'Tarifs non configurés côté serveur.');
    const prix = type_voyage === 'ar' ? t.prixAr : t.prixSimple;

    // Fidélité : compte les réservations PAYÉES du même voyageur, même
    // agence, même type de voyage. Basé sur la colonne telephone_
    // voyageur_principal en base — jamais sur une donnée envoyée par
    // le client sans vérification.
    const [{ count }] = await sql(
      `select count(*)::int as count from reservations
       where telephone_voyageur_principal = $1 and agence_id = $2 and type_voyage = $3 and statut = 'payé'`,
      [telephone, agence_id, type_voyage]
    );
    const reduction = count >= SEUIL_FIDELITE ? REDUCTION_FIDELITE : 0;
    const total = Math.max(0, (prix + t.commission) * nb_voyageurs - reduction);

    const reference = genererReference(agence.nom);

    const [reservation] = await sql(
      `insert into reservations
         (reference, agence_id, trajet_id, telephone_compte, nom_voyageur_principal, telephone_voyageur_principal,
          telephone_paiement, piece_id, date_voyage, type_voyage, nb_voyageurs, mode_paiement, total, reduction_fidelite)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id, reference, total, reduction_fidelite as "reductionFidelite", statut`,
      [reference, agence_id, trajet_id, telephone_compte || null, nom, telephone, telephone_paiement, piece_id,
       date_voyage, type_voyage, nb_voyageurs, mode_paiement, total, reduction]
    );

    if (Array.isArray(voyageurs) && voyageurs.length) {
      for (const v of voyageurs) {
        await sql(
          'insert into voyageurs (reservation_id, nom, telephone, piece_id) values ($1,$2,$3,$4)',
          [reservation.id, v.nom, v.telephone, v.piece_id]
        );
      }
    }

    // On décrémente les places dès la création de la réservation (pas
    // seulement après paiement confirmé) pour éviter une survente si
    // deux personnes réservent le même trajet en même temps. À affiner
    // plus tard avec un mécanisme de libération si le paiement échoue
    // ou expire (voir statut 'echoue' / 'expire').
    await sql('update trajets set places = places - $1 where id = $2', [nb_voyageurs, trajet_id]);

    return json(200, {
      reservation: {
        reference: reservation.reference,
        total: reservation.total,
        reductionFidelite: reservation.reductionFidelite,
        statut: reservation.statut,
      },
    });
  } catch (err) {
    console.error('POST /reservations', err);
    return erreur(500, 'Erreur serveur lors de la création de la réservation.');
  }
};
