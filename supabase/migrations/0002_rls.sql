-- ============================================================================
-- Mjengo-OS — Supabase target-state RLS + integrity layer (issue #95, ADR 0002)
-- File: supabase/migrations/0002_rls.sql   (requires 0001_schema.sql applied)
--
-- ENFORCEMENT SPLIT (the honest statement — see design doc §5):
--   RLS  = row tenancy: WHICH rows a principal may touch (client project pin,
--          supplier row pin, staff bands, append-only disciplines).
--   API  = action authorization: WHAT a role may do (guard.ts route
--          allowlists, state ladders, business rules) — unchanged authority.
-- RLS write grants are therefore never NARROWER than the API allows (that
-- would break legitimate actions); they may be broader (the API still
-- refuses). anon gets nothing; service_role bypasses RLS by design (the
-- Phase-1 Prisma path + system jobs use it, documented in the ADR).
--
-- All helpers fail CLOSED on unknown/missing roles — mirroring guard.ts and
-- permissions.ts. Claims are minted server-side only (auth hook §C).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. Session helpers (STABLE, no table reads → safe inside policies)
-- ----------------------------------------------------------------------------

create or replace function public.app_role() returns text
language sql stable as
$$ select coalesce(auth.jwt() ->> 'app_role', '') $$;

create or replace function public.app_project_id() returns text
language sql stable as
$$ select nullif(auth.jwt() ->> 'app_project_id', '') $$;

create or replace function public.app_supplier_id() returns text
language sql stable as
$$ select nullif(auth.jwt() ->> 'app_supplier_id', '') $$;

create or replace function public.auth_user_id() returns text
language sql stable as
$$ select coalesce(auth.uid()::text, '') $$;

-- Mirror of guard.ts KNOWN_ROLES / OWNER_ROLES (keep in sync, same rule as
-- src/shared/permissions.ts).
create or replace function public.is_staff() returns boolean
language sql stable as
$$
  select public.app_role() in
    ('contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance')
$$;

create or replace function public.is_admin() returns boolean
language sql stable as
$$ select public.app_role() = 'admin' $$;

-- Tenancy read: staff see all projects; a client sees ONLY the pinned
-- project; suppliers and unknown roles see nothing project-scoped (mirror
-- of v1 scope.ts clientClientProjectPin + supplierProjectDeny).
create or replace function public.can_read_project(pid text) returns boolean
language sql stable as
$$
  select public.is_staff()
     or (public.app_role() = 'client'
         and pid is not null
         and pid = public.app_project_id())
$$;

-- Tenancy write: staff anywhere; a client only inside their own project.
-- (Suppliers get dedicated per-table policies — never this helper.)
create or replace function public.can_write_project(pid text) returns boolean
language sql stable as
$$
  select public.is_staff()
     or (public.app_role() = 'client'
         and pid is not null
         and pid = public.app_project_id())
$$;

-- Supplier row pin: true when the session IS this supplier (mirror of v1
-- scope.ts supplierRowPin — fails closed when no supplier is linked).
create or replace function public.is_own_supplier_row(sid text) returns boolean
language sql stable as
$$
  select public.app_role() = 'supplier'
     and sid is not null
     and sid = public.app_supplier_id()
$$;

-- Maintenance escape hatch for the immutability triggers (§E): ops sets
--   set local mjengo.allow_maintenance = 'on';
-- inside an explicit maintenance transaction ONLY (archival deletes, project
-- purges). Documented in the design doc §9 runbook.
create or replace function public.maintenance_allowed() returns boolean
language sql stable as
$$ select coalesce(current_setting('mjengo.allow_maintenance', true), 'off') = 'on' $$;

-- ---------------------------------------------------------------------------
-- B. Enable RLS everywhere + revoke anon table privileges (belt and braces)
--    69 tables = 68 model tables + profiles (§C).
--    NOTE: no FORCE — the table owner (Supabase postgres / service path)
--    bypasses RLS by design; that bypass IS the documented service path.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'projects','phases','tasks','workers','attendances','materials','deliveries',
    'consumptions','site_zones','site_photos','alerts','transactions','recaps',
    'audit_events','escrow_wallets','milestones','variation_orders','draw_packs',
    'photo_comments','notifications','users','push_subscriptions','project_team',
    'project_memberships',
    'land_parcels','parcel_documents','title_searches','professionals',
    'credential_checks','parcel_assignments','suppliers','catalog_items',
    'material_requests','material_request_lines','approval_rules','approvals',
    'quotes','quote_lines','purchase_orders','purchase_order_lines',
    'order_deliveries','order_delivery_lines','delivery_photos','invoices',
    'invoice_lines','risk_assessments','mjengo_scores','intel_digests',
    'price_points','ledger_accounts','ledger_transactions','ledger_entries',
    'idempotency_records','wallet_accounts','payment_requests','inventory_items',
    'stock_movements','stock_counts','stock_count_items','boqs','boq_lines','saved_suppliers','attachments',
    'domain_events','job_records','feature_flags','project_health',
    'ai_review_notes','photo_hashes','ai_insights','trust_digests','profiles'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- C. Supabase Auth mapping (Phase 2 target): profiles + JWT claims
-- ----------------------------------------------------------------------------

-- profiles — one row per auth.users account carrying the app role model.
-- During Phase-1 coexistence, legacy_user_id links to public.users rows.
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  full_name          text not null default '',
  app_role           text not null default 'contractor'
    check (app_role in ('contractor','client','admin','finance','supervisor',
                        'procurement','qs','supplier')),
  pinned_project_id  text, -- client-role pin (plain scalar, mirrors users.project_id)
  supplier_id        text, -- supplier-role pin (plain scalar, mirrors users.supplier_id)
  notification_prefs jsonb,
  legacy_user_id     text, -- Phase-1 public.users link (retired at cutover)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index profiles_app_role_idx on public.profiles (app_role);
create unique index profiles_legacy_user_idx on public.profiles (legacy_user_id)
  where legacy_user_id is not null;

-- Auto-provision a profile at signup (standard Supabase pattern). Claims are
-- then read from profiles by the token hook below — server-side only.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as
$$
begin
  insert into public.profiles (id, full_name, app_role)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', ''),
          coalesce(new.raw_user_meta_data ->> 'app_role', 'contractor'))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Custom access token hook: stamps app_role / app_project_id / app_supplier_id
