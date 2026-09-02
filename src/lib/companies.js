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

// "My Companies" tab — only ever the tenant's own *bookmarked* companies,
// optionally filtered by name. Never touches the shared registry: that's
// what "All Companies" is for. bookmarked = false doesn't mean gone — see
// removeCompany — so this must filter for it explicitly, same as
// listTrackedOrgNumbers below.
export async function listMyCompanies(query) {
  const trimmed = query.trim()
  const base = supabase.from('company').select('*').eq('bookmarked', true).order('name')
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
//
// A name search goes through search_registry_cache_by_name() rather than a
// plain .ilike().order().range() chain -- confirmed live and reproduced
// directly against Postgres: combining an arbitrary ILIKE with ORDER BY on
// an unrelated (indexed) column makes the planner gamble on scanning that
// column's index and checking the ILIKE per row, hoping to hit enough
// matches quickly. For a rare, unevenly-dated term ("saab") that gamble can
// mean scanning most of the table before finding any match -- the search
// box's actual timeout. The function forces the filter through the trigram
// index first (see its migration for the full plan comparison); an exact
// org-number match or the no-filter browse each already go straight
// through their own index with nothing to fight it, so neither needs this.
export async function listRegistryCompanies({ page = 0, query = '' } = {}) {
  const trimmed = query.trim()
  const from = page * REGISTRY_PAGE_SIZE
  const to = from + REGISTRY_PAGE_SIZE // one extra row, to detect a next page

  let data, error

  if (trimmed && !looksLikeOrgNumber(trimmed)) {
    ;({ data, error } = await supabase.rpc('search_registry_cache_by_name', {
      p_pattern: `%${trimmed}%`,
      p_limit: REGISTRY_PAGE_SIZE + 1,
      p_offset: from,
    }))
  } else {
    let builder = supabase
      .from('company_registry_cache')
      .select('*')
      .order('registered_at', { ascending: false, nullsFirst: false })
      .range(from, to)
    if (trimmed) builder = builder.eq('org_number', normalizeOrgNumber(trimmed))
    ;({ data, error } = await builder)
  }

  if (error) throw error

  const hasMore = data.length > REGISTRY_PAGE_SIZE
  return { rows: data.slice(0, REGISTRY_PAGE_SIZE).map(asRegistryRow), hasMore }
}

// The set of org numbers the tenant already has *bookmarked*, for flagging
// registry rows as `alreadyAdded` in the "All Companies" tab without joining
// against 882 000+ rows server-side. Filtered to bookmarked = true so a
// removed company shows as addable again rather than stuck "✓ Added" —
// re-adding it re-bookmarks the same row, see addCompanyFromRegistry.
export async function listTrackedOrgNumbers() {
  const { data, error } = await supabase
    .from('company')
    .select('org_number')
    .eq('bookmarked', true)
    .not('org_number', 'is', null)
  if (error) throw error
  return new Set(data.map((row) => row.org_number))
}

export function markTracked(rows, trackedOrgNumbers) {
  return rows.map((row) => ({ ...row, alreadyAdded: trackedOrgNumbers.has(row.org_number) }))
}

// last_user_id / in_contact_by have no FK PostgREST can embed through (one's
// on a view, both point at app_user which callers query separately anyway),
// so name resolution is always a deliberate second query, not automatic.
export async function resolveUserNames(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return {}
  const { data, error } = await supabase.from('app_user').select('id, name').in('id', ids)
  if (error) throw error
  return Object.fromEntries(data.map((user) => [user.id, user.name]))
}

// contact_eligibility only covers tracked rows (it's a view over `company`),
// so registry-only rows never get an eligibility badge. Keyed by company_id
// for O(1) lookup when rendering.
export async function listEligibility() {
  const { data, error } = await supabase
    .from('contact_eligibility')
    .select('company_id, available, days_left, last_user_id')
  if (error) throw error

  const names = await resolveUserNames(data.map((row) => row.last_user_id))
  return Object.fromEntries(
    data.map((row) => [
      row.company_id,
      { ...row, lastUserName: row.last_user_id ? (names[row.last_user_id] ?? 'a teammate') : null },
    ]),
  )
}

// "In contact" is a two-step, reversible action, not a direct log — clicking
// it immediately used to call log_interaction(), which starts the 14-day
// cooldown right away with no way back (interaction is append-only, no
// delete/update path). in_contact_by is a plain company column instead:
// freely settable/clearable on company's normal update grant, with no
// cooldown implication until it's explicitly confirmed.

// Step 1: mark. Doesn't touch `interaction` at all.
export async function setInContactMarker(companyId, userId) {
  const { error } = await supabase.from('company').update({ in_contact_by: userId }).eq('id', companyId)
  if (error) throw error
}

// Step 2a: un-mark without starting a cooldown -- it was set by mistake, or
// the outreach never actually happened.
export async function clearInContactMarker(companyId) {
  const { error } = await supabase.from('company').update({ in_contact_by: null }).eq('id', companyId)
  if (error) throw error
}

// Step 2b: un-mark AND commit the cooldown via log_interaction() -- the only
// write path into `interaction`. On failure (COOLDOWN_ACTIVE, e.g. someone
// else logged a fresher contact in the meantime) the marker is left alone
// so the caller's "I was in contact" state isn't silently lost.
export async function confirmInContactCooldown(companyId) {
  const { error } = await supabase.rpc('log_interaction', {
    p_company_id: companyId,
    p_type: 'other',
    p_note: null,
  })
  if (error) throw error
  await clearInContactMarker(companyId)
}

// Companies the current viewer is in contact with, marker or committed
// cooldown alike — union of in_contact_by = them (not yet confirmed) and
// contact_eligibility rows they made the last (committed) contact on.
// Backs the Overview page's "who am I in contact with" list.
export async function listMyInContactCompanies(currentUserId) {
  const [markedResult, eligibilityResult] = await Promise.all([
    supabase.from('company').select('*').eq('in_contact_by', currentUserId),
    supabase.from('contact_eligibility').select('company_id, days_left').eq('available', false).eq('last_user_id', currentUserId),
  ])
  if (markedResult.error) throw markedResult.error
  if (eligibilityResult.error) throw eligibilityResult.error

  const markedIds = new Set(markedResult.data.map((company) => company.id))
  const daysLeftByCompany = Object.fromEntries(eligibilityResult.data.map((row) => [row.company_id, row.days_left]))
  const committedIds = eligibilityResult.data.map((row) => row.company_id).filter((id) => !markedIds.has(id))

  let committedCompanies = []
  if (committedIds.length > 0) {
    const { data, error } = await supabase.from('company').select('*').in('id', committedIds)
    if (error) throw error
    committedCompanies = data
  }

  const rows = [
    ...markedResult.data.map((company) => ({ ...asTenantRow(company), uncommitted: true, daysLeft: null })),
    ...committedCompanies.map((company) => ({
      ...asTenantRow(company),
      uncommitted: false,
      daysLeft: daysLeftByCompany[company.id],
    })),
  ]
  return rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'sv'))
}

