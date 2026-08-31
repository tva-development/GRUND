# Plan for populating the database

A record of the thinking behind bulk-populating `company_registry_cache`
with (in principle) every Swedish company, and why we landed where we
did. Written semantically, not as an implementation spec — see the
"Remaining issues" section for what's still genuinely open.

## The goal

`company_registry_cache` is currently populated lazily — one row per
company, only once some tenant has actually looked that company up.
That works, but it means the table starts empty and only fills in over
time. The question was: can we seed it with the whole Swedish company
register up front, cheaply, without breaking the lazy model that's
already built?

## The two tables, and which one gets bulk-imported

Worth stating plainly, since it's the premise everything else here rests
on: `company` and `company_registry_cache` are not two views of the same
data, they're two different layers.

- **`company`** is the CRM layer — a tenant's own tracked companies.
  Status (prospect/customer/inactive/do_not_contact), the responsible
  user, notes and interactions all hang off this table. A row only
  exists here because a specific tenant deliberately started tracking
  that company — "Add to my companies," or a manual add.
- **`company_registry_cache`** is the shared, global, objective-data
  layer — org number, name, SNI, address. One row per company, full
  stop, independent of how many (if any) tenants have ever added it.

**The bulk import only ever targets `company_registry_cache`.** `company`
is never touched by it, and shouldn't be — a `company` row is a
deliberate CRM action by one tenant, not something a global data seed
should be creating on anyone's behalf.

