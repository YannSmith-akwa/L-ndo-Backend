const { getSql } = require('./_lib/db');
const { erreur, fichier, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');

function dateValide(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// Séparateur point-virgule plutôt que virgule : Excel en locale
// française (celle de vos comptables) lit une virgule comme séparateur
// décimal, pas de colonne — un CSV virgule s'ouvre alors en une seule
// colonne illisible. Le point-virgule est la convention correcte ici,
// pas un choix arbitraire.
const SEPARATEUR = ';';

function champCsv(valeur) {
  const texte = valeur === null || valeur === undefined ? '' : String(valeur);
  return /[;"\n]/.test(texte) ? `"${texte.replace(/"/g, '""')}"` : texte;
}

function versCsv(entetes, lignes) {
  const corps = [entetes, ...lignes]
    .map((ligne) => ligne.map(champCsv).join(SEPARATEUR))
    .join('\r\n');
  return corps + '\r\n';
}

// Nom de fichier lisible, période incluse si filtrée — évite que deux
// exports téléchargés le même jour s'écrasent silencieusement dans le
// dossier Téléchargements du comptable.
function nomFichier(type, depuis, jusqua) {
  const periode = depuis || jusqua ? `_${depuis || 'debut'}_${jusqua || 'fin'}` : '_tout';
  return `londo-${type}${periode}.csv`;
}

// Limite de sûreté : au-delà, une fonction Netlify (10s par défaut)
// risque le timeout avant de finir de sérialiser le CSV. Largement
// suffisant au volume actuel (voir CHANGEMENTS-RBAC.md) — à revoir
// (pagination ou export asynchrone) si jamais atteinte en pratique.
const LIMITE_LIGNES = 50000;

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;
  if (event.httpMethod !== 'GET') return erreur(405, 'Méthode non autorisée');

  const qs = event.queryStringParameters || {};
  const type = qs.type;
  if (!['reservations', 'trajets', 'reversements'].includes(type)) {
    return erreur(400, 'type requis : reservations, trajets ou reversements.');
  }

  const depuis = qs.depuis;
  const jusqua = qs.jusqua;
  if (depuis !== undefined && !dateValide(depuis)) return erreur(400, 'depuis invalide (format attendu : AAAA-MM-JJ).');
  if (jusqua !== undefined && !dateValide(jusqua)) return erreur(400, 'jusqua invalide (format attendu : AAAA-MM-JJ).');
  const agenceId = qs.agenceId ? Number(qs.agenceId) : null;
  if (qs.agenceId !== undefined && (!Number.isInteger(agenceId) || agenceId < 1)) return erreur(400, 'agenceId invalide.');

  // Mêmes rôles autorisés que la vue équivalente déjà existante :
  // reservations/trajets → GET /admin/reservations et /admin/trajets ;
  // reversements → /admin/reversements (comptable uniquement, montants
  // agrégés par agence hors de portée de support_client).
  const rolesAutorises = type === 'reversements' ? ['comptable'] : ['comptable', 'support_client'];
  const acces = accesAdmin(event, rolesAutorises);
  if (!acces) return erreur(401, 'Accès administrateur requis.');

  try {
    const sql = getSql();

    if (type === 'reservations') {
      const clauses = [];
      const valeurs = [];
      if (depuis) { clauses.push(`r.cree_le >= $${valeurs.length + 1}::date`); valeurs.push(depuis); }
      if (jusqua) { clauses.push(`r.cree_le < ($${valeurs.length + 1}::date + interval '1 day')`); valeurs.push(jusqua); }
      if (agenceId) { clauses.push(`r.agence_id = $${valeurs.length + 1}`); valeurs.push(agenceId); }
      const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';

      const lignes = await sql(
        `select r.reference, a.nom as agence, t.depart, t.arrivee, t.heure,
                r.date_voyage, r.type_voyage, r.nb_voyageurs,
                r.nom_voyageur_principal, r.telephone_voyageur_principal,
                r.mode_paiement, r.total, r.statut, r.embarque_le, r.cree_le
         from reservations r
         join agences a on a.id = r.agence_id
         join trajets t on t.id = r.trajet_id
         ${ou}
         order by r.cree_le desc
         limit ${LIMITE_LIGNES}`,
        valeurs
      );

      const csv = versCsv(
        ['Référence', 'Agence', 'Départ', 'Arrivée', 'Heure', 'Date voyage', 'Type', 'Nb voyageurs', 'Voyageur', 'Téléphone', 'Mode paiement', 'Total (XAF)', 'Statut', 'Embarqué le', 'Créé le'],
        lignes.map((r) => [
          r.reference, r.agence, r.depart, r.arrivee, r.heure, r.date_voyage, r.type_voyage, r.nb_voyageurs,
          r.nom_voyageur_principal, r.telephone_voyageur_principal, r.mode_paiement, r.total, r.statut,
          r.embarque_le ? new Date(r.embarque_le).toISOString() : '',
          new Date(r.cree_le).toISOString(),
        ])
      );
      return fichier(nomFichier('reservations', depuis, jusqua), csv);
    }

    if (type === 'trajets') {
      const clauses = [];
      const valeurs = [];
      if (agenceId) { clauses.push(`t.agence_id = $${valeurs.length + 1}`); valeurs.push(agenceId); }
      const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';

      const lignes = await sql(
        `select a.nom as agence, t.depart, t.arrivee, t.heure, t.capacite
         from trajets t
         join agences a on a.id = t.agence_id
         ${ou}
         order by a.nom, t.depart, t.arrivee, t.heure
         limit ${LIMITE_LIGNES}`,
        valeurs
      );

      const csv = versCsv(
        ['Agence', 'Départ', 'Arrivée', 'Heure', 'Capacité'],
        lignes.map((t) => [t.agence, t.depart, t.arrivee, t.heure, t.capacite])
      );
      return fichier(nomFichier('trajets'), csv);
    }

    // reversements — période appliquée sur genere_le (date à laquelle
    // le calcul a été fait), pas periode_depuis/jusqua : c'est un
    // export de l'historique des calculs, pas un recalcul filtré.
    const clauses = [];
    const valeurs = [];
    if (depuis) { clauses.push(`rv.genere_le >= $${valeurs.length + 1}::date`); valeurs.push(depuis); }
    if (jusqua) { clauses.push(`rv.genere_le < ($${valeurs.length + 1}::date + interval '1 day')`); valeurs.push(jusqua); }
    if (agenceId) { clauses.push(`rv.agence_id = $${valeurs.length + 1}`); valeurs.push(agenceId); }
    const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';

    const lignes = await sql(
      `select a.nom as agence, rv.periode_depuis, rv.periode_jusqua, rv.ca_brut,
              rv.nombre_reservations, rv.commission_totale, rv.frais_passerelle,
              rv.net_a_reverser, rv.statut, rv.note, rv.genere_par_identifiant, rv.genere_le,
              rv.valide_le, rv.paye_le
       from reversements rv
       join agences a on a.id = rv.agence_id
       ${ou}
       order by rv.genere_le desc
       limit ${LIMITE_LIGNES}`,
      valeurs
    );

    const csv = versCsv(
      ['Agence', 'Période du', 'Période au', 'CA brut (XAF)', 'Nb réservations', 'Commission (XAF)', 'Frais passerelle (XAF)', 'Net à reverser (XAF)', 'Statut', 'Note', 'Généré par', 'Généré le', 'Validé le', 'Payé le'],
      lignes.map((r) => [
        r.agence, r.periode_depuis, r.periode_jusqua, r.ca_brut, r.nombre_reservations,
        r.commission_totale, r.frais_passerelle, r.net_a_reverser, r.statut, r.note || '',
        r.genere_par_identifiant, new Date(r.genere_le).toISOString(),
        r.valide_le ? new Date(r.valide_le).toISOString() : '',
        r.paye_le ? new Date(r.paye_le).toISOString() : '',
      ])
    );
    return fichier(nomFichier('reversements', depuis, jusqua), csv);
  } catch (err) {
    console.error('/admin/export', err);
    return erreur(500, 'Erreur serveur.');
  }
};
