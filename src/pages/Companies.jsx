import { useEffect, useState } from 'react'

import CompanyForm from '../components/CompanyForm'
import CompanyList from '../components/CompanyList'
import CompanySearchBar from '../components/CompanySearchBar'
import { useAuth } from '../context/AuthContext'
import {
  addCompanyFromRegistry,
  addManualCompany,
  addTagToCompany,
  confirmInContactCooldown,
  formatOrgNumber,
  listCompanyTags,
  listEligibility,
  listMyCompanies,
  listRegistryCompanies,
  listTags,
  listTrackedOrgNumbers,
  looksLikeOrgNumber,
  lookupCompanyOnBolagsverket,
  markTracked,
  removeCompany,
  removeTagFromCompany,
  resetCooldown,
  resolveUserNames,
  setInContactMarker,
  updateCompany,
} from '../lib/companies'

// A committed cooldown (a real log_interaction() row) always wins over the
// company.in_contact_by marker, not the other way around. The marker is
// only meaningful before a cooldown exists — set_in_contact() and
// log_interaction() both refuse to let it coexist with an active cooldown
// going forward — but it's a plain nullable column, not append-only history,
// so leftover/inconsistent data (or anything that writes it directly) can
// still leave it stuck set after a cooldown is already running. Trusting the
// interaction history over the marker means a stale marker degrades to
// showing the true cooldown state instead of a stuck lie, and it stops
// hiding the "Reset cooldown" button (gated on kind === 'cooldown') behind
// a marker nobody can otherwise clear from the UI.
//
// 'in-contact' (red) means the marker, with no active cooldown behind it —
// the only state that's still reversible, which is what "Not in contact
// anymore" keys off. Once a cooldown actually commits, self or teammate
// alike show as 'cooldown' (amber) — nothing left to undo at that point.
function eligibilityBadge(company, eligibility, currentUserId, inContactNames) {
  if (eligibility && !eligibility.available) {
    const isSelf = eligibility.last_user_id === currentUserId
    return { kind: 'cooldown', daysLeft: eligibility.days_left, contactedBy: isSelf ? null : eligibility.lastUserName }
  }
  if (company.in_contact_by) {
    return company.in_contact_by === currentUserId
      ? { kind: 'in-contact' }
      : { kind: 'contacting', contactedBy: inContactNames[company.in_contact_by] ?? 'a teammate' }
  }
  if (!eligibility) return null
  return { kind: 'available' }
}

const LOOKUP_ERROR_MESSAGES = {
  INVALID_ORG_NUMBER: "That doesn't look like a valid Swedish org number.",
  NOT_FOUND: 'Bolagsverket has no record of that org number.',
  LOOKUP_FAILED: 'The lookup failed — try again in a moment.',
}

const DEBOUNCE_MS = 300