-- into every access token. ENABLE the hook via the Supabase dashboard
-- (Authentication → Hooks → Custom Access Token) or the platform API after
-- applying this migration. Claims are minted here — clients cannot forge them.
create or replace function auth.custom_access_token_hook() returns jsonb
language plpgsql stable as
$$
declare
  claims   jsonb;
  p        public.profiles;
begin
  claims := coalesce(auth.jwt() -> 'app_metadata', '{}'::jsonb);
  select * into p from public.profiles where id = auth.uid();
  if p.id is not null then
    claims := jsonb_set(claims, '{app_role}',        to_jsonb(p.app_role));
    claims := jsonb_set(claims, '{app_project_id}',  to_jsonb(p.pinned_project_id));
    claims := jsonb_set(claims, '{app_supplier_id}', to_jsonb(p.supplier_id));
  end if;
  return claims;
end $$;

-- profiles policies: self read; self update limited to safe columns (guard
-- trigger below); staff manage everything; signup inserts happen through the
-- security-definer trigger above.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_staff())
  with check (id = auth.uid() or public.is_staff());
create policy profiles_staff_insert on public.profiles for insert to authenticated
  with check (public.is_staff());
create policy profiles_staff_delete on public.profiles for delete to authenticated
  using (public.is_staff());

-- Role/pin columns are NEVER self-service: a user may only touch their name
-- and notification prefs. Staff (admin) change roles via the platform.
create or replace function public.guard_profiles_update() returns trigger
language plpgsql as
$$
begin
  if public.maintenance_allowed() then return new; end if;
  if public.is_staff() then return new; end if;
  if new.app_role is distinct from old.app_role
     or new.pinned_project_id is distinct from old.pinned_project_id
     or new.supplier_id is distinct from old.supplier_id
     or new.legacy_user_id is distinct from old.legacy_user_id then
    raise exception 'profiles: role/project/supplier columns are staff-managed'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profiles_update();

-- ---------------------------------------------------------------------------
-- D. Integrity triggers (DB-enforced disciplines that today live only in
--     service code — triggers fire even for the service role)
-- ----------------------------------------------------------------------------

-- updated_at (the Prisma @updatedAt responsibility, DB-owned from now on)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as
$$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'projects','tasks','escrow_wallets','land_parcels','professionals','suppliers',
    'catalog_items','material_requests','approval_rules','quotes',
    'purchase_orders','invoices','wallet_accounts','payment_requests',
    'inventory_items','boqs','feature_flags','push_subscriptions','profiles'
  ] loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- Offline-sync entity versions: appliers own the bump; the DB only forbids
-- regressions (a stale write can never silently roll a row back).
create or replace function public.guard_version_monotonic() returns trigger
language plpgsql as
$$
begin
  if new.version < old.version then
    raise exception '%.version regressed (% -> %): stale write rejected',
      tg_table_name, old.version, new.version
      using errcode = '40001';
  end if;
  return new;
end $$;

create trigger tasks_version_guard before update on public.tasks
  for each row execute function public.guard_version_monotonic();
create trigger attendances_version_guard before update on public.attendances
  for each row execute function public.guard_version_monotonic();

-- Append-only discipline: UPDATE/DELETE rejected unless the explicit
-- maintenance GUC is set (§A). Applies to the trust/money/history artifacts
-- the service layer already treats as append-only — now DB-enforced:
--   audit_events, mjengo_scores, risk_assessments, intel_digests,
--   project_health, draw_packs, photo_hashes, ai_review_notes, ai_insights,
--   trust_digests, stock_movements, ledger_entries, ledger_transactions,
--   idempotency_records, credential_checks, price_points
-- #133 / DB-11: ledger_transactions joined the blanket set — reversals are
-- NEW rows linked via reversal_of_id ("was reversed?" derived from the
-- link), so the old reversal-marking update guard had nothing left to
-- whitelist and was removed; the table is INSERT/SELECT-only exactly like
-- ledger_entries. (On the SQLite twin, migration 21 keeps ONE legal
-- update — the pending→posted posting transition that carries the balance
-- gate; Postgres needs no such transition because the balanced-legs
-- constraint below is deferred to COMMIT and rows are born posted.)
-- DEVIATION (documented, deliberate): today a project DELETE cascades these
-- rows away silently. With this trigger, cascade deletes fail unless ops
-- sets mjengo.allow_maintenance — money-grade audit history must not vanish
-- as a side effect. See design doc §9 runbook.
create or replace function public.reject_mutation() returns trigger
language plpgsql as
$$
begin
  if public.maintenance_allowed() then
    return coalesce(new, old);
  end if;
  raise exception '% is append-only (attempted % rejected; set mjengo.allow_maintenance for archival ops)',
    tg_table_name, tg_op using errcode = '42501';
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'audit_events','mjengo_scores','risk_assessments','intel_digests',
    'project_health','draw_packs','photo_hashes','ai_review_notes',
    'ai_insights','trust_digests','stock_movements','ledger_entries',
    'ledger_transactions','idempotency_records','credential_checks','price_points'
  ] loop
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function public.reject_mutation()',
                   t || '_immutable', t);
  end loop;
