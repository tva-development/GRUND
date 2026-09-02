-- ============================================================================
-- Flyttar en inläst staging_registry in i company_registry_cache.
--
-- Körs EFTER att CSV:n lästs in i staging_registry (se README.md i samma
-- mapp). Anledningen till att det går via en staging-tabell och inte rakt
-- in i måltabellen:
--
--   1. Allt i staging är text, så en enda trasig datumsträng stoppar inte
--      en inläsning på hundratusentals rader. Typkonverteringen sker här,
--      där den går att felsöka.
--   2. COPY kan inte göra upsert. En ominläsning måste kunna köras om utan
--      att duplicera eller skriva över färsk data.
--
-- Skriptet är idempotent — kör det hur många gånger som helst.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== Innan =='
select
  (select count(*) from staging_registry)         as staging_rader,
  (select count(*) from company_registry_cache)   as cache_rader_innan;

-- ---------------------------------------------------------------------------
-- Upsert.
--
-- `distinct on` är ren försäkring: build_registry_cache_csv.py garanterar
-- redan ett org-nummer per rad, men Postgres vägrar röra samma rad två
-- gånger i ett och samma on-conflict-anrop, så en dubblett skulle spräcka
-- hela satsen i stället för bara sin egen rad.
--
-- Where-villkoret längst ned är det viktiga: en rad skrivs bara över om den
-- redan är en bulkrad. last_fetched_at = 1970-sentinelen är signaturen för
-- "kommer från bulkfilen, aldrig hämtad live". Har company-lookup hämtat
-- bolaget på riktigt sedan dess har raden ett äkta tidsstämpel och lämnas
-- ifred — annars skulle en ominläsning slänga färsk data till förmån för
-- flera månader gammal bulk.
-- ---------------------------------------------------------------------------
insert into company_registry_cache (
  org_number, name, company_form, sni_code, industry_label,
  business_description, address, city, zip, no_marketing, registered_at,
  last_fetched_at, raw
)
select distinct on (org_number)
  org_number,
  nullif(name, ''),
  nullif(company_form, ''),
  nullif(sni_code, ''),
  nullif(industry_label, ''),
  nullif(business_description, ''),
  nullif(address, ''),
  nullif(city, ''),
  nullif(zip, ''),
  -- Vaktade konverteringar. Bolagsverkets fil innehåller enstaka rader med
  -- oescapade citattecken; csv-parsern tappar då ett fältgränssnitt och hela
  -- raden förskjuts, så en verksamhetsbeskrivning kan stå i datumkolumnen.
  -- Utan vakten avbryter en (1) sådan rad hela insert-satsen och alla
  -- 880 000 bra rader rullas tillbaka. Med den blir fältet NULL och resten
  -- av raden går in. Hittas de i efterhand med frågan längst ned.
  case when no_marketing in ('true', 'false') then no_marketing::boolean end,
  case when registered_at ~ '^\d{4}-\d{2}-\d{2}$' then registered_at::date end,
  case when last_fetched_at ~ '^\d{4}-\d{2}-\d{2}' then last_fetched_at::timestamptz end,
  -- raw kommer från json.dumps och är alltid giltig JSON, så den behöver
  -- ingen vakt. is_active/in_liquidation/deregistered_at/deregistration_reason
  -- har ingen egen kolumn längre (20260901000000_retire_status_columns.sql)
  -- men ligger kvar här inne, oförlorade.
  nullif(raw, '')::jsonb
from staging_registry
where org_number is not null and org_number <> ''
order by org_number
on conflict (org_number) do update set
  name                  = excluded.name,
  company_form          = excluded.company_form,
  sni_code              = excluded.sni_code,
  industry_label        = excluded.industry_label,
  business_description  = excluded.business_description,
  address               = excluded.address,
  city                  = excluded.city,
  zip                   = excluded.zip,
  no_marketing          = excluded.no_marketing,
  registered_at         = excluded.registered_at,
  last_fetched_at       = excluded.last_fetched_at,
  raw                   = excluded.raw
where company_registry_cache.last_fetched_at = '1970-01-01T00:00:00Z';

\echo '== Efter =='
select
  count(*)                                                   as cache_rader,
  count(*) filter (where last_fetched_at > '1970-01-02')     as live_hamtade,
  count(*) filter (where sni_code is not null)               as med_sni,
  count(*) filter (where industry_label is not null)         as med_bransch,
  count(*) filter (where business_description is not null)   as med_beskrivning,
  count(*) filter (where no_marketing)                       as reklamsparr
from company_registry_cache;

\echo '== Stickprov =='
select org_number, name, company_form, sni_code, industry_label, city
from company_registry_cache
where last_fetched_at = '1970-01-01T00:00:00Z'
order by random()
limit 5;

\echo '== Källrader med förskjutna fält (tomt = allt rent) =='
select org_number, left(name, 38) as name, left(registered_at, 40) as registered_at
from staging_registry
where registered_at <> '' and registered_at !~ '^\d{4}-\d{2}-\d{2}$'
limit 10;

-- Staging behövs inte längre. Den är unlogged, så den försvinner ändå vid
-- en krasch — men den ligger på ett par hundra MB, så städa direkt.
drop table if exists staging_registry;

\echo 'Klart. staging_registry borttagen.'
