-- ════════════════════════════════════════════════════════════
-- Schéma Lōndo — à exécuter une fois sur votre base Neon
-- (tableau de bord Neon > SQL Editor, ou `npm run migrate`)
-- ════════════════════════════════════════════════════════════

create table if not exists agences (
  id serial primary key,
  nom text not null,
  couleur text not null,
  couleur_pale text not null,
  slogan text,
  tel text,
  note numeric(2,1)
);

create table if not exists trajets (
  id serial primary key,
  agence_id integer not null references agences(id) on delete cascade,
  depart text not null,
  arrivee text not null,
  heure text not null,          -- format "05h30", identique au client
  places integer not null default 0 check (places >= 0)
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

create table if not exists reservations (
  id serial primary key,
  reference text unique not null,
  agence_id integer not null references agences(id),
  trajet_id integer not null references trajets(id),
  telephone_compte text,                    -- utilisateur connecté (peut différer du voyageur)
  nom_voyageur_principal text not null,
  telephone_voyageur_principal text not null,
  telephone_paiement text not null,
  piece_id text not null,
  date_voyage date not null,
  type_voyage text not null check (type_voyage in ('simple', 'ar')),
  nb_voyageurs integer not null check (nb_voyageurs >= 1),
  mode_paiement text not null check (mode_paiement in ('mtn_momo', 'orange_money')),
  total integer not null,
  reduction_fidelite integer not null default 0,
  statut text not null default 'en_attente' check (statut in ('en_attente', 'payé', 'echoue', 'expire')),
  reference_operateur text,                 -- X-Reference-Id (MTN) / id transaction (Orange)
  cree_le timestamptz not null default now()
);

create index if not exists idx_reservations_reference on reservations(reference);
create index if not exists idx_reservations_fidelite on reservations(telephone_voyageur_principal, agence_id, type_voyage, statut);

create table if not exists voyageurs (
  id serial primary key,
  reservation_id integer not null references reservations(id) on delete cascade,
  nom text not null,
  telephone text not null,
  piece_id text not null
);

-- Anti-abus léger sur l'envoi de codes OTP (Twilio Verify gère le code
-- lui-même : on ne stocke ici que la fréquence d'envoi par numéro).
create table if not exists otp_tentatives (
  id serial primary key,
  telephone text not null,
  cree_le timestamptz not null default now()
);
create index if not exists idx_otp_tentatives on otp_tentatives(telephone, cree_le);

-- ── Données de départ : les deux agences déjà présentes côté client ──
insert into agences (id, nom, couleur, couleur_pale, slogan, tel, note) values
  (1, 'United Express', '#1D4E89', '#E7EEF6', 'Confort & Ponctualité', '233 421 890', 4.6),
  (2, 'Cerise Express', '#8C1F3B', '#F5E7EA', 'Rapidité & Sécurité', '233 678 901', 4.4)
on conflict (id) do nothing;

insert into trajets (agence_id, depart, arrivee, heure, places) values
  (1, 'Douala', 'Yaoundé', '05h30', 6),
  (1, 'Douala', 'Yaoundé', '08h00', 3),
  (1, 'Douala', 'Yaoundé', '12h30', 7),
  (1, 'Yaoundé', 'Douala', '06h00', 8),
  (1, 'Yaoundé', 'Douala', '09h00', 11),
  (1, 'Yaoundé', 'Douala', '13h00', 5),
  (2, 'Douala', 'Yaoundé', '06h00', 12),
  (2, 'Douala', 'Yaoundé', '10h00', 9),
  (2, 'Douala'
