// Journalisation des actions de modification (back-office + espace
// agence) dans journal_audit — voir schema.sql, RBAC 12/09/2026.
//
// Best-effort volontaire : un échec d'écriture du journal ne doit
// jamais faire échouer l'action métier elle-même — au moment où on
// appelle enregistrerAudit(), la modification (insert/update/delete) a
// déjà eu lieu et a déjà été renvoyée ou est sur le point de l'être.
// D'où le try/catch qui se contente d'un console.error plutôt que de
// remonter l'erreur à l'appelant.

function ipAppelant(event) {
  // x-forwarded-for peut contenir une liste "client, proxy1, proxy2" —
  // seul le premier maillon nous intéresse (IP du navigateur appelant).
  const entete = event.headers?.['x-nf-client-connection-ip']
    || event.headers?.['x-forwarded-for']
    || '';
  return entete.split(',')[0].trim() || null;
}

async function enregistrerAudit(sql, event, { acteurType, acteurId, acteurIdentifiant, acteurRole, action, cibleType, cibleId, details }) {
  try {
    await sql(
      `insert into journal_audit
         (acteur_type, acteur_id, acteur_identifiant, acteur_role, action, cible_type, cible_id, details, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        acteurType,
        acteurId ?? null,
        acteurIdentifiant,
        acteurRole ?? null,
        action,
        cibleType ?? null,
        cibleId !== undefined && cibleId !== null ? String(cibleId) : null,
        details ? JSON.stringify(details) : null,
        ipAppelant(event),
      ]
    );
  } catch (err) {
    console.error("journal_audit (échec ignoré, n'affecte pas l'action déjà effectuée)", err);
  }
}

module.exports = { enregistrerAudit };
