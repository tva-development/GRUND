-- Clicking "In contact" used to call log_interaction() immediately, which
-- starts the 14-day cooldown right away and can't be undone -- `interaction`
-- is append-only by design (see row 150), with no delete/update path.
--
-- in_contact_by is a separate, freely-settable/clearable marker: "someone
-- has clicked In contact but hasn't confirmed the cooldown yet." It rides on
-- company's existing broad update grant (company_update), unlike
-- `interaction`. Turning it off asks whether to actually commit the
-- cooldown via log_interaction() -- this column is never itself the source
-- of truth for cooldown state, contact_eligibility still is.
alter table company
  add column in_contact_by uuid references app_user(id);

create index company_in_contact_by_idx on company (in_contact_by);
