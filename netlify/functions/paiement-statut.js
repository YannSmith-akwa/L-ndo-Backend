const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const momo = require('./_lib/momo');
const orange = require('./_lib/orange');

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const reference = event.queryStringParameters?.reference;
  if (!reference) return erreur(400, 'reference requise.');

  // Endpoint volontairement laissé public (pas d'Authorization requis) :
  // il ne renvoie qu'un statut, jamais de données personnelles, et la
  // référence est désormais générée par séquence (non devinable en
  // pratique) plutôt que par 5 chiffres aléatoires — voir schema.sql.
  try {
    const sql = getSql();
    const [reservation] = await sql.query(
      `select id, total, statut, mode_paiement as "modePaiement",
              reference_operateur as "referenceOperateur", jeton_operateur as "jetonOperateur"
       from reservations where reference = $1`,
      [reference]
    );
    if (!reservation) return erreur(404, 'Réservation introuvable.');

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
      await sql.query(`update reservations set statut = 'payé' where id = $1 and statut = 'en_attente'`, [reservation.id]);
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
      await sql.query(
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
