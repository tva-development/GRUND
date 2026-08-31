-- ============================================================================
-- Fix: signup rolled back for every non-Google identity.
--
-- app_user.identity_provider is constrained to ('google','microsoft'), but
-- handle_new_auth_user() inserted new.raw_app_meta_data ->> 'provider' raw.
-- GoTrue emits the provider *slug* there — 'google', 'azure', or 'email' —
-- and never 'microsoft'. So a Microsoft or email/password signup violated the
-- CHECK, the AFTER INSERT trigger raised, and the whole auth.users insert
-- rolled back with an opaque error.
--
-- Translate the slug into our own vocabulary instead of widening the CHECK:
--   'google' -> 'google'
--   'azure'  -> 'microsoft'   (the name used in tenant.allowed_identity_providers,
--                              app_user's CHECK, and the product copy)
--   anything else (e.g. 'email' for local password signups) -> NULL
--
-- The column is nullable and a CHECK passes on NULL, so non-OAuth signups
-- succeed while leaving no provider recorded — which is accurate, since
-- email/password is not an identity provider. This keeps local email/password
-- dev working without admitting 'email' into the vocabulary.
--
-- Only the function body changes; the trigger binding is left alone.
-- ============================================================================

create or replace function handle_new_auth_user() returns trigger
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
    case new.raw_app_meta_data ->> 'provider'
      when 'google' then 'google'
      when 'azure'  then 'microsoft'
      else null
    end,
    new.raw_user_meta_data ->> 'sub'
  );

  return new;
end $$;
