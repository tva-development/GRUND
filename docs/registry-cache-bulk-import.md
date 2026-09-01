# Bulk-importing `company_registry_cache` — maintenance guide

A step-by-step runbook for (re)seeding `company_registry_cache` from
Bolagsverket's and SCB's bulk data files. For the reasoning behind why this
exists and how it fits the lazy-cache model, see
[plan-for-populating-the-database.md](plan-for-populating-the-database.md).
This is a **one-time seed**, not something run on a schedule — staleness
after the seed is handled by `company-lookup`'s existing 30-day
live-refresh-on-lookup logic.

The tooling lives in [`src/resources/`](../src/resources/):

- `build_registry_cache_csv.py` — joins the two source files into one CSV.
- `sni_2025_koder.csv` — SCB's SNI 2025 code list, used to derive
  `industry_label` from `sni_code`.
- `load_registry_cache.sql` — the `\copy` that loads the generated CSV into
  the database.

## 1. Get the source files

Download both from Bolagsverket's and SCB's free "värdefulla datamängder"
bulk exports (see the plan doc for why these two, and why not an API). You
need:

- Bolagsverket's bulk file (semicolon-delimited) — save as
  `src/resources/bolagsverket_bulkfil.txt`.
- SCB's bulk file (tab-delimited) — save as
  `src/resources/scb_bulkfil.txt`.

Both are on the order of 3 million rows. Neither should be committed to the
repo — they're large, regenerable, and not something a git diff can
meaningfully show.

## 2. Run the build script

```bash
cd src/resources
python build_registry_cache_csv.py
```

This reads the two source files and writes
`src/resources/company_registry_cache_import_2.csv`, shaped to match
`company_registry_cache`'s columns exactly. It prints match/coverage stats
as it runs — worth a glance, since a near-zero SCB match count usually means
`PeOrgNr` normalization broke (see the comment on `normalize_pe_org_nr` in
the script) rather than that the data is actually mostly unmatched.

Don't commit the generated CSV either, for the same reason as the source
files.

## 3. Make sure the schema is current

The load in step 4 expects `company_registry_cache`'s current shape (no
`is_active`/`in_liquidation`/`deregistered_at`/`deregistration_reason`,
with `business_description`). Apply pending migrations first:

```bash
npx supabase db reset
```

`db reset` rebuilds the local database from every migration file in order —
this is also what guarantees the table is empty before the load in the next
step, which matters because of how that load works.

## 4. Load the CSV

Open [`src/resources/load_registry_cache.sql`](../src/resources/load_registry_cache.sql)
and replace `<PATH_TO_CSV>` with the absolute path to the CSV from step 2
(forward slashes, even on Windows — e.g.
`C:/Users/you/GRUND/src/resources/company_registry_cache_import_2.csv`).
Then run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f src/resources/load_registry_cache.sql
```

**This only works against a freshly-reset, empty table.** The load is a
plain `\copy`, which has no `ON CONFLICT` handling — if
`company_registry_cache` already has any rows (e.g. from live lookups made
while testing the app locally), the load aborts entirely on the first
`org_number` collision. If that happens, `npx supabase db reset` and load
again, rather than re-running against the populated table.

## 5. Verify

```sql
select count(*) from company_registry_cache;
select org_number, name, industry_label, business_description
from company_registry_cache limit 5;
```

Row count should be close to the "Wrote N rows" figure the script printed
in step 2 (Bolagsverket's unique org-number count, after dedup).

## Troubleshooting

- **Low SCB match rate** — check `normalize_pe_org_nr` in the script.
  Joining on the raw `PeOrgNr` value fails silently (zero matches, no
  error) if the `16` org-number prefix isn't stripped correctly.
- **`no_marketing` looks inverted** — `Reklamsparrtyp` reads the opposite
  way round to how it's named (`2` means opted out); see the comment above
  `NO_MARKETING_REKLAMSPARR_CODES` in the script before changing this.
- **`\copy` fails partway through with a duplicate key error** — the table
  wasn't empty. See step 4.
- **`industry_label` is empty for every row** — `sni_2025_koder.csv` wasn't
  found at `src/resources/sni_2025_koder.csv`, or `sni_code` genuinely
  wasn't populated for the row (SCB only assigns a code to entities meeting
  its "verksam" criteria — a missing SNI code is common for non-trading
  entities like stiftelser and ideella föreningar, not necessarily a bug).
