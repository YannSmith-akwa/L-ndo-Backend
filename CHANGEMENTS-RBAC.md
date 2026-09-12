# RBAC + journal d'audit — récapitulatif (12/09/2026)

Implémentation de la fondation identifiée en premier : des identités
individuelles (côté back-office ET côté agence) pour que l'audit log
et les rapports de caisse par opérateur aient quelque chose à
attribuer. Rien d'existant n'est cassé : `ADMIN_TOKEN` et le compte
agence historique (`agences.identifiant`) continuent de fonctionner
exactement comme avant, en parallèle des nouveaux comptes individuels.

## 1. Base de données

Trois nouvelles tables ajoutées à `db/schema.sql` (section "RBAC —
comptes individuels..."), à appliquer avec `npm run migrate` :

- `utilisateurs_admin` — comptes back-office individuels, rôle
  `super_admin` / `comptable` / `support_client`.
- `employes_agence` — comptes employé individuels par agence, rôle
  `chef_agence` / `agent_guichet`.
- `journal_audit` — une ligne par action de modification, acteur
  dénormalisé (survit à la suppression du compte).

Aucune variable d'environnement supplémentaire : tout repose sur
`AUTH_JWT_SECRET` et `ADMIN_TOKEN`, déjà en place.

## 2. Nouveaux endpoints

| Route | Rôle requis | Fonction |
|---|---|---|
| `POST /api/admin/connexion` | — | Connexion d'un compte back-office individuel |
| `GET/POST/PUT/DELETE /api/admin/utilisateurs` | `super_admin` | Gestion des comptes back-office |
| `GET /api/admin/audit` | `super_admin` | Consultation du journal d'audit (filtres `acteurType`, `action`, `depuis`, `jusqua`, `limite`) |
| `POST /api/employe/connexion` | — | Connexion d'un employé d'agence |
| `GET/POST/PUT/DELETE /api/agence/employes` | `chef_agence` / compte agence | Gestion des agents de guichet de sa propre agence |

## 3. Matrice de droits appliquée (déjà discutée)

**Back-office** (`_lib/rbac.js`, `accesAdmin(event, rolesAutorises)`) :
- `admin-agences.js` : GET → super_admin + comptable ; POST/PUT/DELETE
  → super_admin uniquement.
- `admin-trajets.js` : GET → tous rôles admin ; POST/PUT/DELETE →
  super_admin uniquement.
- `admin-tarifs.js` : GET/PUT → super_admin + comptable (le comptable a
  explicitement le droit de configurer la commission).
- `admin-reservations.js` : GET → tous rôles admin (support_client en
  a besoin pour retrouver un billet).

**Agence** (`_lib/auth.js`, `identiteAgence(event)`) :
- `agence-trajets.js` : PUT → `proprietaire` (compte historique) et
  `chef_agence` uniquement, pas `agent_guichet`.
- `agence-statistiques.js` : entièrement bloqué pour `agent_guichet`
  (chiffre d'affaires global hors de sa portée).
- `agence-reservations.js`, `agence-embarquement.js` : inchangés,
  ouverts à tous les rôles agence (c'est le travail du guichet).

## 4. ADMIN_TOKEN : ce qui change et ce qui ne change pas

`ADMIN_TOKEN` reste accepté partout où il l'était (`_lib/rbac.js` le
vérifie en premier, avant les comptes individuels) — **rien ne casse
en production tant que vous ne migrez pas**. Mais un accès par
`ADMIN_TOKEN` est journalisé comme acteur `"ADMIN_TOKEN (legacy)"`,
sans identité réelle : il n'apporte donc pas la traçabilité
individuelle qui est tout l'intérêt de ce chantier. Le token doit
rester un accès de bootstrap/secours, pas l'accès quotidien.

## 5. Mise en route

1. `npm run migrate` (ou coller le nouveau bloc de `schema.sql` dans
   Neon).
2. Créer le premier compte `super_admin` : `POST /api/admin/utilisateurs`
   avec l'en-tête `X-Admin-Token` (votre `ADMIN_TOKEN` actuel), puis
   basculer sur `POST /api/admin/connexion` pour obtenir un vrai jeton
   individuel.
3. Pour chaque agence qui veut des comptes guichet individuels, le
   chef d'agence (connecté via `agence-connexion.js`, compte
   historique = droits `chef_agence`) crée ses agents via
   `POST /api/agence/employes`.

## 6. Ce qui n'est PAS fait ici (hors périmètre de ce lot)

- Aucune interface (`londo-backoffice-2.html` / `agence.html`) n'a été
  modifiée — ces endpoints sont prêts, mais les écrans de connexion et
  de gestion des comptes/rôles restent à construire côté front.
- Le journal d'audit ne couvre pour l'instant que les actions
  identifiées comme sensibles (agences, trajets, tarifs, comptes) —
  pas encore l'embarquement (trop fréquent, faible valeur d'audit) ni
  les futurs modules (reversements, petite caisse) qui devront
  appeler `enregistrerAudit()` eux-mêmes le moment venu.
- Export CSV, manifeste de route, vente au guichet, gestion des aléas
  SMS : toujours dans l'ordre convenu, à construire ensuite — ce lot
  se limite à la fondation RBAC + audit.
