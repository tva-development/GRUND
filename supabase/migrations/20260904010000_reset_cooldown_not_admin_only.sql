-- Reset cooldown turned out not to need the admin restriction -- any tenant
-- member should be able to correct a mistaken cooldown, same as they can
-- already mark/unmark "in contact" themselves. Tenant isolation is still
-- enforced by the function's own `tenant_id = current_tenant()` check, and
-- cooldown_reset_by still records who did it regardless of role.
create or replace function reset_cooldown(p_company_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update company
     set cooldown_reset_at = now(),
         cooldown_reset_by = auth.uid()
   where id = p_company_id and tenant_id = current_tenant();

  if not found then
    raise exception 'COMPANY_NOT_FOUND' using errcode = 'P0002';
  end if;
end $$;
