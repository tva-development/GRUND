-- ============================================================================
-- Namnsökning mot company_registry_cache.
--
-- Companies-vyn söker numera både i tenantens egen `company`-tabell och i den
-- delade registercachen, så en `ilike '%text%'` går mot 882 000+ rader vid
-- varje tangenttryckning. Utan index blir det en parallell seq scan:
--
--   Parallel Seq Scan ... Rows Removed by Filter: 283653
--   Buffers: shared hit=14754 read=150932
--   Execution Time: 313 ms
--
-- En btree hjälper inte — ett ledande jokertecken kan den inte använda.
-- pg_trgm indexerar trigram och klarar därför `%mitt-i-strängen%`, vilket är
-- precis det sökrutan gör.
--
-- Integrationsdokumentet flaggade det här som ett krav innan namnsökning körs
-- mot miljontals rader (docs/companies-bolagsverket-integration.md, 8a).
--
-- Indexet byggs efter bulkimporten med flit — att bygga det före hade gjort
-- varje inläst rad dyrare.
-- ============================================================================

create extension if not exists pg_trgm;

create index if not exists company_registry_cache_name_trgm
  on company_registry_cache using gin (name gin_trgm_ops);