end $$;

-- (#133 / DB-11) The reversal-only update guard that used to live here
-- (guard_ledger_txn_update + the ledger_transactions_update_guard /
-- ledger_transactions_delete_guard triggers) was REMOVED: with reversals
-- modeled as new rows linked via reversal_of_id, there is no legal update
-- on ledger_transactions to whitelist — the blanket reject_mutation()
-- trigger above (ledger_transactions_immutable, before update or delete)
-- enforces INSERT/SELECT-only parity with ledger_entries.

-- Balanced-legs invariant (spec §39): Σ debits = Σ credits per transaction,
-- checked at COMMIT (deferred), on top of the service-layer validation.
create or replace function public.assert_ledger_balanced() returns trigger
language plpgsql as
$$
declare
  debits  numeric(18,2);
  credits numeric(18,2);
begin
  select coalesce(sum(amount) filter (where side = 'debit'), 0),
         coalesce(sum(amount) filter (where side = 'credit'), 0)
    into debits, credits
    from public.ledger_entries where txn_id = coalesce(new.txn_id, old.txn_id);
  if debits <> credits then
    raise exception 'ledger transaction % unbalanced: debits % <> credits %',
      coalesce(new.txn_id, old.txn_id), debits, credits
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger ledger_entries_balanced
  after insert or update or delete on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.assert_ledger_balanced();

-- Escrow balance can never go negative (belt-and-braces for the projection;
-- the ledger remains the source of truth).
create or replace function public.guard_escrow_balance() returns trigger
language plpgsql as
$$
begin
  if new.balance < 0 then
    raise exception 'escrow_wallets.balance cannot be negative (%)', new.balance
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger escrow_wallets_balance_guard
  before insert or update on public.escrow_wallets
  for each row execute function public.guard_escrow_balance();

-- ---------------------------------------------------------------------------
-- E. RLS policies — the matrix (design doc §6 carries the full rationale)
-- ----------------------------------------------------------------------------

-- §E1. Core project domain ---------------------------------------------------

create policy projects_select on public.projects for select to authenticated
  using (public.can_read_project(id));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.is_staff()); -- project.create = contractor/admin (API)
create policy projects_update on public.projects for update to authenticated
  using (public.can_write_project(id)) with check (public.can_write_project(id));
create policy projects_delete on public.projects for delete to authenticated
  using (public.is_staff());

create policy phases_select on public.phases for select to authenticated
  using (public.can_read_project(project_id));
create policy phases_insert on public.phases for insert to authenticated
  with check (public.can_write_project(project_id));
create policy phases_update on public.phases for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy phases_delete on public.phases for delete to authenticated
  using (public.is_staff());

