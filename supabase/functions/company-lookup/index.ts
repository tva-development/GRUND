// company-lookup — the only piece of this feature allowed to talk to
// Bolagsverket (holds the client_id/client_secret). Reads company_registry_cache
// first and only calls Bolagsverket on a miss or a stale row; the tenant's own
// `company` table is never touched here (see plan "Edge Function" section).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// See plan "Caching & refresh strategy" — proposed default, not a hard constraint.
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// organisationsnummer (10 digits) or personnummer/samordningsnummer (12 digits).
const ORG_NUMBER_PATTERN = /^\d{10}$|^\d{12}$/

const TOKEN_URL = 'https://portal.api.bolagsverket.se/oauth2/token'
const ORGANISATIONER_URL = 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1/organisationer'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function getBolagsverketToken(): Promise<string> {
  const clientId = Deno.env.get('BOLAGSVERKET_CLIENT_ID')
  const clientSecret = Deno.env.get('BOLAGSVERKET_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('BOLAGSVERKET_CLIENT_ID / BOLAGSVERKET_CLIENT_SECRET not configured')
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'vardefulla-datamangder:read vardefulla-datamangder:ping',
    }),
  })

  if (!response.ok) {
    throw new Error(`Bolagsverket token request failed: ${response.status}`)
  }

  const data = await response.json()
  return data.access_token
}

// Maps the subset of Bolagsverket's Organisation schema this CRM cares about
// onto our columns. See plan "Column decision" for what's kept vs dropped and why.
function mapOrganisation(orgNumber: string, org: Record<string, any>) {
  const namePreferringCompanyName =
    org.organisationsnamn?.organisationsnamnLista?.find(
      (entry: any) => entry.organisationsnamntyp?.kod === 'FORETAGSNAMN',
    ) ?? org.organisationsnamn?.organisationsnamnLista?.[0]

  const janejToBoolean = (kod: string | undefined) =>
    kod === 'JA' ? true : kod === 'NEJ' ? false : null

  // is_active/in_liquidation/deregistered_at/deregistration_reason used to be
  // mapped here too, but company_registry_cache dropped those columns (see
  // 20260901000000_retire_status_columns.sql) — nothing is lost, though:
  // `raw: org` below already carries the untouched API response they came
  // from (verksamOrganisation, pagaendeAvveckling..., avregistrerad...).
  return {
    org_number: orgNumber,
    name: namePreferringCompanyName?.namn ?? null,
    company_form: org.organisationsform?.kod ?? null,
    sni_code: org.naringsgrenOrganisation?.sni?.[0]?.kod ?? null,
    industry_label: org.naringsgrenOrganisation?.sni?.[0]?.klartext ?? null,
    city: org.postadressOrganisation?.postadress?.postort ?? null,
    address: org.postadressOrganisation?.postadress?.utdelningsadress ?? null,
    zip: org.postadressOrganisation?.postadress?.postnummer ?? null,
    no_marketing: janejToBoolean(org.reklamsparr?.kod),
    registered_at: org.organisationsdatum?.registreringsdatum ?? null,
    raw: org,
    last_fetched_at: new Date().toISOString(),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { org_number: rawOrgNumber } = await req.json()
    const orgNumber = String(rawOrgNumber ?? '').replace(/[\s-]/g, '')

    if (!ORG_NUMBER_PATTERN.test(orgNumber)) {
      return jsonResponse({ error: 'INVALID_ORG_NUMBER' }, 400)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: cached } = await supabase
      .from('company_registry_cache')
      .select('*')
      .eq('org_number', orgNumber)
      .maybeSingle()

    const isFresh =
      cached && Date.now() - new Date(cached.last_fetched_at).getTime() < FRESHNESS_WINDOW_MS

    if (isFresh) {
      return jsonResponse({ data: cached })
    }

    const token = await getBolagsverketToken()

    const lookupResponse = await fetch(ORGANISATIONER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ identitetsbeteckning: orgNumber }),
    })

    if (lookupResponse.status === 400) {
      return jsonResponse({ error: 'INVALID_ORG_NUMBER' }, 400)
    }
    if (!lookupResponse.ok) {
      return jsonResponse({ error: 'LOOKUP_FAILED' }, 502)
    }

    const body = await lookupResponse.json()
    const org = body.organisationer?.[0]

    // A genuinely unknown org number comes back with no resolved identity at
    // all, rather than an empty organisationer array — per-field producer
    // errors (e.g. SCB has nothing for this org) still return a populated
    // organisationsidentitet and are handled by mapOrganisation's optional
    // chaining, not treated as not-found.
    if (!org || !org.organisationsidentitet) {
      return jsonResponse({ error: 'NOT_FOUND' }, 404)
    }

    const mapped = mapOrganisation(orgNumber, org)

    const { data: upserted, error } = await supabase
      .from('company_registry_cache')
      .upsert(mapped, { onConflict: 'org_number' })
      .select()
      .single()

    if (error) {
      throw error
    }

    return jsonResponse({ data: upserted })
  } catch (err) {
    console.error(err)
    return jsonResponse({ error: 'LOOKUP_FAILED' }, 500)
  }
})
