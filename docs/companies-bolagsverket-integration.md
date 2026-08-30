# Companies + Bolagsverket integration — summary

This covers everything built after the Google/Microsoft auth + tenant routing work
landed. Authoritative product decisions (PRD, data model, solution design) still live in
Notion per `CLAUDE.md` — this file is just a walkthrough of what changed and why, for
catching up on this stretch of work.

## Context

`src/pages/Companies.jsx` was a placeholder ("Not wired up yet"). The goal: a real table
of company data with search, backed by Bolagsverket's **värdefulla datamängder** ("high
value datasets") API — the source the PRD already named for company registry data.

## 1. Verifying the Bolagsverket API (Postman)

Before writing any code, we set up and tested the API directly in Postman using real
credentials, to nail down details that turned out not to be documented in one obvious
place:

- **Auth is OAuth2 client-credentials, not a static key.** Token endpoint is on a
  *different host* than the data API: `portal.api.bolagsverket.se/oauth2/token` for the
  token, `gw.api.bolagsverket.se/vardefulla-datamangder/v1/...` for the actual endpoints.
  Easy to get wrong — we did, initially.
- **No test/sandbox credentials were ever actually issued** to us — only production. All
  testing above ended up against production data (real companies, e.g. Jysk AB, Calluna
  Fastigheter AB).
- **Confirmed endpoints:** `GET /isalive` (health check), `POST /organisationer` (company
  lookup by `identitetsbeteckning` — org number or personnummer, exact match only),
  `POST /dokumentlista` (list a company's filed annual reports), `GET /dokument/{id}`
  (download one report as a zip containing iXBRL).
- **Hard constraint that shapes everything downstream:** this API has no name-search.
  You can only look up a company you already know the exact org number for. There is no
  `/search`, no `/list`, no pagination.
- Pulled the official OpenAPI spec (`swagger.json`) and the PDF connection guide directly
  from Bolagsverket's devportal to get exact request/response shapes, rather than
  guessing from partial docs.

## 2. Database changes

Two migrations, both pure schema (no data) per the convention we adopted mid-project —
see the "Bugs found" section below for why that convention exists.

**`20260830150000_extend_company_registry.sql`**
- Added columns to `company` (per-tenant) and `company_registry_cache` (shared, global,
  read-only-to-tenants) for fields we decided were worth capturing from Bolagsverket's
  response, beyond what already existed:
  - `is_active`, `in_liquidation`, `no_marketing` (reklamspärr — the company has opted
    out of marketing contact; relevant since this product's core function *is* cold
    outreach), `deregistered_at`, `deregistration_reason`, `registered_at`.
- Fixed `company.company_form`'s check constraint — it only allowed
  `AB/KB/EF/none/other`, which would reject most real Swedish companies (`HB`, `EK`,
  `BRF`, `E` all exist and are common).
- Deliberately **left out** as table columns (kept in a raw JSON blob instead, on the
  cache table only): per-field error metadata, data-provenance tags, `registreringsland`
  (always "Sverige" for anything this API returns), and the more granular `juridiskForm`
  classification — all either not user-facing or redundant for this product.

**`20260830160000_grant_service_role_registry_cache.sql`**
- A real bug fix, not a new feature. The original schema's comment claimed
  `service_role` "bypasses RLS and grants entirely, so it needs nothing granted here" —
  false for this project. Without this grant, the Edge Function's cache read/write
  failed with `42501 permission denied`. Found by actually running the function against
  real data, not by inspection.

## 3. Edge Function: `supabase/functions/company-lookup/index.ts`

The only piece of code allowed to hold the Bolagsverket `client_id`/`client_secret`
(stored as Supabase secrets, entered directly in the Supabase Dashboard — never typed
into chat or committed anywhere).

**What it does, in order:**
1. Checks `company_registry_cache` first. If the row is fresh (< 30 days old), returns it
   immediately — **no Bolagsverket call at all.**
2. If missing or stale, gets an OAuth token, calls `/organisationer`, and upserts the
   result into the cache.
3. Maps Bolagsverket's response onto our curated columns, and separately stores the full
   raw response in a `raw jsonb` column for anything we didn't curate but might want
   later.
4. Never touches the tenant's own `company` table — that stays a separate, plain
   PostgREST insert from the frontend once a user chooses to add a company.

**Why this shape:** viewing the table should *never* call Bolagsverket — every render
reads straight from our own Postgres via PostgREST, instant and free. Bolagsverket is
only called from inside this one function, and only on a cache miss/staleness, which is
what makes "one lookup serves every tenant" actually true.

## 4. Frontend: the Companies page

- `src/lib/companies.js` — all data access. Three-tier search:
  1. **Tenant's own `company` rows** (name `ilike`, org number exact match) — this is
     what the table always shows.
  2. **Shared `company_registry_cache`** — if an org-number search misses tier 1, check
     whether *any* tenant has already looked this company up. If so, offer an "Add to my
     companies" action instead of hitting Bolagsverket again.
  3. **Live Bolagsverket lookup** — only if both above miss, and only for org-number
     queries (per the hard constraint above, name queries can never reach this tier).
- `src/components/CompanySearchBar.jsx` — single input, regex-detects whether you typed
  an org number or a name to decide which path to run.
- `src/components/CompanyTable.jsx` — renders Name, Org number, Legal form, Address,
  City, Industry, and a status badge (Active / Inactive / Deregistered / In liquidation),
  plus a "No marketing" tag when `reklamspärr` is set.
- Styling extends `src/index.css` using the app's existing CSS-variable conventions (no
  UI framework in this repo — plain hand-rolled CSS throughout).

