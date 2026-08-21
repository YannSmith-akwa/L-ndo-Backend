const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { normaliserTelephoneCM } = require('./_lib/telephone');
const { telephoneAuthentifie } = require('./_lib/auth');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

// Anti double-déclenchement (voir audit, point 2.3) : un double-tap ou
// un retry réseau côté client ne doit pas envoyer un second prompt
// USSD/redirection tant qu'une tentative récente est déjà en cours.
const COOLDOWN_SECONDES = 30;

function genererUuid() {
  // crypto.randomUUID() est disponible nativement (Node 18+, runtime
  // Netlify Functions par défaut) — pas besoin de dépendance externe.
  return require('crypto').randomUUID();
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'POST') return erreur(405, 'Méthode non autorisée');

  const operateur = event.queryStringParameters?.operateur; // 'mtn' | 'orange'
  if (!['mtn', 'orange'].includes(operateur)) return erreur(400, 'Opérateur invalide.');

  // Correctif (voir audit, point 1.2) : sans ceci, n'importe qui
  // connaissant une référence pouvait déclencher un prompt de paiement
  // vers le numéro de son choix pour la réservation de quelqu'un d'autre.
  const telephoneCompte = telephoneAuthentifie(event);
  if (!telephoneCompte) return erreur(401, 'Authentification requise.');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return erreur(400, 'JSON invalide.'); }
  const { reference } = body;
  const tel = normaliserTelephoneCM(body.telephone);
  if (!reference || !tel) return erreur(400, 'reference et telephone (valide) requis.');

  try {
    const sql = getSql();
    const [reservation] = await sql(
      `select id, total, statut, telephone_compte, reference_operateur, jeton_operateur, paiement_initie_le,
              trajet_id, date_voyage, nb_voyageurs
       from reservations where reference = $1`,
      [reference]
    );
    if (!reservation) return erreur(404, 'Réservation introuvable.');
    // Une réservation créée avant ce correctif peut ne pas avoir de
    // telephone_compte : par prudence, on refuse plutôt que d'autoriser
    // un paiement dont on ne peut pas vérifier le propriétaire.
    if (reservation.telephone_compte !== telephoneCompte) return erreur(403, 'Cette réservation ne vous appartient pas.');
    if (reservation.statut === 'payé') return erreur(409, 'Cette réservation est déjà payée.');

    if (reservation.paiement_initie_le) {
      const ecouleSecondes = (Date.now() - new Date(reservation.paiement_initie_le).getTime()) / 1000;
      if (ecouleSecondes < COOLDOWN_SECONDES) {
        return erreur(429, `Un paiement a déjà été initié il y a ${Math.round(ecouleSecondes)}s — patientez avant de réessayer.`);
      }
    }

    // Correctif (voir audit du client, point 1.3 côté app) : une fois
    // expirée par le cron (expirer-reservations.js), les places de cette
    // réservation ont été rendues au stock général — elles peuvent déjà
    // appartenir à quelqu'un d'autre. Relancer un paiement dessus n'a
    // plus de sens : on refuse plutôt que de laisser une USSD aboutir
    // sur une réservation qui ne tient plus de siège.
    if (reservation.statut === 'expire') {
      return erreur(410, 'Cette réservation a expiré et ses places ont été libérées. Veuillez recommencer une nouvelle réservation.');
    }
    // Reprise après un échec (statut 'echoue') : paiement-statut.js avait
    // recrédité les places de cette réservation dès l'échec constaté.
    // Sans ce qui suit, réessayer déclenchait bien un nouveau paiement
    // opérateur, mais (a) sans qu'aucun siège ne soit plus réellement
    // tenu pour cette réservation (risque de survente si le paiement
    // aboutit), et (b) paiement-statut.js aurait de toute façon continué
    // à renvoyer 'echoue' sans jamais rappeler l'opérateur, puisqu'il
    // traite ce statut comme définitif — la reprise était donc, dans les
    // deux cas, invisible pour le client.
    if (reservation.statut === 'echoue') {
      const [stock] = await sql(
        `with depart as (
           select id, places from departs where trajet_id = $1::int and date_voyage = $2::date
         ),
         maj as (
           update departs set places = places - $3::int
           where id = (select id from depart) and places >= $3::int
           returning places
         )
         select (select places from depart) as places_avant, (select places from maj) as places_apres`,
        [reservation.trajet_id, reservation.date_voyage, reservation.nb_voyageurs]
      );
      if (stock.places_apres === null) {
        return erreur(409, `Places insuffisantes sur ce trajet à cette date (${stock.places_avant ?? 0} restante(s)) — impossible de réessayer cette réservation.`);
      }
      const [reprise] = await sql(
        `update reservations set statut = 'en_attente' where id = $1 and statut = 'echoue' returning id`,
        [reservation.id]
      );
      if (!reprise) {
        // Une autre requête concurrente (double-tap sur "Réessayer") a
        // déjà repris cette réservation entre-temps : on rend les places
        // qu'on venait de décompter pour rien, comme le fait
        // reservations.js en cas d'échec de son étape 2.
        try {
          await sql(
            'update departs set places = places + $1::int where trajet_id = $2::int and date_voyage = $3::date',
            [reservation.nb_voyageurs, reservation.trajet_id, reservation.date_voyage]
          );
        } catch (erreurCompensation) {
          console.error('POST /paiement/:operateur/initier — échec de la compensation de stock', erreurCompensation);
        }
        return erreur(409, 'Cette réservation est déjà en cours de nouvelle tentative.');
      }
    }

    const referenceOperateur = genererUuid();
    let reponseSupplementaire = {};

    if (operateur === 'mtn') {
      await momo.initierPaiement({
        referenceOperateur,
        montant: reservation.total,
        telephoneMsisdn: tel.msisdn,
        note: `Lōndo — ${reference}`,
      });
      await sql(
        'update reservations set reference_operateur = $1, paiement_initie_le = now() where id = $2',
        [referenceOperateur, reservation.id]
      );
    } else {
      // Orange Money : flux par redirection (voir _lib/orange.js) — le
      // client doit ouvrir paymentUrl, ce n'est PAS un prompt automatique.
      const { paymentUrl, payToken } = await orange.initierPaiement({
        referenceOperateur,
        montant: reservation.total,
        note: `Lōndo — ${reference}`,
      });
      await sql(
        'update reservations set reference_operateur = $1, jeton_operateur = $2, paiement_initie_le = now() where id = $3',
        [referenceOperateur, payToken, reservation.id]
      );
      reponseSupplementaire = { paymentUrl };
    }

    return json(200, { ok: true, ...reponseSupplementaire });
  } catch (err) {
    console.error('POST /paiement/:operateur/initier', err);
    if (err.message === 'MOMO_NON_CONFIGURE' || err.message === 'ORANGE_NON_CONFIGURE') {
      return erreur(503, "Le paiement mobile n'est pas encore configuré côté serveur.");
    }
    return erreur(502, "Échec de l'initiation du paiement auprès de l'opérateur.");
  }
};