create policy tasks_select on public.tasks for select to authenticated
  using (exists (select 1 from public.phases p where p.id = phase_id and public.can_read_project(p.project_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (exists (select 1 from public.phases p where p.id = phase_id and public.can_write_project(p.project_id)));
create policy tasks_update on public.tasks for update to authenticated
  using (exists (select 1 from public.phases p where p.id = phase_id and public.can_write_project(p.project_id)))
  with check (exists (select 1 from public.phases p where p.id = phase_id and public.can_write_project(p.project_id)));
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_staff());

create policy workers_select on public.workers for select to authenticated
  using (public.can_read_project(project_id));
create policy workers_insert on public.workers for insert to authenticated
  with check (public.can_write_project(project_id));
create policy workers_update on public.workers for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy workers_delete on public.workers for delete to authenticated
  using (public.is_staff());

create policy attendances_select on public.attendances for select to authenticated
  using (public.can_read_project(project_id));
create policy attendances_insert on public.attendances for insert to authenticated
  with check (public.can_write_project(project_id));
create policy attendances_update on public.attendances for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy attendances_delete on public.attendances for delete to authenticated
  using (public.is_staff());

create policy materials_select on public.materials for select to authenticated
  using (true); -- global indicative catalog (authenticated read, staff write)
create policy materials_insert on public.materials for insert to authenticated
  with check (public.is_staff());
create policy materials_update on public.materials for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy materials_delete on public.materials for delete to authenticated
  using (public.is_staff());

create policy deliveries_select on public.deliveries for select to authenticated
  using (public.can_read_project(project_id));
create policy deliveries_insert on public.deliveries for insert to authenticated
  with check (public.can_write_project(project_id));
create policy deliveries_update on public.deliveries for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy deliveries_delete on public.deliveries for delete to authenticated
  using (public.is_staff());

create policy consumptions_select on public.consumptions for select to authenticated
  using (public.can_read_project(project_id));
create policy consumptions_insert on public.consumptions for insert to authenticated
  with check (public.can_write_project(project_id));
create policy consumptions_delete on public.consumptions for delete to authenticated
  using (public.is_staff());

create policy site_zones_select on public.site_zones for select to authenticated
  using (public.can_read_project(project_id));
create policy site_zones_insert on public.site_zones for insert to authenticated
  with check (public.can_write_project(project_id));
create policy site_zones_update on public.site_zones for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy site_zones_delete on public.site_zones for delete to authenticated
  using (public.is_staff());

create policy site_photos_select on public.site_photos for select to authenticated
  using (public.can_read_project(project_id));
create policy site_photos_insert on public.site_photos for insert to authenticated
  with check (public.can_write_project(project_id));
create policy site_photos_update on public.site_photos for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy site_photos_delete on public.site_photos for delete to authenticated
  using (public.is_staff());

create policy alerts_select on public.alerts for select to authenticated
  using (public.can_read_project(project_id));
create policy alerts_insert on public.alerts for insert to authenticated
  with check (public.can_write_project(project_id));
create policy alerts_update on public.alerts for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy alerts_delete on public.alerts for delete to authenticated
  using (public.is_staff());

create policy transactions_select on public.transactions for select to authenticated
  using (public.can_read_project(project_id));
create policy transactions_insert on public.transactions for insert to authenticated
  with check (public.can_write_project(project_id));
create policy transactions_update on public.transactions for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy transactions_delete on public.transactions for delete to authenticated
  using (public.is_staff());

create policy recaps_select on public.recaps for select to authenticated
  using (public.can_read_project(project_id));
create policy recaps_insert on public.recaps for insert to authenticated
  with check (public.can_write_project(project_id));
create policy recaps_delete on public.recaps for delete to authenticated
  using (public.is_staff());

-- §E2. Trust & money ----------------------------------------------------------

-- Audit trail: admin-only reads (mirrors the audit tab role), staff/system
-- writes through the service path.
create policy audit_events_select on public.audit_events for select to authenticated
  using (public.is_admin());
create policy audit_events_insert on public.audit_events for insert to authenticated
  with check (public.is_staff());

-- Escrow projection: client-readable, staff-written (the ledger is truth).
create policy escrow_wallets_select on public.escrow_wallets for select to authenticated
  using (public.can_read_project(project_id));
create policy escrow_wallets_insert on public.escrow_wallets for insert to authenticated
  with check (public.is_staff());
create policy escrow_wallets_update on public.escrow_wallets for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy escrow_wallets_delete on public.escrow_wallets for delete to authenticated
  using (public.is_staff());

create policy milestones_select on public.milestones for select to authenticated
  using (public.can_read_project(project_id));
create policy milestones_insert on public.milestones for insert to authenticated
  with check (public.can_write_project(project_id));
create policy milestones_update on public.milestones for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy milestones_delete on public.milestones for delete to authenticated
  using (public.is_staff());

create policy variation_orders_select on public.variation_orders for select to authenticated
  using (public.can_read_project(project_id));
create policy variation_orders_insert on public.variation_orders for insert to authenticated
  with check (public.can_write_project(project_id));
create policy variation_orders_update on public.variation_orders for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy variation_orders_delete on public.variation_orders for delete to authenticated
  using (public.is_staff());

create policy draw_packs_select on public.draw_packs for select to authenticated
  using (public.can_read_project(project_id));
create policy draw_packs_insert on public.draw_packs for insert to authenticated
  with check (public.is_staff());

create policy photo_comments_select on public.photo_comments for select to authenticated
  using (public.can_read_project(project_id));
create policy photo_comments_insert on public.photo_comments for insert to authenticated
  with check (public.can_write_project(project_id));
create policy photo_comments_update on public.photo_comments for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy photo_comments_delete on public.photo_comments for delete to authenticated
  using (public.is_staff());

create policy notifications_select on public.notifications for select to authenticated
  using ((project_id is null and public.is_staff()) or public.can_read_project(project_id));
create policy notifications_insert on public.notifications for insert to authenticated
  with check ((project_id is null and public.is_staff()) or public.can_write_project(project_id));
create policy notifications_update on public.notifications for update to authenticated
  using ((project_id is null and public.is_staff()) or public.can_write_project(project_id))
  with check ((project_id is null and public.is_staff()) or public.can_write_project(project_id));
create policy notifications_delete on public.notifications for delete to authenticated
  using (public.is_staff());

-- Phase-1 user store (NextAuth): staff-only. Supabase-Auth sessions use
-- profiles (§C). Retired at the Phase-2 cutover.
create policy users_select on public.users for select to authenticated
  using (public.is_staff());
create policy users_insert on public.users for insert to authenticated
  with check (public.is_staff());
create policy users_update on public.users for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy users_delete on public.users for delete to authenticated
  using (public.is_staff());

-- Push subscriptions: owner-scoped (upsert key = endpoint; pruning runs on
-- the service path).
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = public.auth_user_id() or public.is_staff());
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = public.auth_user_id() or public.is_staff());
create policy push_subscriptions_update on public.push_subscriptions for update to authenticated
  using (user_id = public.auth_user_id() or public.is_staff())
  with check (user_id = public.auth_user_id() or public.is_staff());
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = public.auth_user_id() or public.is_staff());

