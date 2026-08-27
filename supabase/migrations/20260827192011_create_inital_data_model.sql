-- ============================================================================
-- Student Union CRM — initial schema
-- Source: Data Model V1 + Solution Design V1 (Notion)
-- Apply with: supabase db push
-- or paste into the Supabase SQL editor for the first run.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. TENANT
-- ============================================================================

create table tenant (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  primary_domain              text not null unique,
  allowed_identity_providers  text[] not null default array['google','microsoft'],
  created_at                  timestamptz not null default now()
);

alter table tenant enable row level security;

-- ============================================================================
-- 2. APP_USER
-- One row per person per tenant. Maps a Supabase auth identity to a
-- tenant + role. See Solution Design V1 §3.
-- ============================================================================

create table app_user (
  id                 uuid primary key references auth.users(id) on delete cascade,
  tenant_id          uuid not null references tenant(id),
  name               text,
  email              text not null,
  role               text not null check (role in ('member','admin')),
  identity_provider  text check (identity_provider in ('google','microsoft')),
  external_id        text,
  created_at         timestamptz not null default now()
);

create index app_user_tenant_id_idx on app_user (tenant_id);

alter table app_user enable row level security;

-- ============================================================================
-- 3. HELPER FUNCTIONS
-- security definer + fixed search_path so RLS on app_user doesn't block
-- these, and so they can't be hijacked via search_path injection.
-- ============================================================================

create function current_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from app_user where id = auth.uid()
$$;

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_user where id = auth.uid() and role = 'admin')
$$;

create function trigger_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ============================================================================
-- 4. COMPANY
-- The core CRM record. id (not org_number) is the real primary key —
-- org_number is nullable for foreign companies, subsidiaries, and non-AB
-- entities (PRD use case 9).
-- ============================================================================

create table company (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id),
  org_number            text,
  name                  text not null,
  company_form          text not null default 'none'
                          check (company_form in ('AB','KB','EF','none','other')),
  sni_code              text,
  industry_label        text,
  city                  text,
  address               text,
  zip                   text,
  status                text not null default 'prospect'
                          check (status in ('prospect','customer','inactive','do_not_contact')),
  responsible_user_id   uuid references app_user(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Unique only when org_number is present — see Data Model V1 duplicate-handling note.
-- Replaces the old system's workaround of fake org numbers + a manual tag as outlined in Data Model V1
create unique index company_tenant_org_number_key
  on company (tenant_id, org_number)
  where org_number is not null;

create index company_tenant_id_idx on company (tenant_id);
create index company_tenant_name_idx on company (tenant_id, name);
create index company_responsible_user_idx on company (responsible_user_id);

alter table company enable row level security;

create trigger company_set_updated_at
  before update on company
  for each row execute function trigger_set_updated_at();
-- trigger_set_updated_at() defined at row 51.

-- ============================================================================
-- 5. TAGS (many-to-many; PRD use case 7)
-- ============================================================================

create table tag (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table tag enable row level security;

create table company_tag (
  company_id  uuid not null references company(id) on delete cascade,
  tag_id      uuid not null references tag(id) on delete cascade,
  primary key (company_id, tag_id)
);

alter table company_tag enable row level security;

-- ============================================================================
-- 6. COMPANY_REGISTRY_CACHE — global, no tenant_id
-- Shared Bolagsverket cache across all tenants. Written only by the
-- company-lookup Edge Function via the service role.
-- ============================================================================

create table company_registry_cache (
  org_number        text primary key,
  name              text,
  sni_code          text,
  company_form      text,
  address           text,
  last_fetched_at   timestamptz not null default now()
);

alter table company_registry_cache enable row level security;

-- ============================================================================
-- 7. INTERACTION — append-only, source of truth for the cooldown rule
-- No insert/update/delete policy is granted to `authenticated`.
-- The only write path is log_interaction() (row 234).
-- ============================================================================

create table interaction (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  company_id   uuid not null references company(id),
  user_id      uuid not null references app_user(id),
  type         text not null check (type in ('call','email','meeting','other')),
  note         text,
  created_at   timestamptz not null default now()
);

create index interaction_company_created_idx on interaction (company_id, created_at desc);
create index interaction_tenant_id_idx on interaction (tenant_id);

alter table interaction enable row level security;

-- ============================================================================
-- 8. COOLDOWN_OVERRIDE
-- Written only inside log_interaction(), same transaction as the
-- interaction it unblocks.
-- ============================================================================

create table cooldown_override (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  company_id   uuid not null references company(id),
  user_id      uuid not null references app_user(id),
  reason       text not null check (length(trim(reason)) > 0),
  created_at   timestamptz not null default now()
);

create index cooldown_override_company_idx on cooldown_override (company_id);

alter table cooldown_override enable row level security;

-- ============================================================================
-- 9. TASK (follow-up; PRD use case 8)
-- ============================================================================

create table task (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id),
  company_id         uuid references company(id),
  assigned_user_id   uuid references app_user(id),
  title              text not null,
  description        text,
  due_date           date,
  reminder_at        timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz not null default now()
);

create index task_tenant_assigned_idx on task (tenant_id, assigned_user_id);
create index task_company_idx on task (company_id);

alter table task enable row level security;

-- ============================================================================
-- 10. NOTE — free-form, separate from the structured Interaction log
-- ============================================================================

create table note (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id),
  company_id   uuid not null references company(id),
  user_id      uuid not null references app_user(id),
  body         text not null,
  created_at   timestamptz not null default now()
);

