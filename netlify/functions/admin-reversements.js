const { getSql } = require('./_lib/db');
const { json, erreur, reponsePreliminaireCORS } = require('./_lib/reponse');
const { accesAdmin } = require('./_lib/rbac');
const { enregistrerAudit } = require('./_lib/audit');

function dateValide(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function entierPositifOuNul(n) {
  return Number.isInteger(n) && n >= 0;
}

// Comptage + somme des réservations "payé" de cette agence sur la
// période (bornée sur la date d'ACHAT, cree_le — voir schema.sql),
// PAS ENCORE incluses dans un reversement précédent. Utilisée pour
// l'aperçu (lecture seule) et comme garde avant génération — la
// génération elle-même (voir plus bas) refait ce calcul dans la même
// requête que le verrouillage, pour rester cohérente même si une
// nouvelle réservation arrive entre les deux.
async function calculerEligibles(sql, agenceId, depuis, jusqua) {
  const [ligne] = await sql(
    `select coalesce(sum(r.total), 0)::int as "caBrut", count(*)::int as "nombreReservations"
     from reservations r
     where r.agence_id = $1
       and r.statut = 'payé'
       and r.cree_le >= $2::date
       and r.cree_le < ($3::date + interval '1 day')
       and not exists (select 1 from reversement_reservations rr where rr.reservation_id = r.id)`,
    [agenceId, depuis, jusqua]
  );
  return ligne;
}

exports.handler = async (event) => {
  const preliminaire = reponsePreliminaireCORS(event);
  if (preliminaire) return preliminaire;

  // Les reversements sont un prolongement direct de "configurer la
  // commission de service" et "consulter les revenus", déjà dans le
  // périmètre du comptable — voir la matrice de droits. Hors de portée
  // de support_client (aucun rapport avec son travail, et ça expose
  // des montants agrégés par agence).
  const acces = accesAdmin(event, ['comptable']);
  if (!acces) return erreur(401, 'Accès administrateur requis.');

  const sql = getSql();
  const acteur = { acteurType: 'admin', acteurId: acces.id, acteurIdentifiant: acces.identifiant, acteurRole: acces.role };

  try {
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};

      // ── Aperçu (lecture seule, ne touche à rien) ──
      if (qs.apercu) {
        const agenceId = Number(qs.agenceId);
        if (!Number.isInteger(agenceId) || agenceId < 1) return erreur(400, 'agenceId requis.');
        if (!dateValide(qs.depuis) || !dateValide(qs.jusqua)) return erreur(400, 'depuis et jusqua requis (AAAA-MM-JJ).');
        if (qs.jusqua < qs.depuis) return erreur(400, 'jusqua doit être postérieur ou égal à depuis.');

        const [{ commission }] = await sql('select commission from tarifs where id = 1');
        const { caBrut, nombreReservations } = await calculerEligibles(sql, agenceId, qs.depuis, qs.jusqua);
        const commissionTotale = nombreReservations * commission;
        return json(200, {
          caBrut, nombreReservations, commissionUnitaire: commission, commissionTotale,
          netAvantFraisPasserelle: caBrut - commissionTotale,
        });
      }

      // ── Détail d'un reversement précis ──
      if (qs.id) {
        const [r] = await sql(
          `select rv.*, a.nom as "agenceNom" from reversements rv join agences a on a.id = rv.agence_id where rv.id = $1`,
          [qs.id]
        );
        if (!r) return erreur(404, 'Reversement introuvable.');
        return json(200, { reversement: r });
      }

      // ── Liste, filtrable par agence et/ou statut ──
      const clauses = [];
      const valeurs = [];
      if (qs.agenceId) { clauses.push(`rv.agence_id = $${valeurs.length + 1}`); valeurs.push(Number(qs.agenceId)); }
      if (qs.statut) { clauses.push(`rv.statut = $${valeurs.length + 1}`); valeurs.push(qs.statut); }
      const ou = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const reversements = await sql(
        `select rv.id, rv.agence_id as "agenceId", a.nom as "agenceNom",
                rv.periode_depuis as "periodeDepuis", rv.periode_jusqua as "periodeJusqua",
                rv.ca_brut as "caBrut", rv.nombre_reservations as "nombreReservations",
                rv.commission_totale as "commissionTotale", rv.frais_passerelle as "fraisPasserelle",
                rv.net_a_reverser as "netAReverser", rv.statut, rv.note,
                rv.genere_par_identifiant as "generateParIdentifiant", rv.genere_le as "genereLe",
                rv.valide_le as "valideLe", rv.paye_le as "payeLe"
         from reversements rv
         join agences a on a.id = rv.agence_id
         ${ou}
         order by rv.genere_le desc
         limit 200`,
        valeurs
      );
      return json(200, { reversements });
    }

    // ── Génération : calcule ET verrouille les réservations, en une
    // seule requête SQL (CTE à écritures multiples) pour que le
    // montant enregistré et l'ensemble verrouillé soient TOUJOURS
    // rigoureusement le même jeu de réservations — même si un paiement
    // se termine pile entre l'aperçu et cet appel. ──
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const agenceId = Number(body.agenceId);
      if (!Number.isInteger(agenceId) || agenceId < 1) return erreur(400, 'agenceId requis.');
      if (!dateValide(body.periodeDepuis) || !dateValide(body.periodeJusqua)) {
        return erreur(400, 'periodeDepuis et periodeJusqua requis (AAAA-MM-JJ).');
      }
      if (body.periodeJusqua < body.periodeDepuis) return erreur(400, 'periodeJusqua doit être postérieur ou égal à periodeDepuis.');
      const fraisPasserelle = body.fraisPasserelle !== undefined ? Number(body.fraisPasserelle) : 0;
      if (!entierPositifOuNul(fraisPasserelle)) return erreur(400, 'fraisPasserelle doit être un entier positif ou nul.');
      const note = body.note?.trim() || null;

      const [agenceExistante] = await sql('select id from agences where id = $1', [agenceId]);
      if (!agenceExistante) return erreur(404, 'Agence introuvable.');

      // Garde-fou avant de se lancer dans la CTE d'écriture : évite de
      // créer un reversement vide (0 réservation, net = -fraisPasserelle)
      // si rien n'est éligible sur la période.
      const apercu = await calculerEligibles(sql, agenceId, body.periodeDepuis, body.periodeJusqua);
      if (apercu.nombreReservations === 0) {
        return erreur(409, "Aucune réservation payée, non déjà reversée, sur cette période pour cette agence.");
      }

      const [{ commission }] = await sql('select commission from tarifs where id = 1');

      const [reversement] = await sql(
        `with eligibles as (
           select r.id, r.total
           from reservations r
           where r.agence_id = $1
             and r.statut = 'payé'
             and r.cree_le >= $2::date
             and r.cree_le < ($3::date + interval '1 day')
             and not exists (select 1 from reversement_reservations rr where rr.reservation_id = r.id)
           for update of r
         ),
         nouveau as (
           insert into reversements (
             agence_id, periode_depuis, periode_jusqua, ca_brut, nombre_reservations,
             commission_unitaire, commission_totale, frais_passerelle, net_a_reverser,
             note, genere_par_type, genere_par_id, genere_par_identifiant
           )
           select
             $1, $2::date, $3::date,
             coalesce(sum(e.total), 0)::int,
             count(e.*)::int,
             $4::int,
             (count(e.*) * $4::int)::int,
             $5::int,
             (coalesce(sum(e.total), 0) - (count(e.*) * $4::int) - $5::int)::int,
             $6, $7, $8, $9
           from eligibles e
           returning *
         ),
         verrou as (
           insert into reversement_reservations (reversement_id, reservation_id)
           select nouveau.id, eligibles.id from eligibles, nouveau
           returning 1
         )
         select * from nouveau`,
        [agenceId, body.periodeDepuis, body.periodeJusqua, commission, fraisPasserelle, note, acteur.acteurType, acteur.acteurId, acteur.acteurIdentifiant]
      );

      await enregistrerAudit(sql, event, {
        ...acteur, action: 'reversement.generer', cibleType: 'reversement', cibleId: reversement.id,
        details: {
          agenceId, periode: `${body.periodeDepuis} → ${body.periodeJusqua}`,
          caBrut: reversement.ca_brut, netAReverser: reversement.net_a_reverser,
          nombreReservations: reversement.nombre_reservations,
        },
      });
      return json(201, { id: reversement.id, netAReverser: reversement.net_a_reverser });
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) return erreur(400, 'id requis.');
      const [existant] = await sql('select id, statut from reversements where id = $1', [body.id]);
      if (!existant) return erreur(404, 'Reversement introuvable.');

      // Correction des champs saisis manuellement : seulement tant que
      // le reversement est encore un brouillon — une fois validé, les
      // montants sont un engagement, pas un formulaire à retoucher.
      if (body.fraisPasserelle !== undefined || body.note !== undefined) {
        if (existant.statut !== 'brouillon') return erreur(409, 'Seul un reversement en brouillon peut être corrigé.');
        const champs = [];
        const valeurs = [];
        if (body.fraisPasserelle !== undefined) {
          const fraisPasserelle = Number(body.fraisPasserelle);
          if (!entierPositifOuNul(fraisPasserelle)) return erreur(400, 'fraisPasserelle doit être un entier positif ou nul.');
          champs.push(`frais_passerelle = $${champs.length + 1}`); valeurs.push(fraisPasserelle);
          champs.push(`net_a_reverser = ca_brut - commission_totale - $${champs.length}`);
        }
        if (body.note !== undefined) {
          champs.push(`note = $${champs.length + 1}`); valeurs.push(body.note?.trim() || null);
        }
        valeurs.push(body.id);
        const [r] = await sql(`update reversements set ${champs.join(', ')} where id = $${valeurs.length} returning net_a_reverser as "netAReverser"`, valeurs);
        await enregistrerAudit(sql, event, {
          ...acteur, action: 'reversement.corriger', cibleType: 'reversement', cibleId: body.id,
          details: { fraisPasserelle: body.fraisPasserelle, note: body.note },
        });
        return json(200, { ok: true, netAReverser: r.netAReverser });
      }

      // Transition de statut — dans un seul sens (brouillon → validé →
      // payé), jamais en arrière : "payé" affirme que l'argent a
      // effectivement quitté le compte de la plateforme, ça ne se
      // dévalide pas d'un clic accidentel.
      if (body.statut !== undefined) {
        const suivant = { brouillon: 'valide', valide: 'paye' };
        if (suivant[existant.statut] !== body.statut) {
          return erreur(409, `Transition invalide : un reversement "${existant.statut}" ne peut passer qu'à "${suivant[existant.statut] || 'aucun statut suivant'}".`);
        }
        const colonneDate = body.statut === 'valide' ? 'valide_le' : 'paye_le';
        await sql(`update reversements set statut = $1, ${colonneDate} = now() where id = $2`, [body.statut, body.id]);
        await enregistrerAudit(sql, event, {
          ...acteur, action: `reversement.marquer_${body.statut}`, cibleType: 'reversement', cibleId: body.id,
        });
        return json(200, { ok: true });
      }

      return erreur(400, 'Aucun champ à modifier.');
    }

    // Annulation : uniquement un brouillon (cascade sur
    // reversement_reservations libère les réservations concernées,
    // elles redeviennent éligibles à un futur calcul).
    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters?.id;
      if (!id) return erreur(400, 'id requis.');
      const [existant] = await sql('select statut from reversements where id = $1', [id]);
      if (!existant) return erreur(404, 'Reversement introuvable.');
      if (existant.statut !== 'brouillon') return erreur(409, 'Seul un reversement en brouillon peut être annulé.');
      await sql('delete from reversements where id = $1', [id]);
      await enregistrerAudit(sql, event, { ...acteur, action: 'reversement.annuler', cibleType: 'reversement', cibleId: id });
      return json(200, { ok: true });
    }

    return erreur(405, 'Méthode non autorisée');
  } catch (err) {
    console.error('/admin/reversements', err);
    return erreur(500, 'Erreur serveur.');
  }
};