create policy project_team_select on public.project_team for select to authenticated
  using (public.can_read_project(project_id));
create policy project_team_insert on public.project_team for insert to authenticated
  with check (public.can_write_project(project_id));
create policy project_team_update on public.project_team for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy project_team_delete on public.project_team for delete to authenticated
  using (public.is_staff());

-- Issue #174 (SEC-6): the site-team read-scope grant rows — staff-managed
-- (the SQLite path's seed + future grant tooling writes them; the app reads).
create policy project_memberships_select on public.project_memberships for select to authenticated
  using (public.can_read_project(project_id));
create policy project_memberships_insert on public.project_memberships for insert to authenticated
  with check (public.is_staff());
create policy project_memberships_update on public.project_memberships for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy project_memberships_delete on public.project_memberships for delete to authenticated
  using (public.is_staff());

-- §E3. Land & property --------------------------------------------------------

create policy land_parcels_select on public.land_parcels for select to authenticated
  using (public.can_read_project(project_id));
create policy land_parcels_insert on public.land_parcels for insert to authenticated
  with check (public.can_write_project(project_id));
create policy land_parcels_update on public.land_parcels for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy land_parcels_delete on public.land_parcels for delete to authenticated
  using (public.is_staff());

create policy parcel_documents_select on public.parcel_documents for select to authenticated
  using (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_read_project(lp.project_id)));
create policy parcel_documents_insert on public.parcel_documents for insert to authenticated
  with check (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)));
create policy parcel_documents_update on public.parcel_documents for update to authenticated
  using (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)))
  with check (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)));
create policy parcel_documents_delete on public.parcel_documents for delete to authenticated
  using (public.is_staff());

create policy title_searches_select on public.title_searches for select to authenticated
  using (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_read_project(lp.project_id)));
create policy title_searches_insert on public.title_searches for insert to authenticated
  with check (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)));
create policy title_searches_update on public.title_searches for update to authenticated
  using (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)))
  with check (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)));
create policy title_searches_delete on public.title_searches for delete to authenticated
  using (public.is_staff());

-- Professionals directory: authenticated read (public-facing directory),
-- staff writes. Credential checks are append-only (immutable trigger §D).
create policy professionals_select on public.professionals for select to authenticated
  using (true);
create policy professionals_insert on public.professionals for insert to authenticated
  with check (public.is_staff());
create policy professionals_update on public.professionals for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy professionals_delete on public.professionals for delete to authenticated
  using (public.is_staff());

create policy credential_checks_select on public.credential_checks for select to authenticated
  using (true);
create policy credential_checks_insert on public.credential_checks for insert to authenticated
  with check (public.is_staff());

create policy parcel_assignments_select on public.parcel_assignments for select to authenticated
  using (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_read_project(lp.project_id)));
create policy parcel_assignments_insert on public.parcel_assignments for insert to authenticated
  with check (exists (select 1 from public.land_parcels lp where lp.id = parcel_id and public.can_write_project(lp.project_id)));
create policy parcel_assignments_delete on public.parcel_assignments for delete to authenticated
  using (public.is_staff());

-- §E4. Supply & procurement ---------------------------------------------------

create policy suppliers_select on public.suppliers for select to authenticated
  using (public.is_staff() or public.app_role() = 'client' or public.is_own_supplier_row(id));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (public.is_staff());
create policy suppliers_update on public.suppliers for update to authenticated
  using (public.is_staff() or public.is_own_supplier_row(id))
  with check (public.is_staff() or public.is_own_supplier_row(id));
create policy suppliers_delete on public.suppliers for delete to authenticated
  using (public.is_staff());

create policy catalog_items_select on public.catalog_items for select to authenticated
  using (public.is_staff() or public.app_role() = 'client' or public.is_own_supplier_row(supplier_id));
create policy catalog_items_insert on public.catalog_items for insert to authenticated
  with check (public.is_staff() or public.is_own_supplier_row(supplier_id));
create policy catalog_items_update on public.catalog_items for update to authenticated
  using (public.is_staff() or public.is_own_supplier_row(supplier_id))
  with check (public.is_staff() or public.is_own_supplier_row(supplier_id));
create policy catalog_items_delete on public.catalog_items for delete to authenticated
  using (public.is_staff());

create policy material_requests_select on public.material_requests for select to authenticated
  using (public.can_read_project(project_id));
create policy material_requests_insert on public.material_requests for insert to authenticated
  with check (public.can_write_project(project_id));
create policy material_requests_update on public.material_requests for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy material_requests_delete on public.material_requests for delete to authenticated
  using (public.is_staff());

create policy material_request_lines_select on public.material_request_lines for select to authenticated
  using (exists (select 1 from public.material_requests r where r.id = request_id and public.can_read_project(r.project_id)));
create policy material_request_lines_insert on public.material_request_lines for insert to authenticated
  with check (exists (select 1 from public.material_requests r where r.id = request_id and public.can_write_project(r.project_id)));