## 5. Bugs found while testing for real

Everything above was verified against a real local Supabase instance and, separately,
the real remote project — not just read for correctness. That process surfaced three
pre-existing issues, none of which were caused by this feature but all of which blocked
it:

1. **`company_form` constraint too narrow** (fixed in the migration above).
2. **Missing `service_role` grant on `company_registry_cache`** (fixed in the second
   migration above) — only surfaced once the Edge Function actually tried to write.
3. **A dev-tenant seed row living inside a numbered migration**
   (`20260830040332_add_initial_tenant.sql`), which would insert a fake tenant into
   production if that migration were ever pushed there. **Not fixed yet** — flagged as
   its own follow-up rather than bundled into this diff, since rewriting already-applied
   migration history is a separate decision. Migrations in this repo are schema-only
   from now on; seed/dev data belongs in `supabase/seed.sql`.

## 6. Git history

Committed in three layers on `login-page`, each independently reviewable:
- `50e6e68` — migration (schema + the grant fix)
- `7819dd0` — the Edge Function
- `9248ed5` — the frontend (page, components, data-access lib, styles)

Plus one follow-up (address column added to the table, not yet committed as of this
summary). Pushed to `origin/login-page`; merging into `main` is pending `gh auth login`
being set up locally.

## 7. Verified against real data

Cross-checked our table's "Inactive" badge for a real company (Calluna Fastigheter AB)
against both the raw API response and an independent third-party company-info page — all
three agreed: SCB's own definition of "active" is "registered for VAT and/or F-tax and/or
as an employer," and this company has none of the three, so `Inactive` is technically
correct. Flagged as a possible future UX tweak: "Inactive" can read as "defunct," when it
really just means "no VAT/tax/employer activity" — a legitimately existing, registered
company (e.g. a passive holding company) can be both.

## 8. Open problem: the table only shows companies someone already searched for

Bolagsverket's REST API can't fix this (no search, no list — see the hard constraint
above). Researched three ways to actually solve it:

1. **Paid third-party providers** (Roaring, Bisnode/D&B, Merinfo) — real name-search,
   hosted, no ETL to build, but recurring cost. These are the same three options already
   named in the Requirements doc's "which enrichment provider" open question.
2. **Bulk-import Bolagsverket's + SCB's free weekly bulk files** into
   `company_registry_cache`, so search works against effectively all of Sweden from day
   one, at zero recurring cost. Confirmed both files exist and got real samples of each —
   see the detailed breakdown below.
3. **Curated pre-seed** — proactively run our *existing, already-working* Edge Function
   against a hand-picked list of likely-relevant companies. Zero new infrastructure, but
   doesn't solve the general case.

**Current recommendation:** option 2 (combined bulk-file ETL) is the right long-term
answer — it's free and it's the only one that actually delivers "any company, searchable,
from day one." Option 3 is worth shipping first as a fast, low-risk stopgap while the ETL
pipeline gets built properly. **Not yet implemented** — next step if this direction is
approved is a proper implementation plan for the ingestion pipeline.

### 8a. The two bulk files, in detail: issues and solutions

Two separate files, from two separate agencies, neither complete on its own:

| | Bolagsverket's file | SCB's file |
|---|---|---|
| Format | `;`-delimited, semicolon CSV | `;`-delimited (tab-like spacing in samples) |
| Has | org identity, name, legal form (basic), addresses, deregistration info | active status, detailed legal form, SNI/industry, marketing opt-out |
| Missing | active status, SNI, marketing opt-out | richer address/name history |

