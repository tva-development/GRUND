-- company.is_active/in_liquidation/deregistered_at/deregistration_reason
-- mirror what already happened to company_registry_cache in
-- 20260901000000_retire_status_columns.sql, for the same reason: nothing
-- populates them anymore. addCompanyFromRegistry stopped setting them once
-- the registry cache lost the source columns, no manual-entry field ever
-- set them (see CompanyForm.jsx), and the frontend's own status display
-- (registryStatus() in CompanyTable.jsx) was removed as dead weight going
-- forward. Whatever source data existed on already-tracked rows is genuinely
-- gone -- there's no live path left that could recompute it.
alter table company
  drop column if exists is_active,
  drop column if exists in_liquidation,
  drop column if exists deregistered_at,
  drop column if exists deregistration_reason;
