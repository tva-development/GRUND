-- setInContactMarker used to be a bare client-side UPDATE (company_update's
-- RLS policy only checks tenant_id, not which column or whose id) -- so two
-- tenant members racing the same "Available" company could silently
-- overwrite each other's marker, or a stale client could set it even after
-- a real cooldown was already committed, which is exactly the "conflict for
-- a company I'm marked in contact with" state that shouldn't be reachable.
-- Same fix as log_interaction/reset_cooldown: enforce exclusivity and derive
-- the actor from auth.uid() at the data layer instead of trusting the
-- client's argument.
create or replace function set_in_contact(p_company_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := current_tenant();
  v_current uuid;
  v_last timestamptz;
begin
  select in_contact_by into v_current
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
  if v_last is not null and now() - v_last < interval '14 days' then
    raise exception 'COOLDOWN_ACTIVE'
      using errcode = 'P0001',
            detail = json_build_object(
              'days_left',
              ceil(extract(epoch from (v_last + interval '14 days' - now())) / 86400)
            )::text;
  end if;

  update company set in_contact_by = auth.uid() where id = p_company_id;
end $$;
