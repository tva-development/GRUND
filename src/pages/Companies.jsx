import { useEffect, useState } from 'react'

import CompanyForm from '../components/CompanyForm'
import CompanySearchBar from '../components/CompanySearchBar'
import CompanyTable from '../components/CompanyTable'
import { useAuth } from '../context/AuthContext'
import {
  addCompanyFromRegistry,
  addManualCompany,
  findInRegistryCache,
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
  // 'idle' | 'checking' | 'not-in-registry' | 'looking-up' | 'found-in-registry' | 'error'
  const [lookupState, setLookupState] = useState('idle')
  const [registryHit, setRegistryHit] = useState(null)
  const [lookupError, setLookupError] = useState(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [selectedCompanyId, setSelectedCompanyId] = useState(null)
  const [editingCompany, setEditingCompany] = useState(null)

  const isAdmin = appUser?.role === 'admin'

  useEffect(() => {
    let active = true
    const timeout = setTimeout(async () => {
      setLoading(true)
      const results = await searchCompanies(query)
      if (!active) return
      setCompanies(results)
      setLoading(false)

      const trimmed = query.trim()
      if (!trimmed || !looksLikeOrgNumber(trimmed) || results.length > 0) {
        setLookupState('idle')
        setRegistryHit(null)
        return
      }

      setLookupState('checking')
      const cached = await findInRegistryCache(trimmed)
      if (!active) return
      if (cached) {
        setRegistryHit(cached)
        setLookupState('found-in-registry')
      } else {
        setRegistryHit(null)
        setLookupState('not-in-registry')
      }
    }, 300)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [query])

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

  async function handleAdd() {
    try {
      const added = await addCompanyFromRegistry(appUser.tenant_id, registryHit)
      setCompanies((current) => [...current, added].sort((a, b) => a.name.localeCompare(b.name)))
      setRegistryHit(null)
      setLookupState('idle')
    } catch (err) {
      window.alert(`Could not add company: ${err.message}`)
    }
  }

  async function handleAddManual(fields) {
    try {
      const added = await addManualCompany(appUser.tenant_id, fields)
      setCompanies((current) => [...current, added].sort((a, b) => a.name.localeCompare(b.name)))
      setShowAddForm(false)
    } catch (err) {
      window.alert(`Could not add company: ${err.message}`)
    }
  }

  async function handleSaveEdit(fields) {
    try {
      const updated = await updateCompany(editingCompany.id, fields)
      setCompanies((current) =>
        current
          .map((c) => (c.id === updated.id ? updated : c))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      setEditingCompany(null)
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
      setCompanies((current) => current.filter((c) => c.id !== company.id))
    } catch (err) {
      window.alert(`Could not remove company: ${err.message}`)
    }
  }

  function handleRowClick(event, company) {
    // A double-click fires two click events before the dblclick — ignore
    // anything past the first so selection doesn't flicker on/off.
    if (event.detail > 1) return
    setSelectedCompanyId((current) => (current === company.id ? null : company.id))
  }

  function handleRowDoubleClick(company) {
    if (company.is_manual) {
      setSelectedCompanyId(company.id)
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
      <span className="eyebrow">Companies</span>
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

      {loading ? (
        <p>Loading…</p>
      ) : (
        <CompanyTable
          companies={companies}
          canRemove={isAdmin}
          onRemove={handleRemove}
          selectedCompanyId={selectedCompanyId}
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
            Found in the shared registry: <strong>{registryHit.name}</strong> (
            {registryHit.org_number}) — not yet in your list.
          </p>
          <button className="btn" onClick={handleAdd}>
            Add to my companies
          </button>
        </div>
      )}
    </>
  )
}

export default Companies
