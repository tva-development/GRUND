import { useEffect, useState } from 'react'

import CompanyForm from '../components/CompanyForm'
import CompanySearchBar from '../components/CompanySearchBar'
import CompanyTable from '../components/CompanyTable'
import { useAuth } from '../context/AuthContext'
import {
  addCompanyFromRegistry,
  addManualCompany,
  looksLikeOrgNumber,
  lookupCompanyOnBolagsverket,
  removeCompany,
  searchCompanies,
  updateCompany,
} from '../lib/companies'

const LOOKUP_ERROR_MESSAGES = {
  INVALID_ORG_NUMBER: "That doesn't look like a valid Swedish org number.",
  NOT_FOUND: 'Bolagsverket has no record of that org number.',
  LOOKUP_FAILED: 'The lookup failed — try again in a moment.',
}

function Companies() {
  const { appUser } = useAuth()
  const [query, setQuery] = useState('')
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  // 'idle' | 'not-in-registry' | 'looking-up' | 'found-in-registry' | 'error'
  const [lookupState, setLookupState] = useState('idle')
  const [registryHit, setRegistryHit] = useState(null)
  const [lookupError, setLookupError] = useState(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [selectedRowKey, setSelectedRowKey] = useState(null)
  const [editingCompany, setEditingCompany] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [searchError, setSearchError] = useState(null)

  const isAdmin = appUser?.role === 'admin'

  useEffect(() => {
    let active = true
    const timeout = setTimeout(async () => {
      setLoading(true)
      let results
      try {
        results = await searchCompanies(query)
      } catch (err) {
        // The search now spans the shared registry too, so a failure here is
        // no longer just "your own list is empty" — surface it rather than
        // leaving the table silently stuck on its previous contents.
        if (!active) return
        setSearchError(err.message ?? 'Search failed')
        setCompanies([])
        setLoading(false)
        setLookupState('idle')
        return
      }
      if (!active) return
      setSearchError(null)
      setCompanies(results)
      setLoading(false)

      // searchCompanies now covers tiers 1 and 2 in one go, so an empty result
      // for an org number already means "not in your list and not in the
      // shared registry either". The only thing left to try is tier 3.
      const trimmed = query.trim()
      setRegistryHit(null)
      setLookupState(
        trimmed && looksLikeOrgNumber(trimmed) && results.length === 0 ? 'not-in-registry' : 'idle',
      )
    }, 300)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [query, reloadToken])

  async function handleLookup() {
    setLookupState('looking-up')
    setLookupError(null)
    try {
      const row = await lookupCompanyOnBolagsverket(query.trim())
      setRegistryHit(row)
      setLookupState('found-in-registry')
    } catch (err) {
      setLookupError(LOOKUP_ERROR_MESSAGES[err.message] ?? LOOKUP_ERROR_MESSAGES.LOOKUP_FAILED)
      setLookupState('error')
    }
  }

  // Adding or removing changes which rows count as tracked, and therefore how
  // searchCompanies merges and de-duplicates them. Re-running the search is
  // what keeps that logic in one place instead of splicing the list by hand
  // here and getting a row that shows as both tracked and untracked.
  function reload() {
    setReloadToken((current) => current + 1)
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
      setSelectedRowKey(null)
      reload()
    } catch (err) {
      window.alert(`Could not remove company: ${err.message}`)
    }
  }

  function handleRowClick(event, company) {
    // A double-click fires two click events before the dblclick — ignore
    // anything past the first so selection doesn't flicker on/off.
    if (event.detail > 1) return
    setSelectedRowKey((current) => (current === company.rowKey ? null : company.rowKey))
  }

  function handleRowDoubleClick(company) {
    // Only the tenant's own manually-added rows are editable. A registry row
    // isn't theirs yet, and a registry-sourced one mirrors Bolagsverket.
    if (company.tracked && company.is_manual) {
      setSelectedRowKey(company.rowKey)
      setEditingCompany(company)
      setShowAddForm(false)
    }
  }

  function handleEdit(company) {
    setEditingCompany(company)
    setShowAddForm(false)
  }

  return (
    <>
      <h1>Companies</h1>

      <div className="companies-toolbar">
        <CompanySearchBar value={query} onChange={setQuery} />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setShowAddForm((current) => !current)
            setEditingCompany(null)
          }}
        >
          {showAddForm ? 'Cancel' : '+ Add company'}
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

      {searchError && <p className="company-search-error">Search failed: {searchError}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <CompanyTable
          companies={companies}
          canRemove={isAdmin}
          onRemove={handleRemove}
          onAdd={handleAdd}
          selectedRowKey={selectedRowKey}
          onRowClick={handleRowClick}
          onRowDoubleClick={handleRowDoubleClick}
          onEdit={handleEdit}
        />
      )}

      {lookupState === 'not-in-registry' && (
        <div className="company-lookup-prompt">
          <p>Not in your list or the shared registry yet.</p>
          <button className="btn" onClick={handleLookup}>
            Look up {query.trim()} on Bolagsverket
          </button>
        </div>
      )}

      {lookupState === 'looking-up' && <p>Looking up {query.trim()} on Bolagsverket…</p>}

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
  )
}

export default Companies
