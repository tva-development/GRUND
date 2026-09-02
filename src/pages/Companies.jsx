import { useEffect, useState } from 'react'

import CompanyForm from '../components/CompanyForm'
import CompanyList from '../components/CompanyList'
import CompanySearchBar from '../components/CompanySearchBar'
import { useAuth } from '../context/AuthContext'
import {
  addCompanyFromRegistry,
  addManualCompany,
  listMyCompanies,
  listRegistryCompanies,
  listTrackedOrgNumbers,
  looksLikeOrgNumber,
  lookupCompanyOnBolagsverket,
  markTracked,
  removeCompany,
  updateCompany,
} from '../lib/companies'

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
  const [activeTab, setActiveTab] = useState('mine')

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingCompany, setEditingCompany] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)

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

  // ---------------------------------------------------------------------
  // "My Companies" — the tenant's own tracked list.
  // ---------------------------------------------------------------------
  const [myQuery, setMyQuery] = useState('')
  const [myCompanies, setMyCompanies] = useState([])
  const [myLoading, setMyLoading] = useState(true)
  const [myError, setMyError] = useState(null)

  useEffect(() => {
    let active = true
    const timeout = setTimeout(async () => {
      setMyLoading(true)
      try {
        const results = await listMyCompanies(myQuery)
        if (!active) return
        setMyCompanies(results)
        setMyError(null)
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

  async function handleRemove(company) {
    if (!window.confirm(`Remove ${company.name} from your companies?`)) {
      return
    }
    try {
      const removed = await removeCompany(company.id)
      if (removed.length === 0) {
        window.alert('Only admins can remove companies.')
        return
      }
      reload()
    } catch (err) {
      window.alert(`Could not remove company: ${err.message}`)
    }
  }

  function handleEdit(company) {
    setEditingCompany(company)
    setShowAddForm(false)
  }

  const allCompaniesDisplayed = markTracked(allRows, trackedOrgNumbers)

  return (
    <>
      <h1>Companies</h1>

      <div className="company-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'mine'}
          className={`company-tab${activeTab === 'mine' ? ' company-tab-active' : ''}`}
          onClick={() => switchTab('mine')}
        >
          My Companies
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'all'}
          className={`company-tab${activeTab === 'all' ? ' company-tab-active' : ''}`}
          onClick={() => switchTab('all')}
        >
          All Companies
        </button>
      </div>

      {activeTab === 'mine' && (
        <>
          <div className="companies-toolbar">
            <CompanySearchBar value={myQuery} onChange={setMyQuery} />
            <button
              type="button"
              className="btn"
              title="For a company not in the shared registry — search All Companies first"
              onClick={() => {
                setShowAddForm((current) => !current)
                setEditingCompany(null)
              }}
            >
              {showAddForm ? 'Cancel' : "+ Add a company not in the registry"}
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

          {editingCompany && (
            <CompanyForm
              initialValues={editingCompany}
              submitLabel="Save changes"
              onSubmit={handleSaveEdit}
              onCancel={() => setEditingCompany(null)}
            />
          )}

          {myError && <p className="company-search-error">Search failed: {myError}</p>}

          {myLoading ? (
            <p>Loading…</p>
          ) : (
            <CompanyList
              companies={myCompanies}
              canRemove={isAdmin}
              onRemove={handleRemove}
              onAdd={handleAdd}
              onEdit={handleEdit}
            />
          )}
        </>
      )}

      {activeTab === 'all' && (
        <>
          <div className="companies-toolbar">
            <CompanySearchBar value={allQuery} onChange={handleAllQueryChange} />
          </div>

          {allError && <p className="company-search-error">Search failed: {allError}</p>}

          {allLoading ? (
            <p>Loading…</p>
          ) : (
            <>
              <CompanyList
                companies={allCompaniesDisplayed}
                canRemove={false}
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
                {registryHit.org_number}) — not yet in your list.
              </p>
              <button className="btn" onClick={() => handleAdd(registryHit)}>
                Add to my companies
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

export default Companies
