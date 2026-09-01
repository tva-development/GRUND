import { supabase } from './supabaseClient'

// Bolagsverket identitetsbeteckning shapes: organisationsnummer (10 digits) or
// personnummer/samordningsnummer (12 digits), hyphens allowed anywhere in the input.
const ORG_NUMBER_PATTERN = /^\d[\d\s-]{8,}$/

// How many registry rows a single search may return. "bygg" alone matches
// 31 294 of the 882 000 cached companies, so this is a display cap as much as
// a performance one — nobody scrolls past the first screen of a term that
// broad, they refine it instead.
export const REGISTRY_RESULT_LIMIT = 50

// Below this, a name search matches so much of the register that the result is
// noise rather than an answer. Org-number searches are exempt — those are
// exact and always worth running.
const MIN_REGISTRY_QUERY_LENGTH = 2

// `company.company_form` has a check constraint listing eight values, while the
// registry carries 25 distinct Bolagsverket codes (FL, KHF, OFB, BAB …) across
// ~3 000 companies. Promoting one of those verbatim would fail the constraint,
// so anything outside the tenant vocabulary lands as 'other'. The real code
// stays visible in the registry row it came from.
const TENANT_COMPANY_FORMS = new Set(['AB', 'HB', 'KB', 'EK', 'BRF', 'E', 'none', 'other'])

function tenantCompanyForm(form) {
  if (!form) return 'none'
  return TENANT_COMPANY_FORMS.has(form) ? form : 'other'
}

export function looksLikeOrgNumber(query) {
  return ORG_NUMBER_PATTERN.test(query.trim())
}

function normalizeOrgNumber(query) {
  return query.replace(/[\s-]/g, '')
}

// The table renders tenant rows and registry rows side by side, but only the
// former have a uuid. `rowKey` gives every row something stable to key and
// select on; `tracked` is what the UI branches on to decide whether a row
// offers Remove/Edit or "Add to my companies".
function asTenantRow(row) {
  return { ...row, tracked: true, rowKey: `company:${row.id}` }
}

function asRegistryRow(row) {
  return { ...row, tracked: false, rowKey: `registry:${row.org_number}` }
}

function byName(a, b) {
  return (a.name ?? '').localeCompare(b.name ?? '', 'sv')
}

// Tier 1 + tier 2 in one pass — the tenant's own list, plus the shared registry
// cache for everything they haven't added.
//
// An empty box shows only the tenant's own companies. Listing the register
// itself would mean paging through 882 000 rows, which is a browser, not a CRM
// list; the register becomes reachable the moment you actually search for
// something.
//
// Tenant rows always come first and are never capped — your own companies
// shouldn't fall off the end because a common word matched half of Sweden.
export async function searchCompanies(query) {
  const trimmed = query.trim()

  if (!trimmed) {
    const { data, error } = await supabase.from('company').select('*').order('name')
    if (error) throw error
    return data.map(asTenantRow)
  }

  const isOrgNumber = looksLikeOrgNumber(trimmed)
  const normalized = normalizeOrgNumber(trimmed)

  const tenantQuery = isOrgNumber
    ? supabase.from('company').select('*').eq('org_number', normalized)
    : supabase.from('company').select('*').ilike('name', `%${trimmed}%`).order('name')

  // Deliberately unordered. `order('name')` forces Postgres to fetch and sort
  // every match before applying the limit — 335 ms for a broad term — while
  // the unordered form stops at the first 50 the trigram index yields, in 3–11
  // ms. The page sorts those 50 itself, which costs nothing.
  const searchesRegistry = isOrgNumber || trimmed.length >= MIN_REGISTRY_QUERY_LENGTH
  const registryQuery = !searchesRegistry
    ? null
    : isOrgNumber
      ? supabase.from('company_registry_cache').select('*').eq('org_number', normalized)
      : supabase
          .from('company_registry_cache')
          .select('*')
          .ilike('name', `%${trimmed}%`)
          .limit(REGISTRY_RESULT_LIMIT)

  const [tenantResult, registryResult] = await Promise.all([tenantQuery, registryQuery])

  if (tenantResult.error) throw tenantResult.error
  if (registryResult?.error) throw registryResult.error

  const tenantRows = tenantResult.data.map(asTenantRow)

  // A company the tenant already tracks must not appear twice — their own row
  // is the one with status and actions on it, so it wins.
  const tracked = new Set(tenantRows.map((row) => row.org_number).filter(Boolean))
  const registryRows = (registryResult?.data ?? [])
    .filter((row) => !tracked.has(row.org_number))
    .map(asRegistryRow)
    .sort(byName)

  return [...tenantRows, ...registryRows]
}

