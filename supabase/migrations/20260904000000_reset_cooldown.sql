-- "Not in contact anymore" no longer prompts Start/No cooldown -- per PRD
-- V1 (Goals: "enforce the contact-cooldown rule at the data layer, not just
-- as a UI warning"), the easy default must be the safe one. Ending an
-- in_contact_by marker now always commits the cooldown via
-- confirmInContactCooldown(); there's no more client-side "skip it" path.
--
-- That removes the only escape hatch for a genuine mistake (marked the
-- wrong company, fat-fingered it), so this adds a narrow, audited one back:
-- an admin can reset an active cooldown. cooldown_reset_at/_by are plain
-- company columns, not a delete of the interaction row -- `interaction`
-- stays append-only and untouched, same as ever. contact_eligibility
-- treats a reset newer than the last interaction as making the company
-- available again; a later interaction naturally supersedes an old reset
-- (the comparison is always against the *latest* interaction).
alter table company
  add column cooldown_reset_at timestamptz,
  add column cooldown_reset_by uuid references app_user(id);

create or replace view contact_eligibility
with (security_invoker = true) as
select c.id as company_id,
       i.last_at,
       i.last_user_id,
       (
         i.last_at is null
         or now() - i.last_at >= interval '14 days'
         or (c.cooldown_reset_at is not null and c.cooldown_reset_at >= i.last_at)
       ) as available,
       case
         when c.cooldown_reset_at is not null and c.cooldown_reset_at >= i.last_at then 0
         else greatest(0, ceil(extract(epoch from
           (i.last_at + interval '14 days' - now())) / 86400))::int
       end as days_left
from company c
left join lateral (
  select created_at as last_at, user_id as last_user_id
    from interaction where company_id = c.id
   order by created_at desc limit 1
) i on true;

-- Deliberately narrower than the general company_update policy (any tenant
-- member): this specifically undoes the cooldown rule GRUND exists to
-- enforce, so it needs its own admin check rather than riding on RLS that
-- was written for ordinary field edits.
create or replace function reset_cooldown(p_company_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = 'P0001';
  end if;

  update company
     set cooldown_reset_at = now(),
         cooldown_reset_by = auth.uid()
   where id = p_company_id and tenant_id = current_tenant();

  if not found then
    raise exception 'COMPANY_NOT_FOUND' using errcode = 'P0002';
  end if;
end $$;

revoke all on function reset_cooldown from public;
grant execute on function reset_cooldown to authenticated;