// Free-form, tenant-defined labels — separate from the no_marketing/
// eligibility badges, which are computed, not user-assigned. tag/company_tag
// only ever apply to tracked rows: company_tag references company(id), not
// company_registry_cache.
export async function listTags() {
  const { data, error } = await supabase.from('tag').select('*').order('name')
  if (error) throw error
  return data
}

export async function listCompanyTags(companyIds) {
  if (companyIds.length === 0) return {}
  const { data, error } = await supabase.from('company_tag').select('company_id, tag_id').in('company_id', companyIds)
  if (error) throw error
  const byCompany = {}
  for (const row of data) {
    ;(byCompany[row.company_id] ??= []).push(row.tag_id)
  }
  return byCompany
}

// Reuses an existing tag with this exact name (tag_tenant_id_name_key is
// unique) rather than creating a near-duplicate. 23505 on the final attach
// means someone already tagged this company with it between the lookup and
// here — fine, that's the end state we wanted anyway.
export async function addTagToCompany(tenantId, companyId, name) {
  const trimmed = name.trim()
  if (!trimmed) return

  let tag
  const { data: existing, error: findError } = await supabase
    .from('tag')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', trimmed)
    .maybeSingle()
  if (findError) throw findError
  tag = existing

  if (!tag) {
    const { data: created, error: createError } = await supabase
      .from('tag')
      .insert({ tenant_id: tenantId, name: trimmed })
      .select('id')
      .single()
    if (createError) throw createError
    tag = created
  }

  const { error: attachError } = await supabase.from('company_tag').insert({ company_id: companyId, tag_id: tag.id })
  if (attachError && attachError.code !== '23505') throw attachError
}

export async function removeTagFromCompany(companyId, tagId) {
  const { error } = await supabase.from('company_tag').delete().eq('company_id', companyId).eq('tag_id', tagId)
  if (error) throw error
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
// company list — no secrets, no Edge Function. is_manual is explicitly
// false: this row mirrors Bolagsverket data, so its company-info fields are
// read-only in the UI (see CompanyTable/CompanyForm).
//
// Upserts on (tenant_id, org_number) rather than a plain insert: if this
// org number was tracked before and removed (bookmarked = false, row still
// there — see removeCompany), re-adding re-bookmarks and re-syncs that same
// row instead of colliding with the unique constraint or leaving a second,
// stale copy behind.
export async function addCompanyFromRegistry(tenantId, registryRow) {
  const { data, error } = await supabase
    .from('company')
    .upsert(
      {
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
        bookmarked: true,
      },
      { onConflict: 'tenant_id,org_number' },
    )
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
//
// Upserts for the same reason as addCompanyFromRegistry: a hand-typed org
// number matching a previously-removed row re-bookmarks it instead of
// hitting the unique constraint. Rows with no org number never conflict —
// NULL is never "equal" to NULL under a unique constraint — so this is a
// plain insert in the common case (PRD use case 9 is mostly org-number-less
// entities to begin with).
export async function addManualCompany(tenantId, fields) {
  const { data, error } = await supabase
    .from('company')
    .upsert(
      { ...manualCompanyFields(fields), tenant_id: tenantId, is_manual: true, bookmarked: true },
      { onConflict: 'tenant_id,org_number' },
    )
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

// "Removes" a company from the tenant's bookmark list — clears `bookmarked`
// rather than deleting the row. "My Companies" is an optional bookmark view;
// Overview is the durable record of who's in contact / on cooldown with a
// company, and that has to survive a removal here, along with its tags,
// notes and tasks. A real DELETE would cascade all of that away (see
// 20260903040000) the moment the row disappeared — so this never deletes.
//
// Same caveat as updateCompany: company_update's RLS only checks
// tenant_id, not role, so this is reachable by any tenant member at the API
// level — the UI's admin-only gate is what actually protects it.
export async function removeCompany(companyId) {
  const { data, error } = await supabase.from('company').update({ bookmarked: false }).eq('id', companyId).select()

  if (error) throw error
  return data
}
