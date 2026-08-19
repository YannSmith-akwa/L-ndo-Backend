// Fonction planifiée (voir netlify.toml : [functions."expirer-reservations"]
// schedule = "*/10 * * * *", toutes les 10 minutes).
//
// Correctif (voir audit, point 1.4) : sans elle, une réservation dont le
// client abandonne le paiement (ferme l'app, perd le réseau, laisse le
// polling de statut expirer côté client sans jamais revenir) restait
// 'en_attente' pour toujours, et les places qu'elle occupait n'étaient
// JAMAIS rendues au stock — le code le reconnaissait lui-même en
// commentaire ("à affiner plus tard"). Cette fonction fait ce ménage
// côté serveur, indépendamment du client.
//
// En profite aussi pour purger les vieilles lignes otp_tentatives (voir
// audit, point 3.5) et tentatives_connexion (même logique, ajoutée avec
// les comptes agence — sans purge, ces deux tables grossiraient sans
// limite à mesure que le volume réel augmente).

const { getSql } = require('./_lib/db');

const DELAI_EXPIRATION_MINUTES = 20;
const RETENTION_OTP_JOURS = 2;
const RETENTION_CONNEXION_JOURS = 2;

exports.handler = async () => {
  try {
    const sql = getSql();

    // Bascule + recrédit atomique, même logique que le cas 'echoue' de
    // paiement-statut.js : une seule instruction, sans risque de
    // double-recrédit si cette fonction et un appel de statut
    // s'exécutent au même moment sur la même réservation (le WHERE
    // statut = 'en_attente' rend l'opération idempotente).
    const expirees = await sql(
      `with a_expirer as (
         update reservations set statut = 'expire'
         where statut = 'en_attente' and cree_le < now() - interval '${DELAI_EXPIRATION_MINUTES} minutes'
         returning id, trajet_id, date_voyage, nb_voyageurs
       ),
       recredit as (
         update departs set places = departs.places + a_expirer.nb_voyageurs
         from a_expirer
         where departs.trajet_id = a_expirer.trajet_id and departs.date_voyage = a_expirer.date_voyage
         returning a_expirer.id
       )
       select count(*)::int as n from a_expirer`
    );

    const purgeOtp = await sql(
      `delete from otp_tentatives where cree_le < now() - interval '${RETENTION_OTP_JOURS} days' returning id`
    );
    const purgeConnexion = await sql(
      `delete from tentatives_connexion where cree_le < now() - interval '${RETENTION_CONNEXION_JOURS} days' returning id`
    );

    console.log(`expirer-reservations : ${expirees[0]?.n ?? 0} réservation(s) expirée(s), ${purgeOtp.length} tentative(s) OTP purgée(s), ${purgeConnexion.length} tentative(s) de connexion purgée(s).`);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('expirer-reservations', err);
    // Toujours 200 : Netlify considère un statut non-2xx comme un échec
    // d'exécution planifiée à re-notifier, mais on a déjà loggé
    // l'erreur — pas besoin d'alerte supplémentaire pour un job qui
    // retentera de toute façon 10 minutes plus tard.
    return { statusCode: 200, body: 'erreur loggée' };
  }
};
