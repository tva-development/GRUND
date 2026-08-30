-- ============================================================================
-- Fix: company_registry_cache never granted service_role any privileges.
--
-- The original migration's comment claimed "service_role bypasses RLS and
-- grants entirely, so it needs nothing granted here" — incorrect for this
-- project. The same migration notes elsewhere that Supabase no longer
-- auto-grants table access to any role, but that fix wasn't applied to
-- service_role here. The company-lookup Edge Function (service-role client)
-- fails with 42501 permission denied on both its cache-check select and its
-- upsert without this.
-- ============================================================================

grant select, insert, update on company_registry_cache to service_role;