function Companies() {
  const { appUser } = useAuth()
  const isAdmin = appUser?.role === 'admin'

  // Which of the two tables is visible. Switching tabs never throws away the
  // other tab's state — both keep their own query/page, so flipping back and
  // forth doesn't re-fetch or reset a search someone was in the middle of.
  // Defaults to "all": the shared registry is the primary discovery
  // surface, "My Companies" a personal bookmark list layered on top of it.
  const [activeTab, setActiveTab] = useState('all')

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingCompany, setEditingCompany] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)

  // Inline, per-row error (e.g. "Not in contact anymore" losing the race to
  // someone else's fresher cooldown) — shown in the card itself instead of
  // window.alert, same reasoning as InlineConfirm replacing window.confirm.
  const [actionError, setActionError] = useState(null)
  function dismissActionError() {
    setActionError(null)
  }

  // Org numbers the tenant already tracks — lets "All Companies" flag a row
  // as already added without re-fetching that whole page after every add.
  const [trackedOrgNumbers, setTrackedOrgNumbers] = useState(new Set())

  useEffect(() => {
    let active = true
    listTrackedOrgNumbers()
      .then((set) => active && setTrackedOrgNumbers(set))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [reloadToken])

  // Cooldown/contact-history badge data, keyed by company_id. Only ever
  // relevant to "My Companies" — contact_eligibility has no rows for
  // companies nobody's tracking yet.
  const [eligibilityByCompany, setEligibilityByCompany] = useState({})

  useEffect(() => {
    let active = true
    listEligibility()
      .then((byCompany) => active && setEligibilityByCompany(byCompany))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [reloadToken])

  // ---------------------------------------------------------------------
  // "My Companies" — the tenant's own tracked list.
  // ---------------------------------------------------------------------
  const [myQuery, setMyQuery] = useState('')
  const [myCompanies, setMyCompanies] = useState([])
  // Names for teammates' in_contact_by markers ("Being contacted by ___").
  // Kept separate from listEligibility's own name resolution since
  // in_contact_by lives on `company`, not contact_eligibility.
  const [inContactNames, setInContactNames] = useState({})

  useEffect(() => {
    let active = true
    const ids = myCompanies.map((company) => company.in_contact_by)
    resolveUserNames(ids)
      .then((names) => active && setInContactNames(names))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [myCompanies])

  // The tenant's full tag vocabulary (for reuse/autocomplete) and which tags
  // sit on which of the currently-loaded companies.
  const [allTags, setAllTags] = useState([])
  const [companyTagIds, setCompanyTagIds] = useState({})

  useEffect(() => {
    let active = true
    listTags()
      .then((tags) => active && setAllTags(tags))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [reloadToken])

  useEffect(() => {
    let active = true
    listCompanyTags(myCompanies.map((company) => company.id))
      .then((byCompany) => active && setCompanyTagIds(byCompany))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [myCompanies])

  const [myLoading, setMyLoading] = useState(true)
  const [myError, setMyError] = useState(null)
  // Whether CompanyList has ever had real data to show. Kept separate from
  // myLoading so a reload() — fired by In contact / Not in contact anymore,
  // among others — refetches without unmounting CompanyList: unmounting
  // resets its internal expand/confirm state, snapping an open card shut out
  // from under whoever just clicked something in it.
  const [myHasLoadedOnce, setMyHasLoadedOnce] = useState(false)

  useEffect(() => {
    let active = true
    const timeout = setTimeout(async () => {
      setMyLoading(true)
      try {
        const results = await listMyCompanies(myQuery)
        if (!active) return
        setMyCompanies(results)
        setMyError(null)
        setMyHasLoadedOnce(true)
      } catch (err) {
        if (!active) return
        setMyError(err.message ?? 'Search failed')
        setMyCompanies([])
      } finally {
        if (active) setMyLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [myQuery, reloadToken])

  // ---------------------------------------------------------------------
  // "All Companies" — a paginated browse of the shared registry cache.
  // ---------------------------------------------------------------------
  const [allQuery, setAllQuery] = useState('')
  const [allPage, setAllPage] = useState(0)
  const [allRows, setAllRows] = useState([])
  const [allHasMore, setAllHasMore] = useState(false)
  const [allLoading, setAllLoading] = useState(true)
  const [allError, setAllError] = useState(null)
  // See myHasLoadedOnce above — same reasoning: reload() (add/edit/remove all
  // call it) must not unmount CompanyList once it has real data, or the card
  // someone has open gets slammed shut mid-action.
  const [allHasLoadedOnce, setAllHasLoadedOnce] = useState(false)

  // A query edit always jumps back to page 0 — paging through stale results
  // from the previous search would be confusing.
  function handleAllQueryChange(value) {
    setAllQuery(value)
    setAllPage(0)
  }

  // 'idle' | 'not-in-registry' | 'looking-up' | 'found-in-registry' | 'error'
  const [lookupState, setLookupState] = useState('idle')
  const [registryHit, setRegistryHit] = useState(null)
  const [lookupError, setLookupError] = useState(null)

  useEffect(() => {
    let active = true
    const timeout = setTimeout(async () => {
      setAllLoading(true)
      try {
        const { rows, hasMore } = await listRegistryCompanies({ page: allPage, query: allQuery })
        if (!active) return
        setAllRows(rows)
        setAllHasMore(hasMore)
        setAllError(null)
        setAllHasLoadedOnce(true)

        const trimmed = allQuery.trim()
        setRegistryHit(null)
        setLookupState(trimmed && looksLikeOrgNumber(trimmed) && rows.length === 0 ? 'not-in-registry' : 'idle')
      } catch (err) {
        if (!active) return
        setAllError(err.message ?? 'Search failed')
        setAllRows([])
      } finally {
        if (active) setAllLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [allQuery, allPage, reloadToken])

  async function handleLookup() {
    setLookupState('looking-up')
    setLookupError(null)
    try {
      const row = await lookupCompanyOnBolagsverket(allQuery.trim())
      setRegistryHit(row)
      setLookupState('found-in-registry')
    } catch (err) {
      setLookupError(LOOKUP_ERROR_MESSAGES[err.message] ?? LOOKUP_ERROR_MESSAGES.LOOKUP_FAILED)
      setLookupState('error')
    }
  }

  // Adding or removing changes which org numbers count as tracked. Re-running
  // both tabs' fetches (and the tracked-set fetch) is what keeps that in one
  // place instead of splicing rows by hand and getting a row that shows as
  // both tracked and untracked.
  function reload() {
    setReloadToken((current) => current + 1)
  }

  function switchTab(tab) {
    setActiveTab(tab)
    setShowAddForm(false)
    setEditingCompany(null)
  }

  async function handleAdd(registryRow) {
    try {
      await addCompanyFromRegistry(appUser.tenant_id, registryRow)
      setRegistryHit(null)
      setLookupState('idle')
      reload()
    } catch (err) {
      window.alert(`Could not add company: ${err.message}`)
    }
  }

  async function handleAddManual(fields) {
    try {
      await addManualCompany(appUser.tenant_id, fields)
      setShowAddForm(false)
      reload()
    } catch (err) {
      window.alert(`Could not add company: ${err.message}`)
    }
  }

  async function handleSaveEdit(fields) {
    try {
      await updateCompany(editingCompany.id, fields)
      setEditingCompany(null)
      reload()
    } catch (err) {
      window.alert(`Could not save changes: ${err.message}`)
    }
  }

  // Confirmation happens inline in CompanyList (InlineConfirm) before this
  // is ever called — no window.confirm here.
  async function handleRemove(company) {
    try {
      await removeCompany(company.id)
      reload()
    } catch (err) {
      window.alert(`Could not remove company: ${err.message}`)
    }
  }

  function handleEdit(company) {
    setEditingCompany(company)
    setShowAddForm(false)
  }

  async function handleSetInContact(company) {
    try {
      await setInContactMarker(company.id)
      setActionError(null)
      reload()
    } catch (err) {
      if (err.message === 'ALREADY_IN_CONTACT') {
        setActionError({
          rowKey: company.rowKey,
          message: `Someone else just marked ${company.name} as in contact — try again once they release it.`,
        })
        reload()
        return
      }
      if (err.message === 'COOLDOWN_ACTIVE') {
        let daysLeft
        try {
          daysLeft = JSON.parse(err.details).days_left
        } catch {
          // Fall through to the generic message below.
        }
        setActionError({
          rowKey: company.rowKey,
          message:
            daysLeft != null
              ? `${company.name} is already on cooldown — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`
              : `${company.name} is already on cooldown.`,
        })
        reload()
        return
      }
      setActionError({ rowKey: company.rowKey, message: `Could not mark as in contact: ${err.message}` })
    }
  }

  // "Not in contact anymore" always commits the cooldown -- no skip option,
  // per PRD V1 (the rule has to be enforced at the data layer, not offered
  // as an easy-to-skip UI choice). COOLDOWN_ACTIVE here means a cooldown was
  // already running underneath the marker -- log_interaction() clears a
  // marker like that as part of raising the error (see the self-heal
  // migration), so it isn't left dangling; reload() picks up the corrected
  // badge. Whoever's actually blocking it can just Reset cooldown, or it
  // clears itself once that cooldown naturally expires.
  async function handleEndInContact(company) {
    try {
      await confirmInContactCooldown(company.id)
      setActionError(null)
      reload()
    } catch (err) {
      if (err.message === 'COOLDOWN_ACTIVE') {
        let daysLeft
        try {
          daysLeft = JSON.parse(err.details).days_left
        } catch {
          // Fall through to the generic message below.
        }
        setActionError({
          rowKey: company.rowKey,
          message:
            daysLeft != null
              ? `${company.name} already has an active cooldown — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`
              : `${company.name} already has an active cooldown.`,
        })
        reload()
        return
      }
      setActionError({ rowKey: company.rowKey, message: `Could not update contact status: ${err.message}` })
    }
  }

  async function handleResetCooldown(company) {
    try {
      await resetCooldown(company.id)
      reload()
    } catch (err) {
      window.alert(`Could not reset cooldown: ${err.message}`)
    }
  }

  async function handleAddTag(company, name) {
    try {
      await addTagToCompany(appUser.tenant_id, company.id, name)
      reload()
    } catch (err) {
      window.alert(`Could not add tag: ${err.message}`)
    }
  }

  async function handleRemoveTag(company, tagId) {
    try {
      await removeTagFromCompany(company.id, tagId)
      reload()
    } catch (err) {
      window.alert(`Could not remove tag: ${err.message}`)
    }
  }

  const tagsById = Object.fromEntries(allTags.map((tag) => [tag.id, tag]))
  const allCompaniesDisplayed = markTracked(allRows, trackedOrgNumbers)
  const myCompaniesDisplayed = myCompanies.map((company) => ({
    ...company,
    eligibility: eligibilityBadge(company, eligibilityByCompany[company.id], appUser?.id, inContactNames),
    tags: (companyTagIds[company.id] ?? []).map((tagId) => tagsById[tagId]).filter(Boolean),
  }))

  return (
    <>
      <h1>Companies</h1>

      <div className="company-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'all'}
          className={`company-tab${activeTab === 'all' ? ' company-tab-active' : ''}`}
          onClick={() => switchTab('all')}
        >
          All Companies
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'mine'}
          className={`company-tab${activeTab === 'mine' ? ' company-tab-active' : ''}`}
          onClick={() => switchTab('mine')}
        >
          My Companies
        </button>
      </div>

      {activeTab === 'all' && (
        <>
          <div className="companies-toolbar">
            <CompanySearchBar value={allQuery} onChange={handleAllQueryChange} />
            <button
              type="button"
              className="btn"
              title="For a company that isn't in the shared registry"
              onClick={() => setShowAddForm((current) => !current)}
            >
              {showAddForm ? 'Cancel' : '+ Add a company not in the registry'}
            </button>
          </div>

          {showAddForm && (
            <CompanyForm
              initialValues={{}}
              submitLabel="Add company"
              onSubmit={handleAddManual}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {allError && <p className="company-search-error">Search failed: {allError}</p>}

          {allLoading && !allHasLoadedOnce ? (
            <p>Loading…</p>
          ) : (
            <>
              <CompanyList
                companies={allCompaniesDisplayed}
                isAdmin={isAdmin}
                onRemove={handleRemove}
                onAdd={handleAdd}
                onEdit={handleEdit}
              />

              {(allPage > 0 || allHasMore) && (
                <div className="company-pagination">
                  <button
                    type="button"
                    className="btn"
                    disabled={allPage === 0}
                    onClick={() => setAllPage((current) => Math.max(0, current - 1))}
                  >
                    ← Previous
                  </button>
                  <span className="company-pagination-page">Page {allPage + 1}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={!allHasMore}
                    onClick={() => setAllPage((current) => current + 1)}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}

          {lookupState === 'not-in-registry' && (
            <div className="company-lookup-prompt">
              <p>Not in the shared registry yet.</p>
              <button className="btn" onClick={handleLookup}>
                Look up {allQuery.trim()} on Bolagsverket
              </button>
            </div>
          )}

          {lookupState === 'looking-up' && <p>Looking up {allQuery.trim()} on Bolagsverket…</p>}

          {lookupState === 'error' && <p>{lookupError}</p>}

          {lookupState === 'found-in-registry' && registryHit && (
            <div className="company-lookup-prompt">
              <p>
                Fetched from Bolagsverket: <strong>{registryHit.name}</strong> (
                {formatOrgNumber(registryHit.org_number)}) — not yet in your list.
              </p>
              <button className="btn" onClick={() => handleAdd(registryHit)}>
                Add to my companies
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === 'mine' && (
        <>
          <div className="companies-toolbar">
            <CompanySearchBar value={myQuery} onChange={setMyQuery} />
          </div>

          {editingCompany && (
            <CompanyForm
              initialValues={editingCompany}
              submitLabel="Save changes"
              onSubmit={handleSaveEdit}
              onCancel={() => setEditingCompany(null)}
            />
          )}

          {myError && <p className="company-search-error">Search failed: {myError}</p>}

          {myLoading && !myHasLoadedOnce ? (
            <p>Loading…</p>
          ) : (
            <CompanyList
              companies={myCompaniesDisplayed}
              isAdmin={isAdmin}
              onRemove={handleRemove}
              onAdd={handleAdd}
              onEdit={handleEdit}
              onSetInContact={handleSetInContact}
              onEndInContact={handleEndInContact}
              onResetCooldown={handleResetCooldown}
              onAddTag={handleAddTag}
              onRemoveTag={handleRemoveTag}
              actionError={actionError}
              onDismissError={dismissActionError}
            />
          )}
        </>
      )}
    </>
  )
}

export default Companies
