-- Re-adding a previously-removed company (bookmarked = false) needs to
-- upsert onto the existing row by (tenant_id, org_number) rather than
-- create a duplicate. Postgres's ON CONFLICT can't target a partial index
-- (company_tenant_org_number_key was UNIQUE ... WHERE org_number IS NOT
-- NULL) unless the ON CONFLICT clause repeats that exact predicate, which
-- PostgREST/supabase-js's upsert(onConflict:) has no way to express --
-- confirmed directly: `ON CONFLICT (tenant_id, org_number)` against the
-- partial index fails with "no unique or exclusion constraint matching".
--
-- Switching to a plain UNIQUE constraint doesn't change what's allowed:
-- standard SQL never treats two NULLs as equal, so multiple manual
-- companies with org_number IS NULL are still fine -- confirmed directly,
-- inserting two more NULL rows alongside the existing one didn't conflict.
-- It's a partial unique INDEX, not a table constraint (that's the only way
-- to express the WHERE clause) -- confirmed DROP CONSTRAINT doesn't find it,
-- DROP INDEX does.
drop index company_tenant_org_number_key;
alter table company add constraint company_tenant_org_number_key unique (tenant_id, org_number);