**Issue: the two files must be joined, and their org-number formats don't match.**
Bolagsverket packs it as `<org_number>$ORGNR-IDORG`; SCB's `PeOrgNr` prefixes legal
entities with `16` before the 10-digit org number (individuals get `19`/`20` instead,
matching personnummer). *Solution:* normalize both down to the bare 10-digit org number
before joining — strip Bolagsverket's `$...` suffix, strip SCB's leading `16`.

**Issue: Bolagsverket's file packs multiple values into one column.** Fields like
`organisationsidentitet`, `organisationsnamn`, and `postadress` are actually 2–5 sub-values
joined with `$` (e.g. `postadress` = `street$co-address$city$zip$country`). *Solution:* a
small parser per column that splits on `$` and maps positionally — straightforward once
known, but not discoverable from the header row alone (we had to decode it from a real
sample row).

**Issue: neither file gives human-readable labels — only raw codes.** No `klartext`
anywhere, unlike the REST API. We verified some of these against SCB's own
"Variabelbeskrivning API" PDF, but not all:
- ✅ **Confirmed, full code table:** `JurForm` (2-digit legal form — and it's the *same*
  code space as the REST API's `juridiskForm`, e.g. `49` = "Övriga aktiebolag" in both).
- ✅ **Confirmed:** `FtgStat` (`0` = never active, `1` = active, `9` = not active — SCB's
  official definition: registered for VAT and/or F-tax and/or as an employer).
- ⚠️ **Partially confirmed:** `Reklamsparrtyp` — general meaning is solid (`1x` = accepts
  marketing, `2x` = opted out), but the documented codes are 2-digit (`11`–`23`) while our
  sample row showed a bare `1`. Needs one more real sample with a differing value to
  confirm the exact mapping before relying on it.
- ❌ **Unconfirmed:** `JEStat` and `ForAndrTyp` (Bolagsverket's own file) — not found in
  the SCB documentation we pulled. Likely a legal-entity-status flag and a
  change/delta-type flag respectively, but this is a guess, not a verified fact.
- ❌ **Bolagsverket's own codes** (e.g. `S-ORGFO` for organisationsform, `VERKUPP-AVORG`
  for a deregistration reason) still need their own equivalent reference document —
  haven't located Bolagsverket's version of SCB's variable-description PDF yet.
- *Solution:* build a small static code→label lookup module in code using what's
  confirmed now, show raw codes (not blank, not guessed labels) for anything unconfirmed,
  and keep researching Bolagsverket's own code documentation before this ships.

**Issue: the real legal-form vocabulary is much bigger than our schema assumes.** SCB's
`JurForm` table has ~30 codes (stiftelser, dödsbon, statliga enheter, utländska juridiska
personer, etc.), far beyond the `AB/HB/KB/EK/BRF/E` we built for. *Solution:* drop the
check constraint entirely on `company_registry_cache.company_form` (store whatever raw
code comes in) — keep a constraint only on the tenant's own curated `company` table,
where a small finite list actually makes sense.

**Issue: scale.** Reportedly ~3 million rows combined. Too large for a single Supabase
Edge Function invocation (execution-time limits, not built for multi-GB streaming ETL).
*Solution:* run ingestion as a scheduled job outside Supabase — most naturally a GitHub
Action — using streaming parsing and batched `COPY`/upserts, not row-by-row inserts.

**Issue: unclear whether each weekly file is a full snapshot or a delta.** SCB's
`m`-prefixed columns (`mFtgStat`, `mJurForm`, etc.) look like "did this field change"
flags, hinting at delta support, but we haven't confirmed this. *Solution:* default to
treating each week's file as a full snapshot and re-upserting everything — simpler and
more robust than betting on unconfirmed delta semantics, even if more bandwidth-heavy.

**Issue: name search won't perform at millions-of-rows scale with a plain `ILIKE`.**
*Solution:* add a `pg_trgm` GIN index on `company_registry_cache.name` before relying on
this for real search volume.

## What's not done yet

- The bulk-import ETL pipeline (research done, not built).
- Moving the dev-tenant seed out of migration history into `supabase/seed.sql`.
- GitHub Actions for automated `db push`/`functions deploy` on merge (discussed,
  deliberately deferred).
- Revenue/financial data — explicitly out of scope per PRD V1 (would need a paid
  financial feed; Bolagsverket only exposes it per-company inside annual-report
  zip/iXBRL files, not as structured data).
