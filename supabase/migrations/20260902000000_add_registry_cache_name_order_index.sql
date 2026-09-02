-- The "All Companies" browse tab pages through company_registry_cache
-- ordered by name (ORDER BY name LIMIT/OFFSET). The trigram GIN index from
-- 20260901130000 accelerates `ilike '%text%'` but doesn't help a plain
-- ORDER BY -- without a btree here, every page turn sorts all 882 000+ rows.
create index if not exists company_registry_cache_name_idx
  on company_registry_cache (name);