create policy material_request_lines_delete on public.material_request_lines for delete to authenticated
  using (public.is_staff());

create policy approval_rules_select on public.approval_rules for select to authenticated
  using (public.can_read_project(project_id));
create policy approval_rules_insert on public.approval_rules for insert to authenticated
  with check (public.can_write_project(project_id));
create policy approval_rules_update on public.approval_rules for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy approval_rules_delete on public.approval_rules for delete to authenticated
  using (public.is_staff());

create policy approvals_select on public.approvals for select to authenticated
  using (public.can_read_project(project_id));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (public.can_write_project(project_id));
create policy approvals_delete on public.approvals for delete to authenticated
  using (public.is_staff());

-- Quotes: buyers read via project tenancy; suppliers see/bid their own rows.
create policy quotes_select on public.quotes for select to authenticated
  using (public.is_own_supplier_row(supplier_id)
     or exists (select 1 from public.material_requests r
                where r.id = request_id and public.can_read_project(r.project_id)));
create policy quotes_insert on public.quotes for insert to authenticated
  with check (public.is_own_supplier_row(supplier_id)
     or exists (select 1 from public.material_requests r
                where r.id = request_id and public.can_write_project(r.project_id)));
create policy quotes_update on public.quotes for update to authenticated
  using (public.is_own_supplier_row(supplier_id)
     or exists (select 1 from public.material_requests r
                where r.id = request_id and public.can_write_project(r.project_id)))
  with check (public.is_own_supplier_row(supplier_id)
     or exists (select 1 from public.material_requests r
                where r.id = request_id and public.can_write_project(r.project_id)));
create policy quotes_delete on public.quotes for delete to authenticated
  using (public.is_staff());

create policy quote_lines_select on public.quote_lines for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id
                 and (public.is_own_supplier_row(q.supplier_id)
                   or exists (select 1 from public.material_requests r
                              where r.id = q.request_id and public.can_read_project(r.project_id)))));
create policy quote_lines_insert on public.quote_lines for insert to authenticated
  with check (exists (select 1 from public.quotes q where q.id = quote_id
                 and (public.is_own_supplier_row(q.supplier_id)
                   or exists (select 1 from public.material_requests r
                              where r.id = q.request_id and public.can_write_project(r.project_id)))));
create policy quote_lines_delete on public.quote_lines for delete to authenticated
  using (public.is_staff());

-- Purchase orders: buyers via project tenancy; supplier via their own rows
-- (confirm/dispatch flows). PO creation is buyer-side only.
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (public.is_own_supplier_row(supplier_id) or public.can_read_project(project_id));
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated
  with check (public.can_write_project(project_id));
create policy purchase_orders_update on public.purchase_orders for update to authenticated
  using (public.is_own_supplier_row(supplier_id) or public.can_write_project(project_id))
  with check (public.is_own_supplier_row(supplier_id) or public.can_write_project(project_id));
create policy purchase_orders_delete on public.purchase_orders for delete to authenticated
  using (public.is_staff());

create policy purchase_order_lines_select on public.purchase_order_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_read_project(po.project_id))));
create policy purchase_order_lines_insert on public.purchase_order_lines for insert to authenticated
  with check (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))));
create policy purchase_order_lines_delete on public.purchase_order_lines for delete to authenticated
  using (public.is_staff());

-- Order deliveries: both buyer and the order's supplier act on them
-- (dispatch → in_transit → received + discrepancy evidence photos).
create policy order_deliveries_select on public.order_deliveries for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_read_project(po.project_id))));
create policy order_deliveries_insert on public.order_deliveries for insert to authenticated
  with check (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))));
create policy order_deliveries_update on public.order_deliveries for update to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))))
  with check (exists (select 1 from public.purchase_orders po where po.id = order_id
                 and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))));
create policy order_deliveries_delete on public.order_deliveries for delete to authenticated
  using (public.is_staff());

create policy order_delivery_lines_select on public.order_delivery_lines for select to authenticated
  using (exists (select 1 from public.order_deliveries od
                 join public.purchase_orders po on po.id = od.order_id
                 where od.id = delivery_id
                   and (public.is_own_supplier_row(po.supplier_id) or public.can_read_project(po.project_id))));
create policy order_delivery_lines_insert on public.order_delivery_lines for insert to authenticated
  with check (exists (select 1 from public.order_deliveries od
                 join public.purchase_orders po on po.id = od.order_id
                 where od.id = delivery_id
                   and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))));
create policy order_delivery_lines_delete on public.order_delivery_lines for delete to authenticated
  using (public.is_staff());

create policy delivery_photos_select on public.delivery_photos for select to authenticated
  using (exists (select 1 from public.order_deliveries od
                 join public.purchase_orders po on po.id = od.order_id
                 where od.id = delivery_id
                   and (public.is_own_supplier_row(po.supplier_id) or public.can_read_project(po.project_id))));
create policy delivery_photos_insert on public.delivery_photos for insert to authenticated
  with check (exists (select 1 from public.order_deliveries od
                 join public.purchase_orders po on po.id = od.order_id
                 where od.id = delivery_id
                   and (public.is_own_supplier_row(po.supplier_id) or public.can_write_project(po.project_id))));
create policy delivery_photos_delete on public.delivery_photos for delete to authenticated
  using (public.is_staff());