create index note_company_idx on note (company_id);

alter table note enable row level security;

-- ============================================================================
-- 11. log_interaction() — the cooldown rule
-- Only path into `interaction`. See Solution Design V1 §5 for full notes.
-- ============================================================================

create function log_interaction(
  p_company_id uuid,
  p_type text,
  p_note text,
  p_override_reason text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := current_tenant();
  v_last timestamptz;
  v_id uuid;
begin
  perform 1 from company
   where id = p_company_id and tenant_id = v_tenant
   for update;

  if not found then
    raise exception 'COMPANY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select max(created_at) into v_last
    from interaction where company_id = p_company_id;

  if v_last is not null and now() - v_last < interval '14 days' then
    if p_override_reason is null or length(trim(p_override_reason)) = 0 then
      raise exception 'COOLDOWN_ACTIVE'
        using errcode = 'P0001',
              detail = json_build_object(
                'days_left',
                ceil(extract(epoch from (v_last + interval '14 days' - now())) / 86400)
              )::text;
    end if;
    insert into cooldown_override (tenant_id, company_id, user_id, reason)
    values (v_tenant, p_company_id, auth.uid(), p_override_reason);
  end if;

  insert into interaction (tenant_id, company_id, user_id, type, note)
  values (v_tenant, p_company_id, auth.uid(), p_type, p_note)
  returning id into v_id;

  return v_id;
end $$;

revoke all on function log_interaction from public;
grant execute on function log_interaction to authenticated;

-- ============================================================================
-- 12. contact_eligibility — view backing list + profile "Available /
-- Cooldown, N days left / Contacted by X on date" (PRD use case 4)
-- security_invoker required or this bypasses RLS on the underlying tables.
-- ============================================================================

create view contact_eligibility
with (security_invoker = true) as
select c.id as company_id,
       i.last_at,
       i.last_user_id,
       (i.last_at is null or now() - i.last_at >= interval '14 days') as available,
       greatest(0, ceil(extract(epoch from
         (i.last_at + interval '14 days' - now())) / 86400))::int as days_left
from company c
left join lateral (
  select created_at as last_at, user_id as last_user_id
    from interaction where company_id = c.id
   order by created_at desc limit 1
) i on true;

grant select on contact_eligibility to authenticated;

-- ============================================================================
-- 13. GRANTS + RLS POLICIES
--
-- Two separate, both-required layers (Supabase docs, "Securing your API"):
--   GRANT  — can this role reach the table at all. Missing grant = 42501
--            "permission denied", raised before any policy is evaluated.
--   POLICY — of the rows the role can reach, which ones does it see.
--
-- As of May 30 2026 Supabase no longer auto-grants table access to new
-- projects, so every grant below is required explicitly — it will not
-- work by default even though it did on older projects. Grant only the
-- operations that have a matching policy; least privilege at the role
-- level, tenant scoping at the row level.
-- ============================================================================

grant usage on schema public to authenticated;

-- tenant: readable only for your own tenant. No write grant —
-- provisioning is service-role only (platform operator).
grant select on tenant to authenticated;

create policy tenant_read on tenant for select
  using (id = current_tenant());

-- app_user: readable within tenant; only admins can update roles.
grant select, update on app_user to authenticated;

create policy app_user_read on app_user for select
  using (tenant_id = current_tenant());

create policy app_user_admin_write on app_user for update
  using (tenant_id = current_tenant() and is_admin())
  with check (tenant_id = current_tenant());

-- company: standard tenant CRUD, delete restricted to admins.
grant select, insert, update, delete on company to authenticated;

create policy company_read on company for select
  using (tenant_id = current_tenant());

create policy company_insert on company for insert
  with check (tenant_id = current_tenant());

create policy company_update on company for update
  using (tenant_id = current_tenant())
  with check (tenant_id = current_tenant());

create policy company_delete on company for delete
  using (tenant_id = current_tenant() and is_admin());

-- tag / company_tag: standard tenant CRUD (no update policy — tags are
-- add/remove, not edited in place).
grant select, insert, delete on tag to authenticated;
grant select, insert, delete on company_tag to authenticated;

create policy tag_read on tag for select
  using (tenant_id = current_tenant());

create policy tag_write on tag for insert
  with check (tenant_id = current_tenant());

create policy tag_delete on tag for delete
  using (tenant_id = current_tenant() and is_admin());

create policy company_tag_read on company_tag for select
  using (exists (select 1 from company c
                  where c.id = company_tag.company_id
                    and c.tenant_id = current_tenant()));

create policy company_tag_write on company_tag for insert
  with check (exists (select 1 from company c
                        where c.id = company_tag.company_id
                          and c.tenant_id = current_tenant()));

create policy company_tag_delete on company_tag for delete
  using (exists (select 1 from company c
                  where c.id = company_tag.company_id
                    and c.tenant_id = current_tenant()));

-- company_registry_cache: global read for any authenticated user, writes
-- via service role only (Edge Function) — service_role bypasses RLS and
-- grants entirely, so it needs nothing granted here.
grant select on company_registry_cache to authenticated;

create policy registry_read on company_registry_cache for select
  to authenticated using (true);

-- interaction: read-only for authenticated users. No insert/update/delete
-- grant at all — this, not a policy, is what makes the cooldown
-- unbypassable: there is no privilege path into this table except through
-- log_interaction(), which runs as security definer.
grant select on interaction to authenticated;

create policy interaction_read on interaction for select
  using (tenant_id = current_tenant());

-- cooldown_override: read-only, same reasoning as interaction.
grant select on cooldown_override to authenticated;

create policy override_read on cooldown_override for select
  using (tenant_id = current_tenant());

-- task: any tenant member can read/create; only the assignee or an admin
-- can update (e.g. close it out). No delete grant — tasks are closed, not
-- removed.
grant select, insert, update on task to authenticated;

create policy task_read on task for select
  using (tenant_id = current_tenant());

create policy task_insert on task for insert
  with check (tenant_id = current_tenant());

create policy task_update on task for update
  using (tenant_id = current_tenant()
         and (assigned_user_id = auth.uid() or is_admin()))
  with check (tenant_id = current_tenant());

-- note: editable only by its author.
grant select, insert, update, delete on note to authenticated;

create policy note_read on note for select
  using (tenant_id = current_tenant());

create policy note_insert on note for insert
  with check (tenant_id = current_tenant() and user_id = auth.uid());

create policy note_modify on note for update
  using (tenant_id = current_tenant() and user_id = auth.uid())
  with check (tenant_id = current_tenant() and user_id = auth.uid());

create policy note_delete on note for delete
  using (tenant_id = current_tenant() and user_id = auth.uid());

-- ============================================================================
-- 14. FIRST-LOGIN TENANT ASSIGNMENT
-- Matches the new auth.users row's email domain against tenant.primary_domain
-- and creates the app_user row. No match -> no app_user row -> every RLS
-- policy evaluates false for that person (see Solution Design V1 §3).
--
-- ASSUMPTION, flagged for review: the first person to log in for a given
-- tenant is made admin; everyone after that is a member. Revisit once
-- tenant-provision (Edge Function, Solution Design V1 §6) exists — at that
-- point the platform operator should seed the first admin explicitly
-- instead of relying on this race-prone default.
-- ============================================================================

create function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_domain text;
  v_tenant_id uuid;
  v_existing_count int;
begin
  v_domain := split_part(new.email, '@', 2);

  select id into v_tenant_id from tenant where primary_domain = v_domain;

  if v_tenant_id is null then
    -- No matching tenant. Row is intentionally left uncreated; the
    -- frontend must detect the missing app_user and show a "no access"
    -- screen rather than an empty dashboard.
    return new;
  end if;

  select count(*) into v_existing_count from app_user where tenant_id = v_tenant_id;

  insert into app_user (id, tenant_id, name, email, role, identity_provider, external_id)
  values (
    new.id,
    v_tenant_id,
    new.raw_user_meta_data ->> 'full_name',
    new.email,
    case when v_existing_count = 0 then 'admin' else 'member' end,
    new.raw_app_meta_data ->> 'provider',
    new.raw_user_meta_data ->> 'sub'
  );

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();