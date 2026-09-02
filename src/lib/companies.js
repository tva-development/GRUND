import { supabase } from './supabaseClient'

// Bolagsverket identitetsbeteckning shapes: organisationsnummer (10 digits) or
// personnummer/samordningsnummer (12 digits), hyphens allowed anywhere in the input.
const ORG_NUMBER_PATTERN = /^\d[\d\s-]{8,}$/

// Page size for the "All Companies" browse tab.
export const REGISTRY_PAGE_SIZE = 50

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

// "My Companies" tab — only ever the tenant's own tracked list, optionally
// filtered by name. Never touches the shared registry: that's what "All
// Companies" is for.
export async function listMyCompanies(query) {
  const trimmed = query.trim()
  const base = supabase.from('company').select('*').order('name')
  const { data, error } = await (trimmed ? base.ilike('name', `%${trimmed}%`) : base)
  if (error) throw error
  return data.map(asTenantRow)
}

// "All Companies" tab — a paginated browse of the shared registry cache
// (882 000+ rows), optionally filtered by name or org number. Fetches one
// row past the page size to know whether another page exists, rather than
// running a COUNT(*) over the whole table on every page turn.
//
// Rows the tenant already tracks are still returned (this claims to be
// *all* companies) but flagged via `alreadyAdded` so the UI can show that
// instead of an "Add" button — see markTracked below.
//
// Ordered newest-registered-first rather than alphabetically: plain A-Z put
// digit/symbol-prefixed names ("-1 Group AB", "@ Odero AB") ahead of
// anything recognizable, and newest-first is more useful to browse anyway.
export async function listRegistryCompanies({ page = 0, query = '' } = {}) {
  const trimmed = query.trim()
  const from = page * REGISTRY_PAGE_SIZE
  const to = from + REGISTRY_PAGE_SIZE // one extra row, to detect a next page

  let builder = supabase
    .from('company_registry_cache')
    .select('*')
    .order('registered_at', { ascending: false, nullsFirst: false })
    .range(from, to)
  if (trimmed) {
    builder = looksLikeOrgNumber(trimmed)
      ? builder.eq('org_number', normalizeOrgNumber(trimmed))
      : builder.ilike('name', `%${trimmed}%`)
  }

  const { data, error } = await builder
  if (error) throw error

  const hasMore = data.length > REGISTRY_PAGE_SIZE
  return { rows: data.slice(0, REGISTRY_PAGE_SIZE).map(asRegistryRow), hasMore }
}

// The set of org numbers the tenant already tracks, for flagging registry
// rows as `alreadyAdded` in the "All Companies" tab without joining against
// 882 000+ rows server-side. RLS (company_read) already scopes this to the
// caller's tenant, same as every other unfiltered `company` select here.
export async function listTrackedOrgNumbers() {
  const { data, error } = await supabase.from('company').select('org_number').not('org_number', 'is', null)
  if (error) throw error
  return new Set(data.map((row) => row.org_number))
}

export function markTracked(rows, trackedOrgNumbers) {
  return rows.map((row) => ({ ...row, alreadyAdded: trackedOrgNumbers.has(row.org_number) }))
}

// contact_eligibility only covers tracked rows (it's a view over `company`),
// so registry-only rows never get an eligibility badge. Keyed by company_id
// for O(1) lookup when rendering. last_user_id has no FK PostgREST can embed
// through a view, so the name lookup is a second query, merged here.
export async function listEligibility() {
  const { data, error } = await supabase
    .from('contact_eligibility')
    .select('company_id, available, days_left, last_user_id')
  if (error) throw error

  const userIds = [...new Set(data.map((row) => row.last_user_id).filter(Boolean))]
  const names = {}
  if (userIds.length > 0) {
    const { data: users, error: userError } = await supabase.from('app_user').select('id, name').in('id', userIds)
    if (userError) throw userError
    for (const user of users) names[user.id] = user.name
  }

  return Object.fromEntries(
    data.map((row) => [
      row.company_id,
      { ...row, lastUserName: row.last_user_id ? (names[row.last_user_id] ?? 'a teammate') : null },
    ]),
  )
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
      description: registryRow.business_description,
      city: registryRow.city,
      address: registryRow.address,
      zip: registryRow.zip,
      no_marketing: registryRow.no_marketing,
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
// never match an org-number lookup elsewhere.
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
