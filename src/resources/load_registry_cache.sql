-- Loads the CSV produced by build_registry_cache_csv.py straight into
-- company_registry_cache. Its column list now matches OUTPUT_COLUMNS
-- exactly, so no staging table is needed.
--
-- Run only against a freshly-reset (empty) database: \copy has no
-- ON CONFLICT, so it aborts the whole load on the first org_number that's
-- already present (e.g. from a live Bolagsverket lookup).
--
-- Usage:
--   npx supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f src/resources/load_registry_cache.sql

\copy company_registry_cache (org_number, name, company_form, sni_code, industry_label, business_description, address, city, zip, no_marketing, registered_at, last_fetched_at, raw) from '<PATH_TO_CSV>' with (format csv, header, quote '"', escape '"', encoding 'UTF8');
