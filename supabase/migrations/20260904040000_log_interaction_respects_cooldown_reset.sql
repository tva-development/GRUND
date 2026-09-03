-- The real bug behind "conflict error for a company I'm shown as in contact
-- with": contact_eligibility already treats a reset applied at or after the
-- last interaction as cancelling the cooldown (cooldown_reset_at >=
-- last_at), but log_interaction()'s own COOLDOWN_ACTIVE check never learned
-- that rule -- it just compared raw interaction age. So a company the badge
-- (and the "Reset cooldown" button, gated on the same view) already call
-- available could still bounce log_interaction() with COOLDOWN_ACTIVE,
-- citing a cooldown the UI had already told the user was cleared.
--
-- Pulling the shared condition into one function that contact_eligibility,
-- log_interaction, and set_in_contact all call is what actually prevents
-- this class of bug recurring -- three copies of the same reset-aware date
-- comparison is exactly how they drifted apart the first time.
create or replace function company_on_cooldown(p_last_interaction_at timestamptz, p_cooldown_reset_at timestamptz)
returns boolean
language sql immutable as $$
  select p_last_interaction_at is not null
     and now() - p_last_interaction_at < interval '14 days'
     and not (p_cooldown_reset_at is not null and p_cooldown_reset_at >= p_last_interaction_at)
$$;

create or replace view contact_eligibility as
select
  c.id as company_id,
  i.last_at,
  i.last_user_id,
  not company_on_cooldown(i.last_at, c.cooldown_reset_at) as available,
  case
    when not company_on_cooldown(i.last_at, c.cooldown_reset_at) then 0
    else greatest(0, ceil(extract(epoch from i.last_at + interval '14 days' - now()) / 86400))::integer
  end as days_left
from company c
left join lateral (
  select created_at as last_at, user_id as last_user_id
    from interaction
   where interaction.company_id = c.id
   order by created_at desc
   limit 1
) i on true;

create or replace function log_interaction(p_company_id uuid, p_type text, p_note text, p_override_reason text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := current_tenant();
  v_last timestamptz;
  v_id uuid;
  v_in_contact_by uuid;
  v_reset_at timestamptz;
begin
  select in_contact_by, cooldown_reset_at into v_in_contact_by, v_reset_at
    from company
   where id = p_company_id and tenant_id = v_tenant
     for update;

  if not found then
    raise exception 'COMPANY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select max(created_at) into v_last
    from interaction where company_id = p_company_id;

  if company_on_cooldown(v_last, v_reset_at) then
    if p_override_reason is null or length(trim(p_override_reason)) = 0 then
      -- A cooldown is genuinely active -- if the caller was still holding
      -- the "in contact" marker, it's stale (the marker only means
      -- something before a cooldown exists), so clear it here instead of
      -- leaving the UI stuck showing "in contact".
      if v_in_contact_by = auth.uid() then
        update company set in_contact_by = null where id = p_company_id;
      end if;
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

create or replace function set_in_contact(p_company_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := current_tenant();
  v_current uuid;
  v_last timestamptz;
  v_reset_at timestamptz;
begin
  select in_contact_by, cooldown_reset_at into v_current, v_reset_at
    from company
   where id = p_company_id and tenant_id = v_tenant
     for update;

  if not found then
    raise exception 'COMPANY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_current is not null and v_current != auth.uid() then
    raise exception 'ALREADY_IN_CONTACT' using errcode = 'P0001';
  end if;

  select max(created_at) into v_last from interaction where company_id = p_company_id;
  if company_on_cooldown(v_last, v_reset_at) then
    raise exception 'COOLDOWN_ACTIVE'
      using errcode = 'P0001',
            detail = json_build_object(
              'days_left',
              ceil(extract(epoch from (v_last + interval '14 days' - now())) / 86400)
            )::text;
  end if;

  update company set in_contact_by = auth.uid() where id = p_company_id;
end $$;
