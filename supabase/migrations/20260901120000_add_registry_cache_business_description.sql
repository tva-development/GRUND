-- ============================================================================
-- company_registry_cache saknade en plats för Bolagsverkets
-- verksamhetsbeskrivning — fritexten företaget självt skriver om sin
-- verksamhet ("Secondhand försäljning av överskottsmaterial."). Den finns i
-- bulkfilen för i princip varje bolag och är det enda fältet som beskriver
-- vad företaget faktiskt gör med egna ord; sni_code/industry_label är en
-- officiell klassificering, inte en beskrivning.
--
-- `company` har redan motsvarande `description` sedan
-- 20260830150000_extend_company_registry.sql — den här raden ger cachen
-- samma möjlighet, så en bulkimportad rad kan visas utan att man gräver i
-- raw-bloben.
--
-- Utan den här kolumnen misslyckas bulkimporten: build_registry_cache_csv.py
-- skriver business_description och COPY avvisar okända kolumner.
-- ============================================================================

alter table company_registry_cache
  add column business_description text;