-- Invoices: buyer via project tenancy; supplier submits/updates their own.
create policy invoices_select on public.invoices for select to authenticated
  using (public.is_own_supplier_row(supplier_id) or public.can_read_project(project_id));
create policy invoices_insert on public.invoices for insert to authenticated
  with check (public.is_own_supplier_row(supplier_id) or public.can_write_project(project_id));
create policy invoices_update on public.invoices for update to authenticated
  using (public.is_own_supplier_row(supplier_id) or public.can_write_project(project_id))
  with check (public.is_own_supplier_row(supplier_id) or public.can_write_project(project_id));
create policy invoices_delete on public.invoices for delete to authenticated
  using (public.is_staff());

create policy invoice_lines_select on public.invoice_lines for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.is_own_supplier_row(i.supplier_id) or public.can_read_project(i.project_id))));
create policy invoice_lines_insert on public.invoice_lines for insert to authenticated
  with check (exists (select 1 from public.invoices i where i.id = invoice_id
                 and (public.is_own_supplier_row(i.supplier_id) or public.can_write_project(i.project_id))));
create policy invoice_lines_delete on public.invoice_lines for delete to authenticated
  using (public.is_staff());

-- §E5. Intel (append-only computed artifacts) ----------------------------------

create policy risk_assessments_select on public.risk_assessments for select to authenticated
  using (public.can_read_project(project_id));
create policy risk_assessments_insert on public.risk_assessments for insert to authenticated
  with check (public.is_staff());

create policy mjengo_scores_select on public.mjengo_scores for select to authenticated
  using (public.can_read_project(project_id));
create policy mjengo_scores_insert on public.mjengo_scores for insert to authenticated
  with check (public.is_staff());

create policy intel_digests_select on public.intel_digests for select to authenticated
  using (public.can_read_project(project_id));
create policy intel_digests_insert on public.intel_digests for insert to authenticated
  with check (public.is_staff());

create policy price_points_select on public.price_points for select to authenticated
  using (true);
create policy price_points_insert on public.price_points for insert to authenticated
  with check (public.is_staff());

create policy project_health_select on public.project_health for select to authenticated
  using (public.can_read_project(project_id));
create policy project_health_insert on public.project_health for insert to authenticated
  with check (public.is_staff());

-- §E6. Money core --------------------------------------------------------------

create policy ledger_accounts_select on public.ledger_accounts for select to authenticated
  using ((project_id is null and public.is_staff()) or public.can_read_project(project_id));
create policy ledger_accounts_insert on public.ledger_accounts for insert to authenticated
  with check (public.is_staff());
create policy ledger_accounts_update on public.ledger_accounts for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy ledger_accounts_delete on public.ledger_accounts for delete to authenticated
  using (public.is_staff());

create policy ledger_transactions_select on public.ledger_transactions for select to authenticated
  using ((project_id is null and public.is_staff()) or public.can_read_project(project_id));
create policy ledger_transactions_insert on public.ledger_transactions for insert to authenticated
  with check (public.is_staff());
-- (#133 / DB-11) No update policy — reversals are new rows linked via
-- reversal_of_id; the table is INSERT/SELECT-only like ledger_entries.

create policy ledger_entries_select on public.ledger_entries for select to authenticated
  using (exists (select 1 from public.ledger_transactions t where t.id = txn_id
                 and ((t.project_id is null and public.is_staff()) or public.can_read_project(t.project_id))));
create policy ledger_entries_insert on public.ledger_entries for insert to authenticated
  with check (public.is_staff());

create policy idempotency_records_select on public.idempotency_records for select to authenticated
  using (public.is_staff());
create policy idempotency_records_insert on public.idempotency_records for insert to authenticated
  with check (public.is_staff());

create policy wallet_accounts_select on public.wallet_accounts for select to authenticated
  using (public.is_staff());
create policy wallet_accounts_insert on public.wallet_accounts for insert to authenticated
  with check (public.is_staff());
create policy wallet_accounts_update on public.wallet_accounts for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy wallet_accounts_delete on public.wallet_accounts for delete to authenticated
  using (public.is_staff());

create policy payment_requests_select on public.payment_requests for select to authenticated
  using (public.can_read_project(project_id));
create policy payment_requests_insert on public.payment_requests for insert to authenticated
  with check (public.can_write_project(project_id));
create policy payment_requests_update on public.payment_requests for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy payment_requests_delete on public.payment_requests for delete to authenticated
  using (public.is_staff());

-- §E7. Inventory & BOQ ---------------------------------------------------------

create policy inventory_items_select on public.inventory_items for select to authenticated
  using (public.can_read_project(project_id));
create policy inventory_items_insert on public.inventory_items for insert to authenticated
  with check (public.can_write_project(project_id));
create policy inventory_items_update on public.inventory_items for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy inventory_items_delete on public.inventory_items for delete to authenticated
  using (public.is_staff());

create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.can_read_project(project_id));
create policy stock_movements_insert on public.stock_movements for insert to authenticated
  with check (public.can_write_project(project_id));

