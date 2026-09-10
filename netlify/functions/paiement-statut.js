const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { telephoneAuthentifie } = require('./_lib/auth');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const reference = event.queryStringParameters?.reference;
  if (!reference) return erreur(400, 'reference requise.');

  // Correctif (voir audit de cohérence App.js↔backend) : cet endpoint
  // était volontairement public au motif qu'il ne renvoie qu'un statut,
  // jamais de données personnelles — vrai, mais la référence est en
  // fait strictement séquentielle (PREFIXE-AAAA-NNNNNN), donc énumérable
  // en pratique. N'importe qui pouvait interroger le statut de n'importe
  // quelle réservation du système, et chaque appel sur une réservation
  // en_attente déclenche un vrai appel facturé/à quota chez l'opérateur
  // (MTN/Orange). Le client dispose déjà d'un jeton à ce stade du
  // parcours (émis avant la création de la réservation), donc exiger le
  // même jeton ici ne casse rien côté app.
  const telephoneCompte = telephoneAuthentifie(event);
  if (!telephoneCompte) return erreur(401, 'Authentification requise (vérifiez votre numéro).');

  try {
    const sql = getSql();
    const [reservation] = await sql(
      `select id, total, statut, mode_paiement as "modePaiement", telephone_compte as "telephoneCompte",
              reference_operateur as "referenceOperateur", jeton_operateur as "jetonOperateur"
       from reservations where reference = $1`,
      [reference]
    );
    if (!reservation) return erreur(404, 'Réservation introuvable.');
    if (reservation.telephoneCompte !== telephoneCompte) {
      return erreur(404, 'Réservation introuvable.'); // 404 plutôt que 403 : ne pas confirmer qu'une référence existe pour un autre compte.
    }

    // Déjà connu en base et définitif : pas besoin de rappeler l'opérateur.
    if (['payé', 'echoue', 'expire'].includes(reservation.statut)) {
      return json(200, { statut: reservation.statut });
    }
    if (!reservation.referenceOperateur) {
      // Paiement pas encore initié côté opérateur.
      return json(200, { statut: 'en_attente' });
    }

    const statut = reservation.modePaiement === 'mtn_momo'
      ? await momo.verifierStatut(reservation.referenceOperateur)
      : await orange.verifierStatut({
          referenceOperateur: reservation.referenceOperateur,
          payToken: reservation.jetonOperateur,
          montant: reservation.total,
        });

    if (statut === 'payé') {
      // Simple bascule, sans effet sur le stock (déjà décompté à la
      // création — voir reservations.js). La condition `statut =
      // 'en_attente'` dans le WHERE rend cette écriture idempotente si
      // deux appels concurrents arrivent ici en même temps.
      await sql(`update reservations set statut = 'payé' where id = $1 and statut = 'en_attente'`, [reservation.id]);
    } else if (statut === 'echoue') {
      // Correctif (voir audit, point 2.4) : l'ancienne version relisait
      // le statut en JS puis décidait d'écrire séparément — deux appels
      // concurrents (polling + retour au premier plan, par exemple)
      // pouvaient tous les deux constater "pas encore échoué" et
      // recréditer les places CHACUN, gonflant le stock au-delà de la
      // capacité réelle. Ici, la bascule du statut ET le recrédit des
      // places se font en une seule instruction atomique, gardée par
      // `where statut = 'en_attente'` : si un appel concurrent a déjà
      // fait la bascule, celui-ci ne trouve plus rien à mettre à jour
      // (la CTE `maj` ne renvoie aucune ligne) et le recrédit ne
      // s'applique donc qu'une seule fois, quel que soit le nombre
      // d'appels simultanés.
      await sql(
        `with maj as (
           update reservations set statut = 'echoue'
           where id = $1 and statut = 'en_attente'
           returning trajet_id, date_voyage, nb_voyageurs
         )
         update departs set places = places + maj.nb_voyageurs
         from maj
         where departs.trajet_id = maj.trajet_id and departs.date_voyage = maj.date_voyage`,
        [reservation.id]
      );
    }

    return json(200, { statut });
  } catch (err) {
    console.error('GET /paiement/statut', err);
    return erreur(502, 'Impossible de vérifier le statut auprès de l\u2019opérateur.');
  }
};
