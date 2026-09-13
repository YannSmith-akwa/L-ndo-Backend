-- ════════════════════════════════════════════════════════════
-- Schéma Lōndo — à exécuter une fois sur votre base Neon
-- (tableau de bord Neon > SQL Editor, ou `npm run migrate`)
-- ════════════════════════════════════════════════════════════
-- Changements par rapport à la version précédente (audit du 13/08/2026) :
--   • trajets.places → trajets.capacite : c'est désormais la capacité
--     NOMINALE du créneau (ex. "United Express 05h30" a 6 sièges), pas
--     un compteur qui se vide pour toujours. Le stock réellement
--     disponible vit maintenant dans la nouvelle table `departs`,
--     scindée par DATE — voir son commentaire ci-dessous. C'est le
--     correctif du bug le plus grave de l'audit (un trajet ne pouvait
--     auparavant être vendu qu'une fois dans toute son existence).
--   • reservations.reduction_fidelite supprimé : l'option fidélité est
--     retirée de l'application (backend + client).
--   • reservations.jeton_operateur ajouté : stocke le pay_token Orange
--     Money (nécessaire à la vérification de statut), inutilisé pour MTN.
--   • reservations.paiement_initie_le ajouté : empêche de redéclencher
--     un prompt USSD/paiement tant qu'une tentative précédente est
--     encore récente (double-tap, retry réseau).
--   • ajout d'une contrainte unique sur trajets(agence_id, depart,
--     arrivee, heure) : sans elle, ré-exécuter ce script dupliquait les
--     trajets de départ à chaque fois (le "on conflict do nothing" de
--     l'ancien script n'avait aucune cible réelle sur une colonne serial).
--   • ajout de reservations_ref_seq : les références de réservation
--     utilisaient 5 chiffres aléatoires (100 000 combinaisons par
--     agence/an) — collisions probables dès ~370 réservations/an par
--     agence. Une séquence garantit l'unicité, sans probabilité.
--   • agences.identifiant / agences.mot_de_passe_hash ajoutés : chaque
--     agence peut désormais avoir son propre compte (identifiant + mot
--     de passe, défini par l'administrateur depuis le back-office) pour
--     voir ses propres réservations et gérer ses propres trajets
--     (horaires, capacité) sans jamais voir les données des autres
--     agences. Table tentatives_connexion ajoutée pour limiter les
--     essais de mot de passe, sur le même principe que otp_tentatives.
--   • otp_tentatives.ip ajouté : l'anti-abus OTP ne limitait que par
--     numéro de téléphone (5 envois / 15 min) — un script ciblant
--     beaucoup de numéros différents depuis une même source n'était pas
--     freiné. Même limite, appliquée en plus par IP.
--
-- Changements du 22/08/2026 (audit indépendant) :
--   • paiement_tentatives ajouté : limite le nombre de prompts de
--     paiement (MTN/Orange) déclenchables vers un même numéro cible sur
--     15 min, indépendamment du cooldown de 30s par réservation — voir
--     paiement-initier.js.
--
-- Pour le back-office (admin-trajets.js, admin-agences.js, etc.) :
-- aucune table supplémentaire n'est nécessaire, ADMIN_TOKEN se
-- configure uniquement comme variable d'environnement Netlify.
--
-- ⚠️ Si ce schéma a déjà été appliqué sur une base contenant des
-- données réelles, ce fichier ne migre PAS automatiquement l'existant
-- (create table if not exists ne modifie pas une table déjà créée).
-- Voir le bloc de migration tout en bas de ce fichier.

create table if not exists agences (
  id serial primary key,
  nom text not null,
  couleur text not null,
  couleur_pale text not null,
  slogan text,
  tel text,
  note numeric(2,1),
  -- Compte de connexion au back-office, propre à cette agence. Nuls par
  -- défaut : une agence n'a d'accès qu'une fois ses identifiants définis
  -- par l'administrateur (voir admin-agences.js, PUT).
  identifiant text unique,
  mot_de_passe_hash text
);

create table if not exists trajets (
  id serial primary key,
  agence_id integer not null references agences(id) on delete cascade,
  depart text not null,
  arrivee text not null,
  heure text not null,          -- format "05h30", identique au client
  capacite integer not null default 0 check (capacite >= 0),
  unique (agence_id, depart, arrivee, heure)
);

-- Stock RÉELLEMENT disponible pour un trajet à UNE date précise. Une
-- ligne est créée à la volée (voir reservations.js) au premier client
-- qui vise ce couple (trajet, date), initialisée à trajets.capacite.
-- `places` y est ensuite décrémenté à chaque réservation et recrédité
-- si le paiement échoue/expire — exactement comme l'ancien
-- trajets.places, mais correctement isolé par jour.
create table if not exists departs (
  id serial primary key,
  trajet_id integer not null references trajets(id) on delete cascade,
  date_voyage date not null,
  places integer not null check (places >= 0),
  unique (trajet_id, date_voyage)
);

-- Ligne unique (id fixé à 1) : les tarifs sont globaux, pas par agence,
-- exactement comme dans le client (GET /tarifs).
create table if not exists tarifs (
  id integer primary key default 1,
  prix_simple integer not null,
  prix_ar integer not null,
  commission integer not null,
  constraint ligne_unique check (id = 1)
);

create table if not exists utilisateurs (
  id serial primary key,
  telephone text unique not null,
  nom text,
  cree_le timestamptz not null default now()
);

-- Génère des références de réservation sans collision possible
-- (remplace les 5 chiffres aléatoires de l'ancienne version).
create sequence if not exists reservations_ref_seq;

create table if not exists reservations (
  id serial primary key,
  reference text unique not null,
  agence_id integer not null references agences(id),
  trajet_id integer not null references trajets(id),
  -- Numéro du compte authentifié (dérivé du jeton émis après OTP côté
  -- serveur — voir _lib/auth.js — jamais accepté tel quel depuis le
  -- corps de la requête). Laissé nullable ici pour ne pas casser une
  -- éventuelle base déjà peuplée ; l'application le renseigne toujours.
  telephone_compte text,
  nom_voyageur_principal text not null,
  telephone_voyageur_principal text not null,
  telephone_paiement text not null,
  piece_id text not null,
  date_voyage date not null,
  type_voyage text not null check (type_voyage in ('simple', 'ar')),
  nb_voyageurs integer not null check (nb_voyageurs >= 1),
  mode_paiement text not null check (mode_paiement in ('mtn_momo', 'orange_money')),
  total integer not null,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'payé', 'echoue', 'expire')),
  reference_operateur text,                 -- X-Reference-Id (MTN) / order_id (Orange)
  jeton_operateur text,                     -- pay_token Orange Money (redirection) ; inutilisé pour MTN
  paiement_initie_le timestamptz,           -- horodatage du dernier appel initier (anti double-prompt, voir paiement-initier.js)
  embarque_le timestamptz,                  -- horodatage du contrôle à l'embarquement (voir agence-embarquement.js) — non nul = billet déjà utilisé
  cle_idempotence text,                     -- UUID généré côté client (voir reservations.js) : évite une double création si le réseau coupe après une création réussie mais avant que la réponse n'arrive
  cree_le timestamptz not null default now()
);