-- Stock reconciliation (issue #194): stock_counts carries the open → posted
-- transition (postedAt/postedBy + status), so it needs update like boqs;
-- stock_count_items' posted_qty is written at post time (update via parent).
-- The MOVEMENT ledger stays append-only — these rows are workflow state.
create policy stock_counts_select on public.stock_counts for select to authenticated
  using (public.can_read_project(project_id));
create policy stock_counts_insert on public.stock_counts for insert to authenticated
  with check (public.can_write_project(project_id));
create policy stock_counts_update on public.stock_counts for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy stock_counts_delete on public.stock_counts for delete to authenticated
  using (public.is_staff());

create policy stock_count_items_select on public.stock_count_items for select to authenticated
  using (exists (select 1 from public.stock_counts c where c.id = count_id and public.can_read_project(c.project_id)));
create policy stock_count_items_insert on public.stock_count_items for insert to authenticated
  with check (exists (select 1 from public.stock_counts c where c.id = count_id and public.can_write_project(c.project_id)));
create policy stock_count_items_update on public.stock_count_items for update to authenticated
  using (exists (select 1 from public.stock_counts c where c.id = count_id and public.can_write_project(c.project_id)))
  with check (exists (select 1 from public.stock_counts c where c.id = count_id and public.can_write_project(c.project_id)));
create policy stock_count_items_delete on public.stock_count_items for delete to authenticated
  using (public.is_staff());

create policy boqs_select on public.boqs for select to authenticated
  using (public.can_read_project(project_id));
create policy boqs_insert on public.boqs for insert to authenticated
  with check (public.can_write_project(project_id));
create policy boqs_update on public.boqs for update to authenticated
  using (public.can_write_project(project_id)) with check (public.can_write_project(project_id));
create policy boqs_delete on public.boqs for delete to authenticated
  using (public.is_staff());

create policy boq_lines_select on public.boq_lines for select to authenticated
  using (exists (select 1 from public.boqs b where b.id = boq_id and public.can_read_project(b.project_id)));
create policy boq_lines_insert on public.boq_lines for insert to authenticated
  with check (exists (select 1 from public.boqs b where b.id = boq_id and public.can_write_project(b.project_id)));
create policy boq_lines_delete on public.boq_lines for delete to authenticated
  using (public.is_staff());

create policy saved_suppliers_select on public.saved_suppliers for select to authenticated
  using (public.can_read_project(project_id));
create policy saved_suppliers_insert on public.saved_suppliers for insert to authenticated
  with check (public.can_write_project(project_id));
create policy saved_suppliers_delete on public.saved_suppliers for delete to authenticated
  using (public.is_staff());

-- §E8. Attachments -------------------------------------------------------------

create policy attachments_select on public.attachments for select to authenticated
  using ((project_id is null and public.is_staff()) or public.can_read_project(project_id));
create policy attachments_insert on public.attachments for insert to authenticated
  with check ((project_id is null and public.is_staff()) or public.can_write_project(project_id));
create policy attachments_update on public.attachments for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy attachments_delete on public.attachments for delete to authenticated
  using (public.is_staff());

-- §E9. Platform ----------------------------------------------------------------

create policy domain_events_select on public.domain_events for select to authenticated
  using ((project_id is null and public.is_staff()) or public.can_read_project(project_id));
create policy domain_events_insert on public.domain_events for insert to authenticated
  with check (public.is_staff());
create policy domain_events_update on public.domain_events for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy domain_events_delete on public.domain_events for delete to authenticated
  using (public.is_staff());

-- Jobs: system-plane only (the drainer runs on the service path).
create policy job_records_select on public.job_records for select to authenticated
  using (public.is_staff());
create policy job_records_insert on public.job_records for insert to authenticated
  with check (public.is_staff());
create policy job_records_update on public.job_records for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy job_records_delete on public.job_records for delete to authenticated
  using (public.is_staff());

-- Feature flags: GET mirrors api/flags.ts (admin + contractor); writes admin.
create policy feature_flags_select on public.feature_flags for select to authenticated
  using (public.app_role() in ('admin', 'contractor'));
create policy feature_flags_insert on public.feature_flags for insert to authenticated
  with check (public.is_admin());
create policy feature_flags_update on public.feature_flags for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy feature_flags_delete on public.feature_flags for delete to authenticated
  using (public.is_admin());

-- §E10. AI advisory artifacts (append-only) ------------------------------------

create policy ai_review_notes_select on public.ai_review_notes for select to authenticated
  using (public.can_read_project(project_id));
create policy ai_review_notes_insert on public.ai_review_notes for insert to authenticated
  with check (public.is_staff());

create policy photo_hashes_select on public.photo_hashes for select to authenticated
  using (public.can_read_project(project_id));
create policy photo_hashes_insert on public.photo_hashes for insert to authenticated
  with check (public.is_staff());

create policy ai_insights_select on public.ai_insights for select to authenticated
  using (public.can_read_project(project_id));
create policy ai_insights_insert on public.ai_insights for insert to authenticated
  with check (public.is_staff());

create policy trust_digests_select on public.trust_digests for select to authenticated
  using (public.can_read_project(project_id));
create policy trust_digests_insert on public.trust_digests for insert to authenticated
  with check (public.is_staff());

-- ============================================================================
-- End of 0002_rls.sql.
-- Coverage: RLS enabled + ≥1 policy on all 69 tables (68 models + profiles).
-- Append-only tables have INSERT+SELECT policies ONLY (immutability is also
-- trigger-enforced §D — triggers fire even for the service role).
-- ============================================================================
