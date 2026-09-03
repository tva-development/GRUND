import { useEffect, useState } from 'react'

import CompanyList from '../components/CompanyList'
import { useAuth } from '../context/AuthContext'
import { listMyInContactCompanies, resetCooldown } from '../lib/companies'

// Every company here is, by construction, one the viewer is in contact with
// — either an uncommitted in_contact_by marker (still reversible — 'red')
// or a committed cooldown (nothing left to undo — 'cooldown'/amber, same as
// Companies.jsx's eligibilityBadge treats a self-committed cooldown).
function withInContactBadge(companies) {
  return companies.map((company) => ({
    ...company,
    eligibility: company.uncommitted
      ? { kind: 'in-contact' }
      : { kind: 'cooldown', daysLeft: company.daysLeft, contactedBy: null },
  }))
}

function Overview() {
  const { appUser } = useAuth()
  const isAdmin = appUser?.role === 'admin'
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!appUser) return
    let active = true

    async function load() {
      setLoading(true)
      try {
        const rows = await listMyInContactCompanies(appUser.id)
        if (!active) return
        setCompanies(rows)
        setError(null)
      } catch (err) {
        if (!active) return
        setError(err.message ?? 'Failed to load')
      } finally {
        if (active) setLoading(false)
      }
    }

    load()
    return () => {
      active = false
    }
  }, [appUser, reloadToken])

  // A company can be on cooldown here without being bookmarked in "My
  // Companies" (removed but still on cooldown — see removeCompany), so
  // resetting has to be reachable from this page too, not just from there.
  async function handleResetCooldown(company) {
    try {
      await resetCooldown(company.id)
      setReloadToken((current) => current + 1)
    } catch (err) {
      window.alert(`Could not reset cooldown: ${err.message}`)
    }
  }

  return (
    <>
      {/* <span className="eyebrow">Overview</span> */}
      <h1>Overview</h1>
      <h2>Companies you're in contact with</h2>

      {error && <p className="company-search-error">Failed to load: {error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : companies.length === 0 ? (
        <p>You're not marked as in contact with, or in an active cooldown with, any company right now.</p>
      ) : (
        <CompanyList
          companies={withInContactBadge(companies)}
          isAdmin={isAdmin}
          onResetCooldown={handleResetCooldown}
        />
      )}
    </>
  )
}

export default Overview
