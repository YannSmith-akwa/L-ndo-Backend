const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { normaliserTelephoneCM } = require('./_lib/telephone');
const { telephoneAuthentifie } = require('./_lib/auth');

const MAX_VOYAGEURS = 10;
const MAX_RESA_EN_ATTENTE = 3;
const PREFIXE_DEFAUT = 'LN';

function prefixeAgence(nomAgence) {
  return (nomAgence || PREFIXE_DEFAUT).split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3) || PREFIXE_DEFAUT;
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

  // Correctif (voir audit, point 1.2) : avant, n'importe qui pouvait
  // appeler cet endpoint avec le telephone_compte de son choix, sans
  // jamais avoir vérifié de code OTP. Le numéro du compte est
  // désormais TOUJOURS dérivé du jeton signé émis par
  // /auth/otp/verifier — jamais accepté depuis le corps de la requête.
  const telephoneCompte = telephoneAuthentifie(event);
  if (!telephoneCompte) return erreur(401, 'Authentification requise (vérifiez votre numéro).');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }

  const { trajet_id, agence_id, date_voyage, mode_paiement, nb_voyageurs, type_voyage } = body;

  if (!texteValide(body.nom) || !texteValide(body.piece_id, 40)) {
    return erreur(400, 'Nom ou pièce d’identité invalide.');
  }
  const telPrincipal = normaliserTelephoneCM(body.telephone);
  const telPaiement = normaliserTelephoneCM(body.telephone_paiement);
  if (!telPrincipal) return erreur(400, 'Numéro du voyageur principal invalide.');
  if (!telPaiement) return erreur(400, 'Numéro de paiement invalide.');
  if (!trajet_id || !agence_id) return erreur(400, 'trajet_id et agence_id requis.');
  if (!dateValide(date_voyage)) return erreur(400, 'date_voyage invalide (format AAAA-MM-JJ).');
  if (!['simple', 'ar'].includes(type_voyage)) return erreur(400, 'type_voyage invalide.');
  if (!['mtn_momo', 'orange_money'].includes(mode_paiement)) return erreur(400, 'mode_paiement invalide.');
  if (!Number.isInteger(nb_voyageurs) || nb_voyageurs < 1 || nb_voyageurs > MAX_VOYAGEURS) {
    return erreur(400, `nb_voyageurs doit être un entier entre 1 et ${MAX_VOYAGEURS}.`);
  }
  // Correctif (voir audit, point 2.6) : nb_voyageurs pilote le nombre de
  // places décomptées du stock — sans ce contrôle, un client pouvait
  // décompter plus de sièges que de voyageurs réellement enregistrés.
  if (!Array.isArray(body.voyageurs) || body.voyageurs.length !== nb_voyageurs) {
    return erreur(400, 'Le nombre de voyageurs ne correspond pas à nb_voyageurs.');
  }
  const voyageursNormalises = [];
  for (const v of body.voyageurs) {
    const t = normaliserTelephoneCM(v?.telephone);
    if (!texteValide(v?.nom) || !t || !texteValide(v?.piece_id, 40)) {
      return erreur(400, 'Informations invalides pour un ou plusieurs voyageurs.');
    }
    voyageursNormalises.push({ nom: v.nom.trim(), telephone: t.e164, piece_id: v.piece_id.trim() });
  }
  // Aujourd'hui en UTC, comparaison à la journée près (le fuseau du
  // Cameroun, UTC+1 sans heure d'été, ne fait jamais dévier ceci de
  // plus d'une heure autour de minuit).
  const aujourdHui = new Date().toISOString().slice(0, 10);
  if (date_voyage < aujourdHui) return erreur(400, 'date_voyage ne peut pas être dans le passé.');

  const sql = getSql();

  try {
    // Idempotence (voir audit du 27/08/2026) : si le réseau coupe après
    // que le serveur a créé la réservation mais avant que la réponse
    // n'arrive au client, un renvoi de la MÊME requête (même
    // cle_idempotence) doit renvoyer la réservation déjà créée plutôt
    // que d'en créer une seconde — sinon deux paiements pour un seul
    // trajet voulu. Optionnelle : les anciens clients qui ne l'envoient
    // pas gardent l'ancien comportement (une requête = une réservation).
    const cleIdempotence = typeof body.cle_idempotence === 'string' && body.cle_idempotence.trim()
      ? body.cle_idempotence.trim().slice(0, 64)
      : null;
    if (cleIdempotence) {
      const [existante] = await sql(
        `select reference, total, statut from reservations where telephone_compte = $1 and cle_idempotence = $2`,
        [telephoneCompte, cleIdempotence]
      );
      if (existante) return json(200, { reservation: existante });
    }

    // Anti-accaparement (voir audit du 22/08/2026) : sans cette limite,
    // un même compte authentifié peut créer des réservations 'en_attente'
    // en boucle sur autant de trajets/dates que voulu, sans jamais payer —
    // les places ne se libèrent qu'à l'expiration (20 min + jusqu'à 10 min
    // avant le prochain passage du cron). Un trajet peut ainsi être
    // maintenu « complet » indéfiniment pour de vrais clients. Vérification
    // simple, sans verrou : une rafale très concurrente pourrait en théorie
    // dépasser le plafond de un ou deux, sans conséquence pour un garde-fou
    // business (contrairement au stock de places, ce n'est pas une
    // frontière de sécurité stricte).
    const [{ count: enAttenteCount }] = await sql(
      `select count(*)::int as count from reservations where telephone_compte = $1 and statut = 'en_attente'`,
      [telephoneCompte]
    );
    if (enAttenteCount >= MAX_RESA_EN_ATTENTE) {
      return erreur(429, `Vous avez déjà ${enAttenteCount} réservation(s) en attente de paiement. Payez-les ou attendez leur expiration avant d'en créer une nouvelle.`);
    }

    const [agence] = await sql('select id, nom from agences where id = $1', [agence_id]);
    if (!agence) return erreur(404, 'Agence introuvable.');

    const [trajet] = await sql('select id from trajets where id = $1 and agence_id = $2', [trajet_id, agence_id]);
    if (!trajet) return erreur(404, 'Trajet introuvable.');

    const [t] = await sql('select prix_simple as "prixSimple", prix_ar as "prixAr", commission from tarifs where id = 1');
    if (!t) return erreur(500, 'Tarifs non configurés côté serveur.');
    const prix = type_voyage === 'ar' ? t.prixAr : t.prixSimple;
    const total = (prix + t.commission) * nb_voyageurs;

    // ── Étape 1 : réservation atomique du stock, scindé par date ──
    // Correctif (voir audit, points 1.1 et 1.3). La ligne `departs`
    // pour ce (trajet, date) est créée à la volée si besoin (initialisée
    // à la capacité nominale du trajet), puis décrémentée dans LA MÊME
    // instruction SQL, sous condition `places >= nb_voyageurs` — c'est
    // cette condition, évaluée atomiquement par Postgres lors de
    // l'UPDATE, qui empêche la survente en cas de requêtes concurrentes
    // (contrairement à l'ancien SELECT-puis-UPDATE séparés, sujet à une
    // condition de course).
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
      [trajet_id, date_voyage, nb_voyageurs]
    );
    if (stock.places_apres === null) {
      return erreur(409, `Places insuffisantes sur ce trajet à cette date (${stock.places_avant ?? 0} restante(s)).`);
    }

    // ── Étape 2 : création de la réservation + des voyageurs ──
    // Une seule instruction SQL (référence générée par séquence,
    // insertion de la réservation, puis des voyageurs à partir du
    // tableau JSON) : soit tout est écrit, soit rien ne l'est — plus de
    // ligne orpheline possible si une étape échoue en cours de route
    // (voir audit, point 1.3).
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
             $2::int, $3::int, $4::text, $5::text, $6::text, $7::text, $8::text, $9::date,
             $10::text, $11::int, $12::text, $13::int, 'en_attente', $15::text
           from num
           returning id, reference, total
         ),
         ins_voy as (
           insert into voyageurs (reservation_id, nom, telephone, piece_id)
           select nr.id, v.nom, v.telephone, v.piece_id
           from nouvelle_resa nr, jsonb_to_recordset($14::jsonb) as v(nom text, telephone text, piece_id text)
           returning reservation_id
         )
         select nr.id, nr.reference, nr.total, (select count(*) from ins_voy)::int as nb_inseres
         from nouvelle_resa nr`,
        [
          prefixeAgence(agence.nom), agence_id, trajet_id, telephoneCompte, body.nom.trim(),
          telPrincipal.e164, telPaiement.e164, body.piece_id.trim(), date_voyage,
          type_voyage, nb_voyageurs, mode_paiement, total, JSON.stringify(voyageursNormalises), cleIdempotence,
        ]
      );
      if (resa.nb_inseres !== nb_voyageurs) throw new Error('VOYAGEURS_INCOMPLET');

      return json(201, {
        reservation: { reference: resa.reference, total: resa.total, statut: 'en_attente' },
      });
    } catch (erreurEtape2) {
      // Conflit d'idempotence (voir audit du 27/08/2026) : une requête
      // concurrente avec la même cle_idempotence a gagné la course entre
      // notre SELECT plus haut et cet insert — elle a déjà créé la
      // réservation avec succès. Les places qu'on vient de décompter à
      // l'étape 1 sont donc en trop POUR NOUS (l'autre requête a décompté
      // les siennes) : on les recrédite comme d'habitude, mais on renvoie
      // la réservation de l'autre requête au lieu d'une erreur — c'est
      // justement le but de l'idempotence, pas un vrai échec.
      if (cleIdempotence && erreurEtape2.code === '23505') {
        try {
          await sql(
            'update departs set places = places + $1::int where trajet_id = $2::int and date_voyage = $3::date',
            [nb_voyageurs, trajet_id, date_voyage]
          );
        } catch (erreurCompensation) {
          console.error('POST /reservations — échec de la compensation de stock (conflit idempotence)', erreurCompensation);
        }
        const [gagnante] = await sql(
          `select reference, total, statut from reservations where telephone_compte = $1 and cle_idempotence = $2`,
          [telephoneCompte, cleIdempotence]
        );
        if (gagnante) return json(200, { reservation: gagnante });
      }
      // Compensation : l'étape 1 a déjà décompté les places, mais la
      // réservation elle-même n'a pas pu être créée — on les recrédite
      // pour ne pas perdre de sièges. Reste, en théorie, un très court
      // instant entre les deux requêtes où ces places sont indisponibles
      // pour d'autres clients ; sans session interactive (driver HTTP
      // Neon), une vraie transaction couvrant les deux étapes n'est pas
      // possible ici — voir le README pour ce compromis.
      try {
        await sql(
          'update departs set places = places + $1::int where trajet_id = $2::int and date_voyage = $3::date',
          [nb_voyageurs, trajet_id, date_voyage]
        );
      } catch (erreurCompensation) {
        console.error('POST /reservations — échec de la compensation de stock', erreurCompensation);
      }
      throw erreurEtape2;
    }
  } catch (err) {
    console.error('POST /reservations', err);
    return erreur(500, 'Erreur serveur lors de la création de la réservation.');
  }
};
