-- company_registry_cache's is_active/in_liquidation/deregistered_at/
-- deregistration_reason turned out redundant with the raw jsonb blob and
-- were dropped in favor of business_description (verksamhetsbeskrivning).
-- Codifies a change already applied by hand locally, so `db reset` stops
-- reverting it.
alter table company_registry_cache
  drop column if exists is_active,
  drop column if exists in_liquidation,
  drop column if exists deregistered_at,
  drop column if exists deregistration_reason,
  add column if not exists business_description text;
