# Bulkimport av företagsregistret

Fyller `company_registry_cache` med i princip hela svenska företagsregistret
från Bolagsverkets och SCB:s gratis bulkfiler ("värdefulla datamängder"), i
stället för att vänta på att tabellen fylls en rad i taget när någon råkar
slå upp ett bolag.

Bakgrunden och de avfärdade alternativen finns i
[`docs/plan-for-populating-the-database.md`](../../docs/plan-for-populating-the-database.md).

## Två världar

Det här är den vanligaste källan till förvirring, så det är värt att ha klart
för sig innan du börjar. Kommandona nedan körs i **två olika program**:

| | PowerShell | psql |
|---|---|---|
| Prompt | `PS C:\Users\lukas\projects\grund>` | `postgres=#` |
| Förstår | `cd`, `python`, `psql`, `$variabler` | SQL och `\`-kommandon: `\copy`, `\i`, `\q` |
| Startas | terminalfönstret | `psql $DB` |
| Avslutas | — | `\q` |

`\copy` finns **bara** i psql. Skriver du det i PowerShell får du
`Missing argument in parameter list` — PowerShell letar efter ett program som
heter `\copy`.

Åt andra hållet: PowerShells variabler (`$DB`, `$CSV`) finns **bara** i
PowerShell. Inne i en psql-session måste sökvägar skrivas ut i klartext.

Varje steg nedan är märkt med vilken av dem det gäller.

## Filerna här

| Fil | Vad den gör |
|---|---|
| `build_registry_cache_csv.py` | Slår ihop de två bulkfilerna till en CSV |
| `registry_import.sql` | Flyttar den inlästa staging-tabellen in i cachen |
| `sni_2025_koder.csv` | SNI-kod → officiell branschetikett |

Skriptet skiljer på två mappar:

```
DATA_DIR    = mappen du skickar in som argument  -> bulkfilerna + resultatet
SCRIPT_DIR  = där skriptet självt ligger         -> sni_2025_koder.csv
```

SNI-listan läses alltså alltid från repot och ska inte kopieras till
datamappen. Bulkfilerna och den genererade CSV:n är gitignorerade — 1,2 GB in
och ett par hundra MB ut.

---

## Engångsuppsättning

### psql på PATH · PowerShell

Lägg till `C:\Program Files\PostgreSQL\18\bin` under Miljövariabler → Path.

**Öppna ett nytt terminalfönster efteråt.** Ett fönster som redan var öppet
har kvar den gamla miljön och hittar fortfarande inte `psql`. Vill du slippa
starta om just det fönstret:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
```

### Migrationen · PowerShell

Kolumnen `business_description` tillkom i
`20260901120000_add_registry_cache_business_description.sql`. Utan den
avvisas importen.

```powershell
npx supabase migration up
```

`npx` behövs för att supabase-CLI:t varken är en devDependency i
`package.json` eller installerat globalt. Vill man slippa det går det att
pinna med `npm i -D supabase`.

---

## Steg 1 · Hämta filerna

Ladda ner båda från Bolagsverkets sida för värdefulla datamängder, packa upp
dem i samma mapp, och döp dem till exakt:

```
bolagsverket_bulkfil.txt
scb_bulkfil.txt
```

Namnen måste stämma — annars ändrar du de två raderna högst upp i skriptet.
Det finns ingen delta-/ändringsfil, bara hela filerna varje gång.

## Steg 2 · Bygg CSV:n · PowerShell

Stå i repo-roten:

```powershell
python src/resources/build_registry_cache_csv.py C:/Users/lukas/Downloads/script
```

Argumentet är mappen där bulkfilerna ligger; CSV:n hamnar i samma mapp. Tar
några minuter. Kontrollera raden med `unika org-nummer` och hur många som
filtrerades bort innan du går vidare.

## Steg 3 · Läs in · psql

Starta en session **från repo-roten** (det spelar roll — `\i` i steg 4 är
relativ till var du startade):

```powershell
psql $DB
```

…eller utan variabel:

```powershell
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Prompten byts till `postgres=#`. Nu är du i psql. Klistra in:

```sql
create unlogged table staging_registry (org_number text, name text, company_form text, sni_code text, industry_label text, business_description text, address text, city text, zip text, is_active text, in_liquidation text, no_marketing text, deregistered_at text, deregistration_reason text, registered_at text, last_fetched_at text, raw text);
```

Sedan inläsningen. **En rad** — `\copy` avslutas av radbrytningen, så den får
inte brytas. Sökvägen skrivs ut i klartext, eftersom `$CSV` inte betyder
något här inne:

```
\copy staging_registry from 'C:/Users/lukas/Downloads/script/company_registry_cache_import.csv' with (format csv, header, encoding 'UTF8')
```

Använd snedstreck framåt. Det tar en stund — 681 MB och 881 696 rader.
Kvittot är `COPY 881696`.

Allt är `text` med flit: då stoppar inte en enda trasig datumsträng en
inläsning på hundratusentals rader.

## Steg 4 · Flytta in i cachen · psql

Fortfarande i samma session:

```
\i src/resources/registry_import.sql
```

Den typkonverterar, gör upsert på `org_number`, skriver ut en sammanfattning
och ett stickprov, och städar bort staging-tabellen. Den går att köra om.

Klart — ur psql med:

```
\q
```

---

## Alternativ: allt från PowerShell

Samma sak, utan att gå in i psql. `-c` betyder "kör det här och avsluta", så
det är stegen ovan hopvikta. Praktiskt i skript; här expanderar PowerShell
`$CSV` innan psql ser strängen, så sökvägen bara står på ett ställe.

```powershell
$DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
$CSV = "C:/Users/lukas/Downloads/script/company_registry_cache_import.csv"
```