One thing worth knowing because it changes what "done" looks like:
`company_registry_cache`'s RLS policy is already `to authenticated using
(true)` — no tenant filter. Every tenant can already read the *entire*
cache table today, with no schema change required. What's missing isn't
permission, it's that the Companies page's search
(`searchCompanies()` in `src/lib/companies.js`) only ever queries
`company`, never the cache — so a brand-new tenant's list stays empty no
matter how populated the cache is, until the search/list logic is
changed to also reach into `company_registry_cache` for anything the
tenant hasn't added yet. That's a separate, scoped follow-up from the
bulk import itself — see "Remaining issues."

## What we ruled out

- **A commercial company-data reseller API.** Pricing is per-request
  (tens of thousands of units a month), nowhere near enough to cover
  ~1.2–3 million companies. Its bulk-export endpoint has no visible
  pricing tier, which usually means it's gated behind a separate
  enterprise agreement. It also resells data from Bolagsverket/SCB/FI/PRV
  under its own terms, which raises the "check the incumbent's terms
  before wrapping it" concern already flagged in the product
  Requirements doc.
- **Repopulating weekly via the live single-lookup Bolagsverket API**
  (the same one `company-lookup` already calls). Confirmed: that API
  takes one org number in, returns one company — there's no listing or
  pagination. Driving it 3 million times to reconstruct the whole
  register would take over 10 days at its rate limit, be entirely
  redundant with data we'd already have another way, and risks tripping
  abuse detection on a free API being hit millions of times by one
  client.
- **Brute-forcing org numbers against that same API.** Even with a
  checksum digit narrowing things down, the space of numbers that pass
  the checksum vastly exceeds the number of real companies. Not
  practical at any rate limit.

## What we landed on

Bolagsverket and SCB jointly publish free, no-agreement "värdefulla
datamängder" (high-value datasets) — this is the EU high-value-dataset
mandate for national company registers. Two separate bulk **TXT files**
(one from each agency), each on the order of 3 million lines, with
different columns. There is no smaller delta/changes file — only the
full files, confirmed by checking the Bolagsverket site directly.

**The plan is a one-time seed, not a recurring job:**

1. Download both files.
2. Join them by organisation number (the shared key between the two
   agencies' data) and normalize into the shape `company_registry_cache`
   already expects — the same shape `company-lookup`'s
   `mapOrganisation()` produces from the live API today.
3. Upsert every row, keyed on `org_number` — which is already the
   table's actual primary key, not a generated UUID. There's no
   surrogate ID to worry about reassigning; re-running the same upsert
   any number of times is safe by construction.
4. After that one seed, don't re-run it. Let the table go stale
   naturally and rely on the mechanism described next.

**Why a one-time seed is enough:** `company_registry_cache` isn't
referenced by foreign key from anywhere. A tenant's own `company` table
copies the fields it cares about into its own row (with its own UUID)
the moment someone clicks "Add to my companies" — after that, the two
tables have no relationship beyond happening to share the same
org-number text value. Reseeding the cache, even doing it badly, can
never corrupt a tenant's own data, notes, or interaction history.

**Keeping data from going stale forever:** `company-lookup` already has
a 30-day freshness check (`FRESHNESS_WINDOW_MS`) — when it's asked about
a company, it re-fetches from Bolagsverket live if the cached row is
older than that, otherwise serves the cache as-is. That's exactly the
"refresh on lookup" behavior we want after a one-time seed. The one gap:
right now the *client* doesn't actually route every lookup through that
check — a cache hit is read directly from `company_registry_cache` and
shown as-is, regardless of age. Closing that gap means having the
client look at `last_fetched_at` on the row it already has, and only
calling the edge function (which does the real staleness check and
live refetch) when that row has actually gone stale — not on every
lookup, just the ones where it matters.

**Where this has to run:** whatever does the one-time import needs a
real, internet-reachable Postgres connection — it can't be a GitHub
Action (or any external process) hitting local Docker, since
`127.0.0.1` on a laptop isn't reachable from anywhere else. This is
deferred until a real hosted Supabase project exists to replace the
dead one — see the memory note on this decision.

## Remaining issues

- **Searching a new company by name doesn't work, before or after any
  bulk import.** The lookup flow only falls through to the shared
  registry / live Bolagsverket check when the search text already looks
  like an org number. Search by name, find nothing in your own tenant's
  list, and today the app just says "no companies match" — no fallback.
  This isn't something the bulk import breaks; it's a pre-existing gap
  (already logged separately as a future feature) that bulk-importing
  doesn't fix either, since the bulk files are keyed by org number too.
- **No delta file means no proactive way to catch newly-registered
  companies.** A company registered after the one-time seed only ever
  enters the cache if some tenant happens to look it up by its exact
  org number. There's no cheap weekly "what's new" mechanism the way
  there would be if a delta file existed — we checked, and it doesn't.
- **Unconfirmed: whether any Bolagsverket-family endpoint supports name
  search at all**, as opposed to only exact org-number lookup. Worth
  checking before assuming a name-search feature would need a
  third-party provider.
- **The client-side staleness check described above isn't built yet.**
  The server-side piece (`FRESHNESS_WINDOW_MS` inside `company-lookup`)
  already exists; the client currently bypasses it on every cache hit.
- **Still blocked on infrastructure, not design.** The whole plan is
  ready to execute the moment there's a real cloud Supabase project to
  point the one-time import script at.
- **Bulk-importing the cache alone won't make a new tenant's table
  non-empty.** The Companies page only ever searches `company` (a
  tenant's own tracked list), never `company_registry_cache`. Making
  "every tenant can see and search every company" actually true on
  first login means changing that search/list logic to also reach into
  the cache — a deliberate, scoped piece of work, not a side effect of
  the import. RLS already allows it (`company_registry_cache` is
  readable by any authenticated user, no tenant restriction); only the
  query logic is missing.
- **Even in the fully-specced design, registry-only rows have no
  freshness guarantee.** Solution Design V1 describes a scheduled
  `registry-refresh` function (`pg_cron`, not yet built) that only
  refreshes cache rows "referenced by at least one `company` row" — i.e.
  companies some tenant has actually added. If the whole registry
  becomes browsable, the large majority of it (never added by anyone)
  stays exactly as stale as the day of the bulk import, by design, not
  by oversight.
