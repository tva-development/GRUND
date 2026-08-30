import { supabase } from './supabaseClient'

// Bolagsverket identitetsbeteckning shapes: organisationsnummer (10 digits) or
// personnummer/samordningsnummer (12 digits), hyphens allowed anywhere in the input.
const ORG_NUMBER_PATTERN = /^\d[\d\s-]{8,}$/

export function looksLikeOrgNumber(query) {
  return ORG_NUMBER_PATTERN.test(query.trim())
}

function normalizeOrgNumber(query) {
  return query.replace(/[\s-]/g, '')
}

// Tier 1 — the tenant's own company list. Always what the table renders.
export async function searchCompanies(query) {
  const trimmed = query.trim()

  if (!trimmed) {
    const { data, error } = await supabase.from('company').select('*').order('name')
    if (error) throw error
    return data
  }

  if (looksLikeOrgNumber(trimmed)) {
    const { data, error } = await supabase
      .from('company')
      .select('*')
      .eq('org_number', normalizeOrgNumber(trimmed))
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('company')
    .select('*')
    .ilike('name', `%${trimmed}%`)
    .order('name')
  if (error) throw error
  return data
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
export async function addCompanyFromRegistry(tenantId, registryRow) {
  const { data, error } = await supabase
    .from('company')
    .insert({
      tenant_id: tenantId,
      org_number: registryRow.org_number,
      name: registryRow.name,
      company_form: registryRow.company_form ?? 'none',
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
    })
    .select()
    .single()

  if (error) throw error
  return data
}
