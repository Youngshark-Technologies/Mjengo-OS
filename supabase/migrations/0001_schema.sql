-- ============================================================================
-- Mjengo-OS — Supabase target-state schema (issue #95, ADR 0002)
-- File: supabase/migrations/0001_schema.sql
--
-- Complete PostgreSQL DDL for all 68 Prisma models, 1:1, in dependency order.
-- Mapping rules (see docs/SUPABASE-DATABASE-DESIGN.md §3):
--   · names: camelCase → snake_case (one exception: Phase.order → order_index,
--     "order" is a reserved SQL word)
--   · ids: TEXT cuid, app-supplied (no default) — preserves the offline-sync,
--     outbox and idempotency layers byte-for-byte
--   · money: NUMERIC(18,2) · quantities: NUMERIC(18,3) · lat/lng: float8
--   · timestamps: timestamptz · JSON-in-string columns: JSONB
--   · status ladders: text + CHECK (additive wave evolution, no ALTER TYPE)
--   · @updatedAt: maintained by trigger touch_updated_at() (0002)
--   · cascade/uniques mirror prisma/schema.prisma exactly; explicit indexes
--     added for EVERY FK column (SQLite never had them)
--   · deliberate additions vs Prisma (documented, not silent): non-negative
--     CHECKs on money/qty, monotonic version guards, ledger self-FK
--
-- Ownership boundary: prisma/migrations = data-model evolution;
-- supabase/migrations = target-state platform layer (this file).
-- Apply to a FRESH Supabase project (idempotent guards for extensions only).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists citext;   -- case-insensitive email uniqueness
create extension if not exists pgcrypto; -- gen_random_uuid() for ops paths

-- ---------------------------------------------------------------------------
-- 1. Core project domain
-- ---------------------------------------------------------------------------

-- Project — the root tenant scope. client/clientType/location are honest
-- free-text as today (no verification claim).
create table public.projects (
  id           text primary key,
  share_token  text not null unique,
  name         text not null,
  client       text not null,
  client_type  text not null default 'diaspora'
    check (client_type in ('diaspora', 'local', 'company')),
  location     text not null,
  budget       numeric(18,2) not null check (budget >= 0),
  start_date   timestamptz not null,
  target_date  timestamptz not null,
  status       text not null default 'active'
    check (status in ('active', 'completed', 'on_hold')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index projects_status_idx on public.projects (status);

-- Phase — construction stage. Column "order_index" maps Prisma `order`
-- (reserved word); documented in the design doc mapping exceptions.
create table public.phases (
  id              text primary key,
  project_id      text not null references public.projects (id) on delete cascade,
  name            text not null,
  order_index     integer not null,
  budget          numeric(18,2) not null check (budget >= 0),
  status          text not null default 'pending'
    check (status in ('pending', 'in_progress', 'done')),
  progress_manual integer,
  constraint phases_progress_manual_range check (progress_manual is null or (progress_manual between 0 and 100))
);

create index phases_project_id_idx on public.phases (project_id);

-- Task — with offline-sync entity version (bumped by every applier;
-- monotonicity enforced by trigger in 0002).
create table public.tasks (
  id                text primary key,
  phase_id          text not null references public.phases (id) on delete cascade,
  title             text not null,
  status            text not null default 'pending'
    check (status in ('pending', 'in_progress', 'done', 'blocked')),
  progress          integer not null default 0 check (progress between 0 and 100),
  due_date          timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  priority          text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to_id    text references public.workers (id) on delete set null,
  blocked_by_id     text references public.tasks (id) on delete set null,
  blocked_reason    text,
  verified_at       timestamptz,
  verified_by_name  text,
  version           integer not null default 1 check (version >= 1)
);

create index tasks_phase_id_idx on public.tasks (phase_id);
create index tasks_assigned_to_id_idx on public.tasks (assigned_to_id);
create index tasks_blocked_by_id_idx on public.tasks (blocked_by_id);
create index tasks_status_idx on public.tasks (status);

-- Worker — fundi roster. skills is a JSONB array. pin is the shared-site
-- kiosk secret (rate-limited + throttled at the API, never a password).
create table public.workers (
  id                      text primary key,
  project_id              text not null references public.projects (id) on delete cascade,
  name                    text not null,
  role                    text not null,
  phone                   text not null,
  pin                     text,
  daily_rate              numeric(18,2) not null check (daily_rate >= 0),
  active                  boolean not null default true,
  id_number               text,
  employment_type         text
    check (employment_type is null or employment_type in ('casual', 'contract', 'full_time')),
  skills                  jsonb,
  emergency_contact_name  text,
  emergency_contact_phone text
);

create index workers_project_id_idx on public.workers (project_id);
create index workers_active_idx on public.workers (project_id, active);

-- Attendance — day-row per worker with verification ladder, evidence JSON,
-- append-only override log, and the offline-sync entity version.
create table public.attendances (
  id               text primary key,
  worker_id        text not null references public.workers (id) on delete cascade,
  project_id       text not null references public.projects (id) on delete cascade,
  date             text not null, -- YYYY-MM-DD (site-local day, not a timestamp)
  check_in         timestamptz,
  check_out        timestamptz,
  status           text not null default 'present'
    check (status in ('present', 'absent', 'half_day', 'excused')),
  method           text not null default 'geofence'
    check (method in ('geofence', 'ussd', 'app', 'kiosk_pin', 'qr_card', 'manager')),
  wage             numeric(18,2) not null default 0 check (wage >= 0),
  paid             boolean not null default false,
  synced           boolean not null default true,
  verification     text not null default 'reported'
    check (verification in ('verified', 'reported', 'exception')),
  evidence         jsonb,
  exception_reason text
    check (exception_reason is null or exception_reason in
      ('phone_damaged', 'battery_dead', 'network', 'forgot', 'new_worker', 'emergency', 'other')),
  exception_note   text,
  override_log     jsonb, -- append-only [{at, by, from, to, reason}]
  recorded_by      text,
  created_at       timestamptz not null default now(),
  version          integer not null default 1 check (version >= 1)
);

create index attendances_worker_id_idx on public.attendances (worker_id);
create index attendances_project_date_idx on public.attendances (project_id, date);

-- Material — global indicative catalog (not project-scoped).
create table public.materials (
  id         text primary key,
  name       text not null,
  unit       text not null, -- bag, tonne, piece, roll, kg, metre
  unit_price numeric(18,2) not null check (unit_price >= 0)
);

create index materials_name_idx on public.materials (name);

-- Delivery — material stock intake (materials domain; distinct from
-- supply-domain order_deliveries).
create table public.deliveries (
  id             text primary key,
  project_id     text not null references public.projects (id) on delete cascade,
  material_id    text not null references public.materials (id) on delete restrict,
  quantity       numeric(18,3) not null check (quantity > 0),
  unit_cost      numeric(18,2) not null check (unit_cost >= 0),
  total_cost     numeric(18,2) not null check (total_cost >= 0),
  supplier       text not null,
  date           timestamptz not null,
  source         text not null default 'manual'
    check (source in ('manual', 'voice', 'photo', 'mpesa')),
  raw_transcript text,
  created_at     timestamptz not null default now()
);

create index deliveries_project_id_idx on public.deliveries (project_id);
create index deliveries_material_id_idx on public.deliveries (material_id);

-- Consumption — material usage against a phase name (free text).
create table public.consumptions (
  id          text primary key,
  project_id  text not null references public.projects (id) on delete cascade,
  material_id text not null references public.materials (id) on delete restrict,
  quantity    numeric(18,3) not null check (quantity > 0),
  phase_name  text,
  date        timestamptz not null,
  note        text,
  created_at  timestamptz not null default now()
);

create index consumptions_project_id_idx on public.consumptions (project_id);
create index consumptions_material_id_idx on public.consumptions (material_id);

-- SiteZone — schematic map zones (percent coords over a plan image).
create table public.site_zones (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  name       text not null,
  x          double precision not null,
  y          double precision not null,
  w          double precision not null,
  h          double precision not null,
  created_at timestamptz not null default now()
);

create index site_zones_project_id_idx on public.site_zones (project_id);

-- SitePhoto — evidence photo (url → storage key in the target platform;
-- zone_id stays a plain string, mirroring Prisma — no FK by design).
create table public.site_photos (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  phase_id     text references public.phases (id) on delete set null,
  zone_id      text,
  url          text not null,
  caption      text,
  analysis     jsonb, -- VLM analysis payload
  progress_pct integer check (progress_pct is null or (progress_pct between 0 and 100)),
  created_at   timestamptz not null default now()
);

create index site_photos_project_created_idx on public.site_photos (project_id, created_at desc);
create index site_photos_phase_id_idx on public.site_photos (phase_id);
create index site_photos_zone_id_idx on public.site_photos (zone_id);

-- Alert — anomaly/budget/safety surface.
create table public.alerts (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  type         text not null
    check (type in ('anomaly', 'budget', 'safety', 'attendance', 'progress', 'info')),
  severity     text not null default 'info'
    check (severity in ('info', 'warning', 'critical')),
  title        text not null,
  message      text not null,
  acknowledged boolean not null default false,
  created_at   timestamptz not null default now()
);

create index alerts_project_idx on public.alerts (project_id, created_at desc);
create index alerts_unacked_idx on public.alerts (project_id) where not acknowledged;

-- Transaction — display-level spend record (ledger link optional; the
-- double-entry ledger is the money source of truth).
create table public.transactions (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  type         text not null
    check (type in ('wage', 'material', 'transport', 'other', 'invoice', 'milestone', 'payment_request')),
  amount       numeric(18,2) not null,
  method       text not null default 'mpesa'
    check (method in ('mpesa', 'cash', 'bank', 'card', 'wallet')),
  reference    text,
  cost_code    text,
  phase_id     text references public.phases (id) on delete set null,
  ledger_txn_id text,
  note         text,
  date         timestamptz not null,
  created_at   timestamptz not null default now()
);

create index transactions_project_date_idx on public.transactions (project_id, date desc);
create index transactions_phase_id_idx on public.transactions (phase_id);
create index transactions_ledger_txn_id_idx on public.transactions (ledger_txn_id);

-- Recap — WhatsApp-style daily narrative.
create table public.recaps (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  day        integer not null,
  content    text not null,
  created_at timestamptz not null default now()
);

create index recaps_project_day_idx on public.recaps (project_id, day);

-- ---------------------------------------------------------------------------
-- 2. Trust & money platform
-- ---------------------------------------------------------------------------

-- AuditEvent — the Bias-Free Ledger: append-only record of everything.
-- Immutability is trigger-enforced (0002), stronger than any app discipline.
create table public.audit_events (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  kind       text not null,
  actor      text not null,
  role       text not null
    check (role in ('contractor', 'foreman', 'client', 'system', 'ai', 'finance', 'supervisor')),
  summary    text not null,
  meta       jsonb,
  entity     text,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         text,
  user_agent text,
  request_id text,
  created_at timestamptz not null default now()
);

create index audit_events_project_created_idx on public.audit_events (project_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (entity, entity_id);

-- EscrowWallet — MjengoPay escrow projection (balance mirrored from the
-- ledger inside the same transaction; unique project scope).
create table public.escrow_wallets (
  id               text primary key,
  project_id       text not null unique references public.projects (id) on delete cascade,
  balance          numeric(18,2) not null default 0 check (balance >= 0),
  ledger_account_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Milestone — escrow release ladder.
create table public.milestones (
  id                text primary key,
  project_id        text not null references public.projects (id) on delete cascade,
  -- phase_id: plain scalar, mirroring Prisma (no relation declared)
  phase_id          text,
  name              text not null,
  amount            numeric(18,2) not null check (amount > 0),
  status            text not null default 'locked'
    check (status in ('locked', 'evidence_submitted', 'release_requested', 'approved', 'released', 'rejected')),
  evidence_photo_ids jsonb not null default '[]'::jsonb,
  requested_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text,
  decision_note     text,
  released_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index milestones_project_idx on public.milestones (project_id, status);
create index milestones_phase_id_idx on public.milestones (phase_id);

-- VariationOrder — plan changes that move the budget (client decides).
create table public.variation_orders (
  id            text primary key,
  project_id    text not null references public.projects (id) on delete cascade,
  -- phase_id: plain scalar, mirroring Prisma (no relation declared)
  phase_id      text,
  title         text not null,
  description   text not null,
  budget_impact numeric(18,2) not null, -- signed: + increase, - saving
  status        text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected')),
  submitted_by  text,
  decided_by    text,
  decision_note text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index variation_orders_project_idx on public.variation_orders (project_id, status);

-- DrawPack — immutable hash-stamped evidence bundle frozen at milestone
-- release. ONE per milestone (DB-enforced). Append-only + immutable via
-- trigger (0002); content_hash = SHA-256 over canonical JSON.
create table public.draw_packs (
  id                 text primary key,
  milestone_id       text not null unique references public.milestones (id) on delete restrict,
  project_id         text not null references public.projects (id) on delete cascade,
  milestone_name     text not null,
  amount             numeric(18,2) not null check (amount > 0),
  currency           text not null default 'KES',
  ledger_ref         text not null,
  ledger_txn_id      text not null,
  evidence_photo_ids jsonb not null default '[]'::jsonb,
  variations_open    jsonb not null default '[]'::jsonb,
  attendance_summary jsonb not null,
  mjengo_score       jsonb,
  content_hash       text not null,
  schema_version     integer not null default 1,
  created_at         timestamptz not null default now()
);

create index draw_packs_project_idx on public.draw_packs (project_id, created_at desc);

-- PhotoComment — contextual Q&A pinned on a site photo.
create table public.photo_comments (
  id         text primary key,
  photo_id   text not null references public.site_photos (id) on delete cascade,
  project_id text not null references public.projects (id) on delete cascade,
  author     text not null,
  role       text not null
    check (role in ('client', 'contractor', 'foreman')),
  message    text not null,
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);

create index photo_comments_photo_idx on public.photo_comments (photo_id);
create index photo_comments_project_idx on public.photo_comments (project_id);

-- Notification — in-app center + honest channel delivery log.
create table public.notifications (
  id              text primary key,
  project_id      text references public.projects (id) on delete cascade,
  kind            text not null,
  title           text not null,
  body            text not null,
  channel         text not null default 'in_app'
    check (channel in ('in_app', 'whatsapp', 'sms', 'push', 'email')),
  delivery_status text not null default 'logged'
    check (delivery_status in ('logged', 'sent', 'failed')),
  delivered_at    timestamptz,
  delivery_detail text,
  recipient       text,
  audience_role   text,
  read            boolean not null default false,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index notifications_project_read_idx on public.notifications (project_id, created_at desc);
create index notifications_unread_idx on public.notifications (project_id) where not read;
create index notifications_recipient_idx on public.notifications (recipient);

-- User — Phase-1 app users (NextAuth credentials). Supabase Auth cutover
-- (Phase 2) maps auth.users → public.profiles (0002); this table is then
-- retired after the cutover window. citext email matches auth semantics.
create table public.users (
  id                text primary key,
  email             citext not null unique,
  password_hash     text not null,
  name              text not null,
  role              text not null default 'contractor'
    check (role in ('contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier')),
  -- project_id/supplier_id: plain scalar links by design (Prisma declares no
  -- relation; a dangling id fails closed at session shaping)
  project_id        text,
  supplier_id       text,
  created_at        timestamptz not null default now(),
  notification_prefs jsonb
);

create index users_role_idx on public.users (role);
create index users_project_id_idx on public.users (project_id) where project_id is not null;
create index users_supplier_id_idx on public.users (supplier_id) where supplier_id is not null;

-- PushSubscription — web push address book (upsert key = endpoint).
create table public.push_subscriptions (
  id              text primary key,
  user_id         text not null references public.users (id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  expiration_time timestamptz,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- ProjectTeam — staffing roster (distinct from app users).
create table public.project_team (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  name       text not null,
  role       text not null
    check (role in ('contractor', 'supervisor', 'qs', 'architect', 'engineer', 'surveyor', 'client_rep')),
  phone      text,
  email      text,
  note       text,
  joined_at  timestamptz not null default now()
);

create index project_team_project_idx on public.project_team (project_id);

-- Issue #174 (SEC-6): the site-team read-scope grant rows — which users work
-- on which projects (mirrors the SQLite path's ProjectMembership model; the
-- membership-ROLES resolve their readable projects through these rows).
create table public.project_memberships (
  id         text primary key,
  user_id    text not null references public.users (id) on delete cascade,
  project_id text not null references public.projects (id) on delete cascade,
  role       text not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_id)
);

create index project_memberships_project_idx on public.project_memberships (project_id);
create index project_memberships_user_idx on public.project_memberships (user_id);

-- ---------------------------------------------------------------------------
-- 3. Land & property
-- ---------------------------------------------------------------------------

create table public.land_parcels (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  plot_number  text not null,
  county       text not null,
  town         text,
  lat          double precision,
  lng          double precision,
  approx_area  text,
  tenure_type  text
    check (tenure_type is null or tenure_type in ('freehold', 'leasehold')),
  status       text not null default 'searching'
    check (status in ('searching', 'verified', 'flagged')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index land_parcels_project_idx on public.land_parcels (project_id);
create index land_parcels_county_idx on public.land_parcels (county);

create table public.parcel_documents (
  id             text primary key,
  parcel_id      text not null references public.land_parcels (id) on delete cascade,
  kind           text not null
    check (kind in ('title_deed', 'search_cert', 'survey_map', 'other')),
  file_name      text not null,
  storage_key    text not null,
  extracted_text text,
  issued_on      timestamptz,
  created_at     timestamptz not null default now()
);

create index parcel_documents_parcel_idx on public.parcel_documents (parcel_id);

create table public.title_searches (
  id                  text primary key,
  parcel_id           text not null references public.land_parcels (id) on delete cascade,
  search_ref          text not null,
  result_summary      text,
  transcription_match text not null default 'pending'
    check (transcription_match in ('pending', 'consistent', 'mismatch')),
  status              text not null default 'requested'
    check (status in ('requested', 'received', 'reviewed')),
  requested_at        timestamptz not null default now(),
  received_at         timestamptz,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now()
);

create index title_searches_parcel_idx on public.title_searches (parcel_id);

-- Professional — directory of built-environment professionals (verification
-- ladder 0-6; never a government certification claim).
create table public.professionals (
  id                text primary key,
  name              text not null,
  category          text not null
    check (category in ('surveyor', 'advocate', 'engineer', 'qty_surveyor', 'architect')),
  organisation      text,
  phone             text,
  email             text,
  county            text,
  licence_number    text,
  licence_body      text
    check (licence_body is null or licence_body in ('LSK', 'EBK', 'BORAQS', 'other')),
  verification_state integer not null default 0 check (verification_state between 0 and 6),
  reliability_score  integer not null default 50 check (reliability_score between 0 and 100),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index professionals_category_county_idx on public.professionals (category, county);

create table public.credential_checks (
  id             text primary key,
  professional_id text not null references public.professionals (id) on delete cascade,
  checked_by     text not null,
  method         text not null
    check (method in ('document_review', 'reference_call', 'registry_lookup')),
  finding        text not null,
  recorded_at    timestamptz not null default now()
);

create index credential_checks_professional_idx on public.credential_checks (professional_id);

create table public.parcel_assignments (
  id             text primary key,
  parcel_id      text not null references public.land_parcels (id) on delete cascade,
  professional_id text not null references public.professionals (id) on delete cascade,
  role           text not null
    check (role in ('surveyor', 'advocate', 'engineer', 'qty_surveyor')),
  status         text not null default 'active'
    check (status in ('active', 'completed', 'withdrawn')),
  note           text,
  created_at     timestamptz not null default now()
);

create index parcel_assignments_parcel_idx on public.parcel_assignments (parcel_id);
create index parcel_assignments_professional_idx on public.parcel_assignments (professional_id);

-- ---------------------------------------------------------------------------
-- 4. Supply & procurement / Finder
-- ---------------------------------------------------------------------------

-- Supplier — procurement network member (verification ladder 0-5).
create table public.suppliers (
  id                 text primary key,
  business_name      text not null,
  county             text not null,
  town               text,
  lat                double precision,
  lng                double precision,
  phone              text,
  email              text,
  warehouse_location text,
  delivery_zones     text not null default '',
  delivery_fee_base  numeric(18,2) not null default 0 check (delivery_fee_base >= 0),
  free_delivery_over numeric(18,2) check (free_delivery_over is null or free_delivery_over >= 0),
  minimum_order      numeric(18,2) not null default 0 check (minimum_order >= 0),
  verification_state integer not null default 0 check (verification_state between 0 and 5),
  reliability_score  integer not null default 50 check (reliability_score between 0 and 100),
  response_hours     integer not null default 24 check (response_hours >= 0),
  operating_hours    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index suppliers_county_idx on public.suppliers (county);
create index suppliers_verification_idx on public.suppliers (verification_state);

create table public.catalog_items (
  id            text primary key,
  supplier_id   text not null references public.suppliers (id) on delete cascade,
  name          text not null,
  category      text,
  brand         text,
  specification text,
  unit          text not null,
  unit_price    numeric(18,2) not null check (unit_price >= 0),
  stock_qty     numeric(18,3) not null default 0 check (stock_qty >= 0),
  min_order_qty numeric(18,3) not null default 1 check (min_order_qty >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index catalog_items_supplier_idx on public.catalog_items (supplier_id);
create index catalog_items_name_idx on public.catalog_items (name);
create index catalog_items_category_idx on public.catalog_items (category);

-- MaterialRequest — the "don't immediately charge the wallet" step.
create table public.material_requests (
  id                text primary key,
  project_id        text not null references public.projects (id) on delete cascade,
  request_code      text not null,
  requested_by_role text not null
    check (requested_by_role in ('supervisor', 'contractor', 'client', 'procurement', 'finance')),
  requested_by_name text not null,
  notes             text,
  status            text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'converted')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index material_requests_project_status_idx on public.material_requests (project_id, status);
create index material_requests_code_idx on public.material_requests (request_code);

create table public.material_request_lines (
  id            text primary key,
  request_id    text not null references public.material_requests (id) on delete cascade,
  material_name text not null,
  unit          text not null,
  qty           numeric(18,3) not null check (qty >= 0)
);

create index material_request_lines_request_idx on public.material_request_lines (request_id);

-- ApprovalRule — first active rule whose band contains the total decides.
create table public.approval_rules (
  id            text primary key,
  project_id    text not null references public.projects (id) on delete cascade,
  min_amount    numeric(18,2) not null default 0 check (min_amount >= 0),
  max_amount    numeric(18,2) check (max_amount is null or max_amount >= 0),
  approver_role text not null
    check (approver_role in ('supervisor', 'contractor', 'client', 'finance')),
  priority      integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index approval_rules_project_active_idx on public.approval_rules (project_id, priority) where active;

-- Approval — concrete decision trail (entity ref is a plain string by design).
create table public.approvals (
  id            text primary key,
  project_id    text not null references public.projects (id) on delete cascade,
  entity_type   text not null
    check (entity_type in ('material_request', 'purchase_order', 'invoice')),
  entity_id     text not null,
  approver_role text not null
    check (approver_role in ('supervisor', 'contractor', 'client', 'finance')),
  approver_name text not null,
  decision      text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected')),
  note          text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index approvals_project_idx on public.approvals (project_id);
create index approvals_entity_idx on public.approvals (entity_type, entity_id);

create table public.quotes (
  id            text primary key,
  request_id    text not null references public.material_requests (id) on delete cascade,
  supplier_id   text not null references public.suppliers (id) on delete restrict,
  unit_price    numeric(18,2) not null check (unit_price >= 0),
  delivery_fee  numeric(18,2) not null default 0 check (delivery_fee >= 0),
  transport_fee numeric(18,2) not null default 0 check (transport_fee >= 0),
  fees          numeric(18,2) not null default 0 check (fees >= 0),
  total_landed  numeric(18,2) not null check (total_landed >= 0),
  delivery_eta  text,
  valid_until   timestamptz,
  terms         text,
  stock_ok      boolean not null default true,
  status        text not null default 'requested'
    check (status in ('requested', 'received', 'declined', 'expired')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index quotes_request_idx on public.quotes (request_id);
create index quotes_supplier_idx on public.quotes (supplier_id);

create table public.quote_lines (
  id         text primary key,
  quote_id   text not null references public.quotes (id) on delete cascade,
  name       text not null,
  unit       text not null,
  qty        numeric(18,3) not null check (qty >= 0),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  line_total numeric(18,2) not null check (line_total >= 0)
);

create index quote_lines_quote_idx on public.quote_lines (quote_id);

-- PurchaseOrder — approved request + selected supplier.
create table public.purchase_orders (
  id             text primary key,
  order_code     text not null,
  project_id     text not null references public.projects (id) on delete cascade,
  request_id     text references public.material_requests (id) on delete set null,
  supplier_id    text not null references public.suppliers (id) on delete restrict,
  subtotal       numeric(18,2) not null check (subtotal >= 0),
  delivery_fee   numeric(18,2) not null default 0 check (delivery_fee >= 0),
  total          numeric(18,2) not null check (total >= 0),
  status         text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'sent', 'confirmed',
                      'delivering', 'delivered', 'closed', 'cancelled')),
  payment_source text not null default 'client'
    check (payment_source in ('client', 'contractor', 'project_wallet', 'finance')),
  created_by_role text not null,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index purchase_orders_project_status_idx on public.purchase_orders (project_id, status);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);
create index purchase_orders_request_id_idx on public.purchase_orders (request_id);
create index purchase_orders_code_idx on public.purchase_orders (order_code);
-- Deliberate: order_code NOT unique (Prisma parity). Promoting it to unique
-- requires a data audit first — tracked in the design doc §10 review items.

create table public.purchase_order_lines (
  id         text primary key,
  order_id   text not null references public.purchase_orders (id) on delete cascade,
  name       text not null,
  unit       text not null,
  qty        numeric(18,3) not null check (qty > 0),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  line_total numeric(18,2) not null check (line_total >= 0)
);

create index purchase_order_lines_order_idx on public.purchase_order_lines (order_id);

-- OrderDelivery — physical delivery against a PO (ground truth).
create table public.order_deliveries (
  id            text primary key,
  order_id      text not null references public.purchase_orders (id) on delete cascade,
  status        text not null default 'dispatched'
    check (status in ('dispatched', 'in_transit', 'arrived', 'received', 'discrepancy')),
  dispatched_at timestamptz,
  received_at   timestamptz,
  received_by   text,
  note          text,
  photo_urls    jsonb not null default '[]'::jsonb, -- superseded legacy column (kept)
  photo_count   integer not null default 0 check (photo_count >= 0),
  gps_lat       double precision,
  gps_lng       double precision,
  created_at    timestamptz not null default now(),
  driver_name   text,
  driver_phone  text,
  vehicle_reg   text,
  eta_at        timestamptz,
  departed_at   timestamptz,
  arrived_at    timestamptz
);

create index order_deliveries_order_idx on public.order_deliveries (order_id);

create table public.order_delivery_lines (
  id           text primary key,
  delivery_id  text not null references public.order_deliveries (id) on delete cascade,
  order_line_id text not null references public.purchase_order_lines (id) on delete cascade,
  qty_ordered  numeric(18,3) not null check (qty_ordered > 0),
  qty_received numeric(18,3) not null default 0 check (qty_received >= 0),
  qty_rejected numeric(18,3) not null default 0 check (qty_rejected >= 0),
  damage_note  text,
  condition    text not null default 'ok'
    check (condition in ('ok', 'damaged', 'partial'))
);

create index order_delivery_lines_delivery_idx on public.order_delivery_lines (delivery_id);
create index order_delivery_lines_order_line_idx on public.order_delivery_lines (order_line_id);

-- DeliveryPhoto — idempotent evidence link (unique pair enforced).
create table public.delivery_photos (
  id              text primary key,
  delivery_id     text not null references public.order_deliveries (id) on delete cascade,
  attachment_id   text not null references public.attachments (id) on delete cascade,
  delivery_line_id text references public.order_delivery_lines (id) on delete cascade,
  attached_by     text not null,
  created_at      timestamptz not null default now(),
  constraint delivery_photos_pair_unique unique (delivery_id, attachment_id)
);

create index delivery_photos_delivery_line_idx on public.delivery_photos (delivery_line_id);
create index delivery_photos_attachment_idx on public.delivery_photos (attachment_id);

-- ---------------------------------------------------------------------------
-- 5. Invoices
-- ---------------------------------------------------------------------------

create table public.invoices (
  id                text primary key,
  invoice_code      text not null,
  project_id        text not null references public.projects (id) on delete cascade,
  order_id          text references public.purchase_orders (id) on delete set null,
  supplier_id       text references public.suppliers (id) on delete set null,
  status            text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid', 'disputed')),
  subtotal          numeric(18,2) not null default 0 check (subtotal >= 0),
  tax               numeric(18,2) not null default 0 check (tax >= 0),
  total             numeric(18,2) not null default 0 check (total >= 0),
  due_date          timestamptz,
  issued_at         timestamptz,
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text,
  paid_at           timestamptz,
  paid_by_role      text check (paid_by_role is null or paid_by_role in ('client', 'contractor', 'finance')),
  payment_method    text
    check (payment_method is null or payment_method in ('mpesa', 'bank', 'card', 'wallet', 'cash')),
  payment_reference text,
  created_by        text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index invoices_project_status_idx on public.invoices (project_id, status);
create index invoices_supplier_idx on public.invoices (supplier_id);
create index invoices_order_idx on public.invoices (order_id);
create index invoices_code_idx on public.invoices (invoice_code);
-- invoice_code NOT unique — same deliberate parity decision as order_code.

create table public.invoice_lines (
  id         text primary key,
  invoice_id text not null references public.invoices (id) on delete cascade,
  name       text not null,
  qty        numeric(18,3) not null check (qty >= 0),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  line_total numeric(18,2) not null check (line_total >= 0)
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

-- ---------------------------------------------------------------------------
-- 6. Intel (deterministic analytics — all append-only)
-- ---------------------------------------------------------------------------

create table public.risk_assessments (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  computed_at  timestamptz not null default now(),
  overall_score integer not null default 0 check (overall_score between 0 and 100),
  findings     jsonb not null default '[]'::jsonb,
  rule_version text not null default 'v1'
);

create index risk_assessments_project_idx on public.risk_assessments (project_id, computed_at desc);

create table public.mjengo_scores (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  computed_at  timestamptz not null default now(),
  score        integer check (score is null or (score between 0 and 100)),
  confidence   text not null default 'low' check (confidence in ('low', 'medium', 'high')),
  components   jsonb not null default '[]'::jsonb,
  notes        text,
  rule_version text not null default 'v1'
);

create index mjengo_scores_project_idx on public.mjengo_scores (project_id, computed_at desc);

create table public.intel_digests (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  week_start text not null,
  summary    text not null,
  items      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index intel_digests_project_idx on public.intel_digests (project_id, created_at desc);

create table public.price_points (
  id           text primary key,
  material_name text not null,
  region       text not null,
  unit_price   numeric(18,2) not null check (unit_price >= 0),
  recorded_at  timestamptz not null default now(),
  source       text not null default 'seed' check (source in ('order', 'manual', 'seed'))
);

create index price_points_lookup_idx on public.price_points (material_name, region, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 7. Money core — double-entry ledger
-- ---------------------------------------------------------------------------

create table public.ledger_accounts (
  id          text primary key,
  code        text not null unique,
  name        text not null,
  kind        text not null check (kind in ('asset', 'liability', 'revenue', 'expense', 'equity')),
  normal_side text not null default 'debit' check (normal_side in ('debit', 'credit')),
  project_id  text references public.projects (id) on delete cascade,
  owner_type  text check (owner_type is null or owner_type in ('wallet', 'escrow', 'project', 'platform')),
  owner_id    text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index ledger_accounts_project_idx on public.ledger_accounts (project_id);
create index ledger_accounts_owner_idx on public.ledger_accounts (owner_type, owner_id);

-- LedgerTransaction — INSERT/SELECT-only like ledger_entries (#133 / DB-11):
-- reversals are NEW rows linked via reversal_of_id; "was reversed?" is
-- derived from that link, so there is no reversal-marking update to guard.
-- reversal_of_id gains a self-FK (deliberate addition) and a UNIQUE index
-- (one reversal per original — the DB-level double-reversal backstop).
create table public.ledger_transactions (
  id              text primary key,
  ref             text not null unique,
  project_id      text references public.projects (id) on delete cascade,
  description     text not null,
  occurred_at     timestamptz not null default now(),
  posted_by       text not null,
  posted_role     text not null
    check (posted_role in ('contractor', 'client', 'finance', 'system')),
  status          text not null default 'posted' check (status in ('posted', 'reversed')),
  reversal_of_id  text references public.ledger_transactions (id) on delete restrict,
  reversal_ref    text,
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);

create index ledger_transactions_project_idx on public.ledger_transactions (project_id, occurred_at desc);
create unique index ledger_transactions_reversal_of_idx on public.ledger_transactions (reversal_of_id);

-- LedgerEntry — one balanced leg. Append-only. Σdebits = Σcredits per txn is
-- DB-enforced by a deferred constraint trigger (0002) on top of the service
-- validation.
create table public.ledger_entries (
  id         text primary key,
  txn_id     text not null references public.ledger_transactions (id) on delete cascade,
  account_id text not null references public.ledger_accounts (id) on delete restrict,
  side       text not null check (side in ('debit', 'credit')),
  amount     numeric(18,2) not null check (amount > 0),
  memo       text,
  created_at timestamptz not null default now()
);

create index ledger_entries_txn_idx on public.ledger_entries (txn_id);
create index ledger_entries_account_idx on public.ledger_entries (account_id);

-- IdempotencyRecord — replay guard. Append-only (insert + select only).
create table public.idempotency_records (
  id            text primary key,
  key           text not null unique,
  scope         text not null,
  project_id    text,
  response_body jsonb,
  created_at    timestamptz not null default now()
);

create index idempotency_records_scope_idx on public.idempotency_records (scope, created_at desc);

create table public.wallet_accounts (
  id               text primary key,
  code             text not null unique,
  label            text not null,
  owner_type       text not null
    check (owner_type in ('project', 'organization', 'supplier', 'user')),
  owner_id         text,
  currency         text not null default 'KES',
  status           text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  ledger_account_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index wallet_accounts_owner_idx on public.wallet_accounts (owner_type, owner_id);

create table public.payment_requests (
  id                 text primary key,
  request_code       text not null,
  project_id         text not null references public.projects (id) on delete cascade,
  requested_by_role  text not null
    check (requested_by_role in ('contractor', 'supervisor', 'finance', 'client')),
  requested_by_name  text not null,
  description        text not null,
  amount             numeric(18,2) not null check (amount > 0),
  payee              text not null,
  method             text not null default 'mpesa'
    check (method in ('mpesa', 'bank', 'card', 'wallet', 'cash')),
  status             text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paid')),
  related_entity_type text
    check (related_entity_type is null or
           related_entity_type in ('milestone', 'invoice', 'purchase_order', 'wages', 'none')),
  related_entity_id  text,
  decided_by         text,
  decided_at         timestamptz,
  decision_note      text,
  paid_at            timestamptz,
  paid_txn_id        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index payment_requests_project_status_idx on public.payment_requests (project_id, status);
create index payment_requests_code_idx on public.payment_requests (request_code);

-- ---------------------------------------------------------------------------
-- 8. Inventory & BOQ
-- ---------------------------------------------------------------------------

create table public.inventory_items (
  id            text primary key,
  project_id    text not null references public.projects (id) on delete cascade,
  material_name text not null,
  unit          text not null,
  -- material_id/supplier_id: plain scalar links, mirroring Prisma (no relations)
  material_id   text,
  location      text not null default 'Site Store',
  supplier_id   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint inventory_items_scope_unique unique (project_id, material_name, location)
);

create index inventory_items_project_idx on public.inventory_items (project_id);

-- StockMovement — append-only movement ledger (closing = Σ movements).
create table public.stock_movements (
  id               text primary key,
  project_id       text not null references public.projects (id) on delete cascade,
  inventory_item_id text not null references public.inventory_items (id) on delete cascade,
  type             text not null
    check (type in ('opening', 'received', 'consumed', 'transferred_in',
                    'transferred_out', 'returned', 'damaged', 'adjusted')),
  quantity         numeric(18,3) not null,
  unit_cost        numeric(18,2) check (unit_cost is null or unit_cost >= 0),
  reference        text,
  note             text,
  recorded_by      text not null,
  created_at       timestamptz not null default now()
);

create index stock_movements_item_idx on public.stock_movements (inventory_item_id, created_at desc);
create index stock_movements_project_idx on public.stock_movements (project_id);

-- StockCount / StockCountItem (issue #194) — the stock reconciliation loop:
-- a physical count session per project + one counted line per inventory
-- item. expected_qty is the derived-closing SNAPSHOT at count time (pinned);
-- variance is always expected − counted (computed, never stored). status
-- open → posted is the ONE legal state transition (posting appends
-- `adjusted` stock_movements with reference 'count:<id>' — the ledger itself
-- is never edited, which is why these tables are NOT in the append-only
-- trigger set: stock_movements already is).
create table public.stock_counts (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  counted_by text not null,
  counted_at timestamptz not null,
  note       text,
  status     text not null default 'open' check (status in ('open', 'posted')),
  posted_at  timestamptz,
  posted_by  text,
  created_at timestamptz not null default now()
);

create index stock_counts_project_idx on public.stock_counts (project_id, created_at desc);

create table public.stock_count_items (
  id               text primary key,
  count_id         text not null references public.stock_counts (id) on delete cascade,
  inventory_item_id text not null references public.inventory_items (id) on delete cascade,
  counted_qty      numeric(18,3) not null check (counted_qty >= 0),
  expected_qty     numeric(18,3) not null,
  posted_qty       numeric(18,3),
  constraint stock_count_items_line_unique unique (count_id, inventory_item_id)
);

create index stock_count_items_item_idx on public.stock_count_items (inventory_item_id);

create table public.boqs (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  name       text not null,
  version    integer not null default 1 check (version >= 1),
  status     text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index boqs_project_idx on public.boqs (project_id, status);

create table public.boq_lines (
  id            text primary key,
  boq_id        text not null references public.boqs (id) on delete cascade,
  material_name text not null,
  unit          text not null,
  qty           numeric(18,3) not null check (qty >= 0),
  est_unit_price numeric(18,2) not null default 0 check (est_unit_price >= 0),
  category      text,
  note          text
);

create index boq_lines_boq_idx on public.boq_lines (boq_id);

create table public.saved_suppliers (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  supplier_id text not null references public.suppliers (id) on delete cascade,
  saved_by   text not null,
  note       text,
  created_at timestamptz not null default now(),
  constraint saved_suppliers_pair_unique unique (project_id, supplier_id)
);

create index saved_suppliers_project_idx on public.saved_suppliers (project_id);
create index saved_suppliers_supplier_id_idx on public.saved_suppliers (supplier_id);

-- ---------------------------------------------------------------------------
-- 9. Universal attachments
-- ---------------------------------------------------------------------------

-- Attachment — file metadata (bytes in Storage). Document-intelligence
-- extraction NEVER writes official records; review_status gates use.
create table public.attachments (
  id                  text primary key,
  entity_type         text not null
    check (entity_type in ('quote', 'purchase_order', 'invoice', 'delivery',
                           'boq', 'payment_request', 'document')),
  entity_id           text not null,
  file_name           text not null,
  storage_key         text not null,
  kind                text,
  uploaded_by         text not null,
  project_id          text references public.projects (id) on delete cascade,
  created_at          timestamptz not null default now(),
  category            text
    check (category is null or category in
      ('contract', 'drawing', 'permit', 'receipt', 'boq', 'invoice', 'quote', 'other')),
  mime_type           text,
  size_bytes          integer check (size_bytes is null or size_bytes >= 0),
  title               text,
  version             integer not null default 1 check (version >= 1),
  expires_at          timestamptz,
  ocr_text            text,
  extracted_json      jsonb,
  extraction_confidence double precision
    check (extraction_confidence is null or (extraction_confidence between 0 and 1)),
  extraction_model    text,
  review_status       text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by         text,
  reviewed_at         timestamptz
);

create index attachments_project_idx on public.attachments (project_id);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);
create index attachments_expiry_idx on public.attachments (expires_at) where expires_at is not null;

-- ---------------------------------------------------------------------------
-- 10. Platform: events, jobs, flags, health
-- ---------------------------------------------------------------------------

create table public.domain_events (
  id           text primary key,
  project_id   text references public.projects (id) on delete cascade,
  type         text not null,
  payload      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index domain_events_project_idx on public.domain_events (project_id);
create index domain_events_unprocessed_idx on public.domain_events (occurred_at) where processed_at is null;

create table public.job_records (
  id              text primary key,
  type            text not null,
  project_id      text references public.projects (id) on delete cascade,
  status          text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'retrying')),
  payload         jsonb not null default '{}'::jsonb,
  result          text,
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  run_at          timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  max_attempts    integer not null default 3 check (max_attempts >= 1),
  last_attempt_at timestamptz
);

create index job_records_due_idx on public.job_records (status, run_at);
create index job_records_project_idx on public.job_records (project_id);

create table public.feature_flags (
  id          text primary key,
  key         text not null unique,
  enabled     boolean not null default true,
  description text,
  updated_at  timestamptz not null default now()
);

create table public.project_health (
  id         text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  computed_at timestamptz not null default now(),
  overall    integer not null default 0 check (overall between 0 and 100),
  dimensions jsonb not null default '[]'::jsonb
);

create index project_health_project_idx on public.project_health (project_id, computed_at desc);

-- ---------------------------------------------------------------------------
-- 11. AI advisory artifacts (all append-only by contract)
-- ---------------------------------------------------------------------------

-- AiReviewNote — advisory review of a frozen DrawPack (AI flags, humans
-- decide; human-decision columns stay null until a human writes them).
create table public.ai_review_notes (
  id            text primary key,
  draw_pack_id  text not null references public.draw_packs (id) on delete cascade,
  project_id    text not null references public.projects (id) on delete cascade,
  provider_id   text not null,
  model_label   text not null,
  rule_version  integer not null default 1 check (rule_version >= 1),
  verdict       text not null check (verdict in ('consistent', 'advisory', 'escalate')),
  summary       text not null,
  confidence    text not null default 'low' check (confidence in ('low', 'medium', 'high')),
  findings      jsonb not null default '[]'::jsonb,
  inputs_hash   text not null,
  reviewed_by   text,
  reviewed_at   timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);

create index ai_review_notes_pack_idx on public.ai_review_notes (draw_pack_id, created_at desc);
create index ai_review_notes_project_idx on public.ai_review_notes (project_id);

-- PhotoHash — dHash fingerprint (plain columns by design, mirroring Prisma).
create table public.photo_hashes (
  id          text primary key,
  photo_id    text not null unique,
  project_id  text not null,
  storage_key text not null,
  hash_hex    text not null,
  width       integer check (width is null or width >= 0),
  height      integer check (height is null or height >= 0),
  pack_id     text,
  computed_at timestamptz not null default now()
);

create index photo_hashes_project_idx on public.photo_hashes (project_id);
create index photo_hashes_hash_idx on public.photo_hashes (hash_hex);
create index photo_hashes_pack_idx on public.photo_hashes (pack_id) where pack_id is not null;

-- AiInsight — advisory authenticity findings (human decision columns stay
-- null until the future decide action).
create table public.ai_insights (
  id          text primary key,
  project_id  text not null references public.projects (id) on delete cascade,
  target_type text not null check (target_type in ('site_photo', 'draw_pack')),
  target_id   text not null,
  pack_id     text,
  kind        text not null check (kind in ('duplicate', 'phase_mismatch', 'render_suspect')),
  source      text not null check (source in ('dhash', 'vision')),
  severity    text not null default 'warning'
    check (severity in ('info', 'warning', 'critical')),
  detail      jsonb not null,
  confidence  text check (confidence is null or confidence in ('low', 'medium', 'high')),
  decided_by  text,
  decision    text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index ai_insights_project_idx on public.ai_insights (project_id, created_at desc);
create index ai_insights_target_idx on public.ai_insights (target_type, target_id);

-- TrustDigest — deterministic weekly "what your money did" digest + optional
-- TTS audio. Text is the product; audio honesty is explicit.
create table public.trust_digests (
  id            text primary key,
  project_id    text not null references public.projects (id) on delete cascade,
  lang          text not null check (lang in ('en', 'sw')),
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  text          text not null,
  text_hash     text not null,
  audio_base64  text,
  audio_mime    text,
  audio_status  text not null default 'unavailable'
    check (audio_status in ('unavailable', 'failed', 'ready')),
  audio_error   text,
  provider_id   text,
  rule_version  integer not null default 1 check (rule_version >= 1),
  created_at    timestamptz not null default now()
);

create index trust_digests_latest_idx on public.trust_digests (project_id, lang, created_at desc);

-- ============================================================================
-- End of 0001_schema.sql — 68 tables.
-- RLS policies, profiles, triggers: 0002_rls.sql.
-- Storage/realtime/pg_cron: 0003_platform.sql.
-- ============================================================================