create index if not exists idx_reservations_reference on reservations(reference);
-- Utile pour la fonction planifiée d'expiration (expirer-reservations.js).
create index if not exists idx_reservations_expiration on reservations(statut, cree_le);
-- Idempotence (voir audit du 27/08/2026) : garantit qu'une même clé, pour
-- un même compte, ne peut correspondre qu'à une seule réservation — même
-- sous requêtes concurrentes (contrainte vérifiée par Postgres à l'insert,
-- pas seulement par le SELECT préalable dans reservations.js). Le filtre
-- `where cle_idempotence is not null` évite que les anciennes lignes sans
-- clé (avant ce correctif) ne se bloquent entre elles.
create unique index if not exists idx_reservations_idempotence on reservations(telephone_compte, cle_idempotence) where cle_idempotence is not null;
-- Tableau de bord agence (voir audit-technique-londo.md et le suivi du
-- 29/08/2026) : agence-reservations.js filtre par agence_id et trie par
-- cree_le desc — sans index dédié, scan séquentiel de toute la table à
-- chaque ouverture du tableau de bord. Sans impact au volume actuel,
-- se dégraderait avec plusieurs mois d'historique réel.
create index if not exists idx_reservations_agence on reservations(agence_id, cree_le desc);

create table if not exists voyageurs (
  id serial primary key,
  reservation_id integer not null references reservations(id) on delete cascade,
  nom text not null,
  telephone text not null,
  piece_id text not null
);

