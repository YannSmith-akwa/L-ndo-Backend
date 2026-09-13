const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { normaliserTelephoneCM } = require('./_lib/telephone');
const { identiteAgence } = require('./_lib/auth');
const { enregistrerAudit } = require('./_lib/audit');

// Réutilise très délibérément la même mécanique que reservations.js
// (verrou de stock atomique via `departs`, séquence de référence,
// insertion voyageurs en une seule instruction) plutôt que d'inventer
// un second chemin : c'est la même place, dans le même stock, que le
// client en ligne verrait — toute divergence de logique entre les deux
// serait une source de survente. Trois différences assumées :
//   - pas d'authentification OTP client : l'acteur, c'est l'agent
//     connecté (identiteAgence), pas un numéro de compte vérifié ;
//   - statut 'payé' immédiat (espèces déjà encaissées au guichet),
//     jamais 'en_attente' ;
//   - mode_paiement 'especes', qui n'existait pas dans la contrainte
//     d'origine (voir schema.sql, section "vente au guichet").
const MAX_VOYAGEURS = 10;
const PREFIXE_DEFAUT = 'LN';

function prefixeAgence(nomAgence) {
  return (nomAgence || PREFIXE_DEFAUT).split(' ').filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3) || PREFIXE_DEFAUT;
}
function dateValide(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}
function texteValide(s, max = 80) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  // Ouvert à tous les rôles agence : c'est littéralement le travail de
  // l'agent de guichet, au même titre que l'embarquement — voir le
  // document d'origine ("Vente au guichet... interface de vente
  // directe dans l'espace agence").
  const identite = identiteAgence(event);
  if (!identite) return erreur(401, 'Authentification agence requise.');
  const agenceId = identite.agenceId;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }

  const { trajetId, dateVoyage, typeVoyage, nbVoyageurs } = body;
  if (!Number.isInteger(trajetId) || trajetId < 1) return erreur(400, 'trajetId requis.');
  if (!dateValide(dateVoyage)) return erreur(400, 'dateVoyage invalide (format AAAA-MM-JJ).');
  if (!['simple', 'ar'].includes(typeVoyage)) return erreur(400, 'typeVoyage invalide.');
  if (!Number.isInteger(nbVoyageurs) || nbVoyageurs < 1 || nbVoyageurs > MAX_VOYAGEURS) {
    return erreur(400, `nbVoyageurs doit être un entier entre 1 et ${MAX_VOYAGEURS}.`);
  }
  if (!Array.isArray(body.voyageurs) || body.voyageurs.length !== nbVoyageurs) {
    return erreur(400, 'Le nombre de voyageurs ne correspond pas à nbVoyageurs.');
  }
  const voyageursNormalises = [];
  for (const v of body.voyageurs) {
    const t = normaliserTelephoneCM(v?.telephone);
    if (!texteValide(v?.nom) || !t || !texteValide(v?.piece_id, 40)) {
      return erreur(400, 'Informations invalides pour un ou plusieurs voyageurs.');
    }
    voyageursNormalises.push({ nom: v.nom.trim(), telephone: t.e164, piece_id: v.piece_id.trim() });
  }
  const principal = voyageursNormalises[0];

  const aujourdHui = new Date().toISOString().slice(0, 10);
  if (dateVoyage < aujourdHui) return erreur(400, 'dateVoyage ne peut pas être dans le passé.');

  const sql = getSql();

  try {
    // Clé d'idempotence optionnelle (double-clic au guichet) : voir
    // reservations.js pour le mécanisme. `telephone_compte` y sert de
    // première moitié de la clé d'unicité (index composite existant,
    // voir schema.sql) — comme il n'y a pas de compte client ici, on
    // le fixe à "guichet:<agenceId>", stable par agence, plutôt que de
    // le laisser NULL : un index unique composite ne protège jamais
    // rien quand l'une de ses colonnes est NULL (NULL ≠ NULL en SQL),
    // ce qui aurait rendu la clé d'idempotence totalement inopérante
    // pour toutes les ventes au guichet.
    const telephoneCompteGuichet = `guichet:${agenceId}`;
    const cleIdempotence = typeof body.cle_idempotence === 'string' && body.cle_idempotence.trim()
      ? body.cle_idempotence.trim().slice(0, 64)
      : null;
    if (cleIdempotence) {
      const [existante] = await sql(
        `select reference, total, statut from reservations where telephone_compte = $1 and cle_idempotence = $2`,
        [telephoneCompteGuichet, cleIdempotence]
      );
      if (existante) return json(200, { reservation: existante });
    }

    const [trajet] = await sql('select id from trajets where id = $1 and agence_id = $2', [trajetId, agenceId]);
    if (!trajet) return erreur(404, 'Trajet introuvable pour votre agence.');

    const [agence] = await sql('select nom from agences where id = $1', [agenceId]);

    const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
    if (!t) return erreur(500, 'Tarifs non configurés côté serveur.');
    const prix = typeVoyage === 'ar' ? t.prixAr : t.prixSimple;
    // Le total inclut la commission Lōndo comme pour une vente en ligne
    // (voir reservations.js) : le client au guichet paie le même prix
    // public, la commission est simplement prélevée sur cette même
    // somme au moment du reversement plutôt qu'au moment du paiement.
    const total = (prix + t.commission) * nbVoyageurs;

    const [stock] = await sql(
      `with depart_upsert as (
         insert into departs (trajet_id, date_voyage, places)
         select $1::int, $2::date, t.capacite from trajets t where t.id = $1::int
         on conflict (trajet_id, date_voyage) do nothing
       ),
       depart as (
         select id, places from departs where trajet_id = $1::int and date_voyage = $2::date
       ),
       maj as (
         update departs set places = places - $3::int
         where id = (select id from depart) and places >= $3::int
         returning places
       )
       select (select places from depart) as places_avant, (select places from maj) as places_apres`,
      [trajetId, dateVoyage, nbVoyageurs]
    );
    if (stock.places_apres === null) {
      return erreur(409, `Places insuffisantes sur ce trajet à cette date (${stock.places_avant ?? 0} restante(s)).`);
    }

    try {
      const [resa] = await sql(
        `with num as (
           select nextval('reservations_ref_seq') as n
         ),
         nouvelle_resa as (
           insert into reservations (
             reference, agence_id, trajet_id, telephone_compte, nom_voyageur_principal,
             telephone_voyageur_principal, telephone_paiement, piece_id, date_voyage,
             type_voyage, nb_voyageurs, mode_paiement, total, statut, cle_idempotence
           )
           select
             $1::text || '-' || to_char(now(), 'YYYY') || '-' || lpad(num.n::text, 6, '0'),
             $2::int, $3::int, $4::text, $5::text, $6::text, $6::text, $7::text, $8::date,
             $9::text, $10::int, 'especes', $11::int, 'payé', $13::text
           from num
           returning id, reference, total
         ),
         ins_voy as (
           insert into voyageurs (reservation_id, nom, telephone, piece_id)
           select nr.id, v.nom, v.telephone, v.piece_id
           from nouvelle_resa nr, jsonb_to_recordset($12::jsonb) as v(nom text, telephone text, piece_id text)
           returning reservation_id
         )
         select nr.id, nr.reference, nr.total, (select count(*) from ins_voy)::int as nb_inseres
         from nouvelle_resa nr`,
        [
          prefixeAgence(agence?.nom), agenceId, trajetId, telephoneCompteGuichet, principal.nom,
          principal.telephone, principal.piece_id, dateVoyage,
          typeVoyage, nbVoyageurs, total, JSON.stringify(voyageursNormalises), cleIdempotence,
        ]
      );
      if (resa.nb_inseres !== nbVoyageurs) throw new Error('VOYAGEURS_INCOMPLET');

      await enregistrerAudit(sql, event, {
        acteurType: 'agence', acteurId: identite.employeId, acteurIdentifiant: identite.identifiant || `agence#${agenceId}`,
        acteurRole: identite.role, action: 'reservation.creer_guichet', cibleType: 'reservation', cibleId: resa.id,
        details: { reference: resa.reference, total: resa.total, nbVoyageurs },
      });

      return json(201, { reservation: { reference: resa.reference, total: resa.total, statut: 'payé' } });
    } catch (erreurEtape2) {
      if (cleIdempotence && erreurEtape2.code === '23505') {
        try {
          await sql('update departs set places = places + $1::int where trajet_id = $2::int and date_voyage = $3::date', [nbVoyageurs, trajetId, dateVoyage]);
        } catch (erreurCompensation) {
          console.error('POST /agence/guichet — échec de la compensation de stock (conflit idempotence)', erreurCompensation);
        }
        const [gagnante] = await sql(
          `select reference, total, statut from reservations where telephone_compte = $1 and cle_idempotence = $2`,
          [telephoneCompteGuichet, cleIdempotence]
        );
        if (gagnante) return json(200, { reservation: gagnante });
      }
      try {
        await sql('update departs set places = places + $1::int where trajet_id = $2::int and date_voyage = $3::date', [nbVoyageurs, trajetId, dateVoyage]);
      } catch (erreurCompensation) {
        console.error('POST /agence/guichet — échec de la compensation de stock', erreurCompensation);
      }
      throw erreurEtape2;
    }
  } catch (err) {
    console.error('POST /agence/guichet', err);
    return erreur(500, 'Erreur serveur lors de la création de la réservation.');
  }
};