```powershell
psql $DB -v ON_ERROR_STOP=1 -c "create unlogged table staging_registry (org_number text, name text, company_form text, sni_code text, industry_label text, business_description text, address text, city text, zip text, is_active text, in_liquidation text, no_marketing text, deregistered_at text, deregistration_reason text, registered_at text, last_fetched_at text, raw text);" -c "\copy staging_registry from '$CSV' with (format csv, header, encoding 'UTF8')"
```

```powershell
psql $DB -v ON_ERROR_STOP=1 -f src/resources/registry_import.sql
```

---

## Varför staging och inte rakt in i cachen

`COPY` kan bara sätta in nytt, inte uppdatera. Din cache innehåller redan
rader som `company-lookup` hämtat live — finns samma org-nummer i CSV:n
kraschar en rak `\copy` på en duplikatnyckel och **tar hela inläsningen med
sig**, alla 881 696 rader.

Staging-tabellen löser tre saker på en gång:

| | |
|---|---|
| **Upsert** | `insert … on conflict` kan köras om hur många gånger som helst |
| **Typfel dödar inte allt** | allt är text i staging; konverteringen sker där felen går att felsöka |
| **Färsk data skyddas** | upserten rör bara rader med `last_fetched_at = 1970` |

Den sista är den viktiga: har `company-lookup` hämtat ett bolag live sedan
importen har raden ett äkta tidsstämpel och lämnas ifred. Annars hade en
ominläsning bytt färsk data mot bulk från filens ålder.

## Om 1970-datumet

`last_fetched_at` sätts med flit till `1970-01-01` på varje bulkrad. Med
kolumndefaulten `now()` skulle varje importerat bolag räknas som färskt av
edge-funktionens `FRESHNESS_WINDOW_MS` och inte få en live-hämtning på 30
dagar. Bakåtdateringen gör att första riktiga uppslaget på ett bolag går live
och skriver över bulkraden med aktuell data.

Konsekvensen är värd att känna till: `company-lookup` returnerar aldrig en
bulkrad, eftersom den bara serverar cachen när raden är färsk. Nyttan med
importen ligger i att läsa tabellen direkt — sökning och listning i
Companies-vyn — vilket inte är byggt än (se "Remaining issues" i planen).

## Filtreringen

Bulkfilen är ett historiskt register, inte en lista över företag som finns.
Skriptet filtrerar därför bort rader som aldrig kan bli kunder:

```
Inget filter                       2 861 310
utan avregistrerade                1 127 337
utan avregistrerade + ej verksamma   881 696     (2,06 GB -> 681 MB)
```

Ingenting av värde försvinner: 99,5 % av de icke-avregistrerade bolagen
matchar en SCB-rad, så de bortfiltrerade är i praktiken exakt de som saknar
`sni_code`, `is_active` och `no_marketing` helt.

Vill du ha med allt, sätt `SKIP_DEREGISTERED` och `SKIP_NOT_ACTIVE` till
`False` överst i skriptet. Åt andra hållet finns 4 366 rader under
likvidation eller fusion (`in_liquidation = true`, en del sedan tidigt
90-tal) — de filtreras inte bort idag, men går att sålla på i SQL efteråt.

## Om filerna — mätt, inte antaget

Sådant som är lätt att gissa fel på och som kostar en hel ominläsning:

- **SCB:s fil är TAB-separerad och LATIN-1.** Läser man den som UTF-8 blir
  varje Å/Ä/Ö ett ersättningstecken — 600 762 av dem bara i de första 50 MB.
- **SCB:s fil måste läsas med `QUOTE_NONE`.** Den har ingen
  citeringskonvention, men csv-modulen antar `"` som standard, och 702 rader
  innehåller ett citattecken i fritext. Med standardinställningen sväljer
  parsern radbrytningar och slår ihop 431 rader med grannraden, tyst.
- **Bolagsverkets fil är `;`-separerad, citerad och äkta UTF-8** (noll
  ogiltiga sekvenser i hela filen på 984 MB). De två filerna har alltså både
  olika teckenkodning och olika citeringsregler.
- **SCB:s `Foretagsnamn` är tomt i 87,9 % av raderna.** Namnet ligger i `Namn`.
- **`Reklamsparrtyp` är ensiffrig** — `1` (99,7 %) och `2` (0,3 %) — trots att
  SCB:s variabelbeskrivning listar tvåsiffriga koder 11–23.
- **Bolagsverket stavar `pagandeAvvecklings…`** utan andra `e`, till skillnad
  från API:et som skriver `pagaende…`. Skriptet följer filen.
- **Bolagsverkets `postadress` är `gata$c/o$ort$postnr$land`.** C/o-ledet
  hamnar i `raw.co_adress`, inte inklistrat i gatuadressen.
- **SNI-listans etiketter saknar kommatecken.** Inget av de 834 namnen har
  ett, fast originaltexten har det (`Odling av spannmål (utom ris), baljväxter
  och oljeväxter`). Någon har gjort filen CSV-säker genom att stryka dem i
  stället för att citera fälten. Påverkar inte matchningen, bara läsbarheten.

Skriptet kontrollerar båda headers vid start och avbryter med besked om en
kolumn bytt namn, i stället för att köra klart med en tyst NULL-kolumn.

## Nästa steg som inte ingår här

- **`pg_trgm`-index på `company_registry_cache.name`** innan namnsökning körs
  mot hundratusentals rader. Skapa det *efter* en bulkinläsning — det går
  betydligt fortare så.
- **Companies-vyn söker bara i `company`**, aldrig i cachen, så en ny tenants
  lista är tom oavsett hur full cachen är. RLS tillåter redan läsningen; det
  är frågelogiken som saknas.