-- Anti-abus léger sur l'envoi de codes OTP (Twilio Verify gère le code
-- lui-même : on ne stocke ici que la fréquence d'envoi par numéro,
-- toujours normalisé en E.164 avant stockage — voir _lib/telephone.js).
create table if not exists otp_tentatives (
  id serial primary key,
  telephone text not null,
  ip text,
  cree_le timestamptz not null default now()
);
create index if not exists idx_otp_tentatives on otp_tentatives(telephone, cree_le);
create index if not exists idx_otp_tentatives_ip on otp_tentatives(ip, cree_le);

-- Anti-abus sur les tentatives de connexion agence (identifiant + mot de
-- passe) — même principe que otp_tentatives, pour limiter le brute-force.
create table if not exists tentatives_connexion (
  id serial primary key,
  identifiant text not null,
  cree_le timestamptz not null default now()
);
create index if not exists idx_tentatives_connexion on tentatives_connexion(identifiant, cree_le);

-- Anti-abus sur l'initiation de paiement, par numéro CIBLE (voir audit du
-- 22/08/2026) : sans cette limite, un compte authentifié peut, via
-- reservations.js, créer des réservations à volonté puis déclencher un
-- prompt USSD MTN/Orange vers N'IMPORTE QUEL numéro camerounais de son
-- choix (telephone_paiement, distinct du compte par conception) — un
-- vecteur de harcèlement via l'infrastructure de paiement de l'app,
-- indépendant du cooldown de 30s qui ne protège qu'UNE réservation.
-- Dimension IP ajoutée le 31/08/2026 (voir simulation d'attaque, point
-- « limite contournable avec plusieurs numéros réels ») : la limite par
-- numéro cible seule n'arrête pas un attaquant avec plusieurs comptes
-- vérifiés, chacun visant une victime différente. Seuil volontairement
-- large côté IP (20, contre 5 par numéro cible, voir
-- paiement-initier.js) : plusieurs vrais clients au même comptoir/même
-- Wi-Fi ne doivent pas se bloquer les uns les autres sur un chemin qui
-- touche de l'argent réel — seul un script qui arrose beaucoup de
-- numéros depuis une seule source doit finir par buter dessus.
create table if not exists paiement_tentatives (
  id serial primary key,
  telephone text not null,
  ip text,
  cree_le timestamptz not null default now()
);
create index if not exists idx_paiement_tentatives on paiement_tentatives(telephone, cree_le);
create index if not exists idx_paiement_tentatives_ip on paiement_tentatives(ip, cree_le);