// Tier 2 — the shared, read-only registry cache. Anyone's prior lookup.
export async function findInRegistryCache(orgNumber) {
  const { data, error } = await supabase
    .from('company_registry_cache')
    .select('*')
    .eq('org_number', normalizeOrgNumber(orgNumber))
    .maybeSingle()
  if (error) throw error
  return data
}

// Tier 3 — live Bolagsverket lookup via the company-lookup Edge Function.
// Throws with `err.message` set to one of the function's typed error codes
// (INVALID_ORG_NUMBER / NOT_FOUND / LOOKUP_FAILED) when the lookup fails.
export async function lookupCompanyOnBolagsverket(orgNumber) {
  const { data, error } = await supabase.functions.invoke('company-lookup', {
    body: { org_number: normalizeOrgNumber(orgNumber) },
  })

  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data.data
}

// Promotes a registry_cache row (tier 2 or 3 result) into this tenant's own
// company list. Plain tenant-scoped insert — no secrets, no Edge Function.
// is_manual is explicitly false: this row mirrors Bolagsverket data, so its
// company-info fields are read-only in the UI (see CompanyTable/CompanyForm).
export async function addCompanyFromRegistry(tenantId, registryRow) {
  const { data, error } = await supabase
    .from('company')
    .insert({
      tenant_id: tenantId,
      org_number: registryRow.org_number,
      name: registryRow.name,
      company_form: tenantCompanyForm(registryRow.company_form),
      sni_code: registryRow.sni_code,
      industry_label: registryRow.industry_label,
      city: registryRow.city,
      address: registryRow.address,
      zip: registryRow.zip,
      is_active: registryRow.is_active,
      in_liquidation: registryRow.in_liquidation ?? false,
      no_marketing: registryRow.no_marketing,
      deregistered_at: registryRow.deregistered_at,
      deregistration_reason: registryRow.deregistration_reason,
      registered_at: registryRow.registered_at,
      is_manual: false,
    })
    .select()
    .single()

  if (error) throw error
  return asTenantRow(data)
}

// Shared field mapping for manual add/edit. org_number is normalized the
// same way every other write path is (findInRegistryCache,
// lookupCompanyOnBolagsverket) — otherwise a hand-typed "556677-8899" would
// never match searchCompanies' normalized exact-match lookup later.
function manualCompanyFields(fields) {
  return {
    name: fields.name,
    org_number: fields.org_number ? normalizeOrgNumber(fields.org_number) : null,
    company_form: fields.company_form || 'none',
    address: fields.address || null,
    city: fields.city || null,
    zip: fields.zip || null,
    industry_label: fields.industry_label || null,
  }
}

// PRD use case 9: foreign companies, subsidiaries without their own org
// number, non-AB/KB/EF entities — or simply a company someone wants to add
// by hand rather than through the org-number search flow. is_manual: true
// is what makes this row editable later (see updateCompany).
export async function addManualCompany(tenantId, fields) {
  const { data, error } = await supabase
    .from('company')
    .insert({ ...manualCompanyFields(fields), tenant_id: tenantId, is_manual: true })
    .select()
    .single()

  if (error) throw error
  return asTenantRow(data)
}

// Edits a manually-added company's info. The UI only ever calls this for
// rows where is_manual is true — registry-sourced companies mirror
// Bolagsverket data and aren't meant to be hand-edited (they'd just silently
// diverge from the source of truth). RLS itself doesn't enforce that
// distinction (company_update allows any tenant member to update any of
// their tenant's rows), so the UI gate is what actually protects this.
export async function updateCompany(companyId, fields) {
  const { data, error } = await supabase
    .from('company')
    .update(manualCompanyFields(fields))
    .eq('id', companyId)
    .select()
    .single()

  if (error) throw error
  return asTenantRow(data)
}

// Removes a company from the tenant's own list. Only ever affects the
// tenant's `company` row — the shared registry_cache is never touched, so
// this can't remove Bolagsverket's underlying data for other tenants.
// RLS restricts this to admins; a non-admin call returns an empty array
// (not an error), which callers should treat as "not permitted."
export async function removeCompany(companyId) {
  const { data, error } = await supabase.from('company').delete().eq('id', companyId).select()

  if (error) throw error
  return data
}
