-- The "All Companies" tab now defaults to newest-founded-first instead of
-- alphabetical (plain A-Z surfaced digit/symbol-prefixed names like "-1
-- Group AB" or "@ Odero AB" ahead of anything recognizable). Only 97 of
-- 1.1M+ rows have a null registered_at, so NULLS LAST barely matters in
-- practice, but the index must match the query's ordering exactly
-- (DESC NULLS LAST) or Postgres can't use it to avoid a full sort.
create index if not exists company_registry_cache_registered_at_idx
  on company_registry_cache (registered_at desc nulls last);