-- ────────────────────────────────────────────────────────────
-- RBAC — comptes individuels back-office et agence (12/09/2026)
--
-- Avant ces tables, deux angles morts empêchaient toute traçabilité
-- individuelle :
--   • le back-office entier partageait un seul ADMIN_TOKEN (variable
--     d'environnement) — n'importe qui en possession de ce jeton peut
--     supprimer une agence ou un trajet définitivement, sans qu'aucune
--     ligne ne dise QUI l'a fait ;
--   • un compte agence (agences.identifiant) est partagé par toute
--     l'équipe de l'agence — impossible de distinguer une action du
--     chef d'agence de celle d'un agent de guichet.
--
-- utilisateurs_admin donne au back-office de vrais comptes individuels
-- avec un rôle (super_admin / comptable / support_client). employes_agence
-- fait la même chose côté agence (chef_agence / agent_guichet), en plus
-- du compte "agence" historique (agences.identifiant) qui continue de
-- fonctionner comme un compte à tout faire, pour la transition — voir
-- netlify/functions/_lib/rbac.js et _lib/auth.js pour la logique
-- d'autorisation, journal_audit plus bas pour ce que chaque action
-- laisse comme trace.
create table if not exists utilisateurs_admin (
  id serial primary key,
  identifiant text unique not null,
  mot_de_passe_hash text not null,
  nom text,
  role text not null check (role in ('super_admin', 'comptable', 'support_client')),
  actif boolean not null default true,
  cree_le timestamptz not null default now()
);

create table if not exists employes_agence (
  id serial primary key,
  agence_id integer not null references agences(id) on delete cascade,
  identifiant text unique not null,
  mot_de_passe_hash text not null,
  nom text,
  -- chef_agence : mêmes droits que le compte agence historique.
  -- agent_guichet : embarquement + vente au guichet, sans accès aux
  -- tarifs/trajets ni au chiffre d'affaires global de l'agence (même
  -- logique que support_client côté back-office).
  role text not null check (role in ('chef_agence', 'agent_guichet')),
  actif boolean not null default true,
  cree_le timestamptz not null default now()
);

-- Piste d'audit : une ligne par action de modification effectuée depuis
-- le back-office ou l'espace agence. acteur_identifiant/acteur_role sont
-- dénormalisés (copiés tels quels au moment de l'action) pour que le
-- journal reste lisible même si le compte est renommé ou supprimé par
-- la suite — jamais de jointure vivante vers utilisateurs_admin/
-- employes_agence depuis une ligne déjà écrite.
create table if not exists journal_audit (
  id serial primary key,
  acteur_type text not null check (acteur_type in ('admin', 'agence')),
  acteur_id integer,
  acteur_identifiant text not null,
  acteur_role text,
  action text not null,
  cible_type text,
  cible_id text,
  details jsonb,
  ip text,
  cree_le timestamptz not null default now()
);
create index if not exists idx_journal_audit_cree_le on journal_audit(cree_le desc);
create index if not exists idx_journal_audit_acteur on journal_audit(acteur_type, acteur_id);

-- ────────────────────────────────────────────────────────────
-- Reversements comptables (13/09/2026)
--
-- Décisions prises avec le client avant d'écrire cette table (voir
-- CHANGEMENTS-RBAC.md section 9 pour le détail) :
--   • Frais de passerelle : saisis MANUELLEMENT par le comptable à la
--     génération (frais_passerelle) — aucun frais réel MTN/Orange
--     n'est capturé ailleurs dans le modèle de données actuel.
--   • Remboursements : volontairement HORS PÉRIMÈTRE de ce calcul —
--     une réservation remboursée hors système reste comptée comme
--     "payé" ici. `note` sert à documenter ces cas connus à la main
--     en attendant un vrai statut 'remboursé' sur reservations.
--   • Période : bornée sur la date d'ACHAT (reservations.cree_le), pas
--     la date de voyage — reflète l'argent réellement encaissé par la
--     plateforme sur la période, ce qui est l'objet même d'un
--     rapprochement bancaire.
--
-- reversement_reservations fait office de VERROU anti-double-comptage :
-- une réservation qui y figure déjà ne peut plus être incluse dans un
-- futur calcul pour la même agence, même sur une période qui la
-- recouvre à nouveau (l'index unique sur reservation_id l'empêche
-- physiquement, pas seulement par convention applicative). Elle sert
-- aussi de preuve d'audit : en cas de litige, on retrouve exactement
-- quelles réservations ont compté dans quel reversement.
create table if not exists reversements (
  id serial primary key,
  agence_id integer not null references agences(id),
  periode_depuis date not null,
  periode_jusqua date not null,
  ca_brut integer not null,
  nombre_reservations integer not null,
  -- snapshot de tarifs.commission au moment du calcul : le tarif
  -- global peut changer après coup, un reversement déjà généré ne doit
  -- jamais se recalculer tout seul avec un tarif différent.
  commission_unitaire integer not null,
  commission_totale integer not null,
  frais_passerelle integer not null default 0,
  net_a_reverser integer not null,
  statut text not null default 'brouillon' check (statut in ('brouillon', 'valide', 'paye')),
  note text,
  genere_par_type text not null,
  genere_par_id integer,
  genere_par_identifiant text not null,
  genere_le timestamptz not null default now(),
  valide_le timestamptz,
  paye_le timestamptz,
  check (periode_jusqua >= periode_depuis)
);
create index if not exists idx_reversements_agence on reversements(agence_id, periode_depuis desc);

create table if not exists reversement_reservations (
  reversement_id integer not null references reversements(id) on delete cascade,
  reservation_id integer not null references reservations(id)
);
create unique index if not exists idx_reversement_reservations_reservation on reversement_reservations(reservation_id);

-- ── Données de départ : les deux agences déjà présentes côté client ──
insert into agences (id, nom, couleur, couleur_pale, slogan, tel, note) values
  (1, 'United Express', '#1D4E89', '#E7EEF6', 'Confort & Ponctualité', '233 421 890', 4.6),
  (2, 'Cerise Express', '#8C1F3B', '#F5E7EA', 'Rapidité & Sécurité', '233 678 901', 4.4)
on conflict (id) do nothing;

insert into trajets (agence_id, depart, arrivee, heure, capacite) values
  (1, 'Douala', 'Yaoundé', '05h30', 6),
  (1, 'Douala', 'Yaoundé', '08h00', 3),
  (1, 'Douala', 'Yaoundé', '12h30', 7),
  (1, 'Yaoundé', 'Douala', '06h00', 8),
  (1, 'Yaoundé', 'Douala', '09h00', 11),
  (1, 'Yaoundé', 'Douala', '13h00', 5),
  (2, 'Douala', 'Yaoundé', '06h00', 12),
  (2, 'Douala', 'Yaoundé', '10h00', 9),
  (2, 'Douala', 'Yaoundé', '14h00', 1),
  (2, 'Yaoundé', 'Douala', '07h30', 4),
  (2, 'Yaoundé', 'Douala', '11h30', 2),
  (2, 'Yaoundé', 'Douala', '15h30', 10)
on conflict (agence_id, depart, arrivee, heure) do nothing;

insert into tarifs (id, prix_simple, prix_ar, commission) values (1, 8000, 15000, 500)
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────
-- Migration depuis l'ancien schéma, SI déjà appliqué sur une base
-- contenant des données réelles (sinon, ignorez cette section — le
-- script ci-dessus suffit sur une base neuve). À exécuter une fois,
-- manuellement, dans le SQL Editor de Neon :
-- ────────────────────────────────────────────────────────────
-- alter table trajets add column if not exists capacite integer not null default 0;
-- update trajets set capacite = places where capacite = 0;
-- alter table trajets drop column if exists places;
-- alter table trajets add constraint trajets_agence_id_depart_arrivee_heure_key unique (agence_id, depart, arrivee, heure);
--
-- create table if not exists departs (
--   id serial primary key,
--   trajet_id integer not null references trajets(id) on delete cascade,
--   date_voyage date not null,
--   places integer not null check (places >= 0),
--   unique (trajet_id, date_voyage)
-- );
--
-- create sequence if not exists reservations_ref_seq;
-- alter table reservations add column if not exists jeton_operateur text;
-- alter table reservations add column if not exists paiement_initie_le timestamptz;
--
-- -- Reconstruit le stock `departs` à partir des réservations déjà en
-- -- base (en_attente/payé) : sans cette étape, les places déjà "prises"
-- -- par vos données de test réapparaîtraient comme disponibles tant
-- -- qu'aucune nouvelle réservation ne les recouvre.
-- insert into departs (trajet_id, date_voyage, places)
-- select r.trajet_id, r.date_voyage, greatest(0, t.capacite - sum(r.nb_voyageurs))
-- from reservations r
-- join trajets t on t.id = r.trajet_id
-- where r.statut in ('en_attente', 'payé')
-- group by r.trajet_id, r.date_voyage, t.capacite
-- on conflict (trajet_id, date_voyage) do update set places = excluded.places;
-- alter table reservations drop column if exists reduction_fidelite;
-- drop index if exists idx_reservations_fidelite;
-- create index if not exists idx_reservations_expiration on reservations(statut, cree_le);
--
-- alter table agences add column if not exists identifiant text unique;
-- alter table agences add column if not exists mot_de_passe_hash text;
--
-- create table if not exists tentatives_connexion (
--   id serial primary key,
--   identifiant text not null,
--   cree_le timestamptz not null default now()
-- );
-- create index if not exists idx_tentatives_connexion on tentatives_connexion(identifiant, cree_le);
--
-- alter table reservations add column if not exists embarque_le timestamptz;
--
-- alter table otp_tentatives add column if not exists ip text;
-- create index if not exists idx_otp_tentatives_ip on otp_tentatives(ip, cree_le);
--
-- create table if not exists paiement_tentatives (
--   id serial primary key,
--   telephone text not null,
--   cree_le timestamptz not null default now()
-- );
-- create index if not exists idx_paiement_tentatives on paiement_tentatives(telephone, cree_le);
--
-- alter table paiement_tentatives add column if not exists ip text;
-- create index if not exists idx_paiement_tentatives_ip on paiement_tentatives(ip, cree_le);
--
-- alter table reservations add column if not exists cle_idempotence text;
-- create unique index if not exists idx_reservations_idempotence on reservations(telephone_compte, cle_idempotence) where cle_idempotence is not null;
--
-- create index if not exists idx_reservations_agence on reservations(agence_id, cree_le desc);
