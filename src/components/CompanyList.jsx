import { useState } from 'react'

const COMPANY_FORM_LABELS = {
  AB: 'Aktiebolag',
  HB: 'Handelsbolag',
  KB: 'Kommanditbolag',
  EK: 'Ekonomisk förening',
  BRF: 'Bostadsrättsförening',
  E: 'Enskild firma',
  none: '—',
  other: 'Other',
}

// `company` (tracked rows) and company_registry_cache (registry rows) name
// this field differently — see addCompanyFromRegistry in lib/companies.js.
function description(company) {
  return company.description ?? company.business_description ?? null
}

function metaLine(company) {
  return [
    company.org_number ?? '—',
    COMPANY_FORM_LABELS[company.company_form] ?? company.company_form ?? '—',
    company.city,
    company.sni_code ? `SNI ${company.sni_code}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

// contact_eligibility only ever produces one of three shapes (see
// eligibilityBadge in pages/Companies.jsx): available, in-contact (the
// viewer made the last contact), or cooldown (a teammate did — shown as two
// badges together since "who" and "how long" are both worth knowing).
function EligibilityBadges({ eligibility }) {
  if (!eligibility) return null
  if (eligibility.kind === 'available') {
    return <span className="badge badge-available">Available</span>
  }
  if (eligibility.kind === 'in-contact') {
    return <span className="badge badge-in-contact">In contact</span>
  }
  return (
    <>
      <span className="badge badge-cooldown">Cooldown, {eligibility.daysLeft}d left</span>
      <span className="badge badge-neutral">Contacted by {eligibility.contactedBy}</span>
    </>
  )
}

function CompanyList({ companies, canRemove, onRemove, onAdd, onEdit }) {
  const [expandedKey, setExpandedKey] = useState(null)

  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  return (
    <ul className="company-list">
      {companies.map((company) => {
        const expanded = company.rowKey === expandedKey
        return (
          <li key={company.rowKey} className="company-card">
            <button
              type="button"
              className="company-card-summary"
              aria-expanded={expanded}
              onClick={() => setExpandedKey((current) => (current === company.rowKey ? null : company.rowKey))}
            >
              <span className="company-card-chevron">{expanded ? '▾' : '▸'}</span>
              <span className="company-card-heading">
                <span className="company-card-name">{company.name}</span>
                <span className="company-card-meta">{metaLine(company)}</span>
              </span>
              <span className="company-card-badges">
                {company.no_marketing && (
                  <span className="badge badge-neutral" title="Reklamspärr — opted out of marketing contact">
                    No marketing
                  </span>
                )}
                {company.tracked && <EligibilityBadges eligibility={company.eligibility} />}
                {!company.tracked && company.alreadyAdded && (
                  <span className="company-card-added" title="Already in your companies">
                    ✓ Added
                  </span>
                )}
              </span>
            </button>

            {expanded && (
              <div className="company-card-detail">
                {company.address && (
                  <p className="company-card-detail-row">
                    <strong>Address:</strong> {company.address}
                    {company.zip ? `, ${company.zip}` : ''} {company.city ?? ''}
                  </p>
                )}
                {company.industry_label && (
                  <p className="company-card-detail-row">
                    <strong>Industry:</strong> {company.industry_label}
                  </p>
                )}
                <p className="company-card-description">
                  {description(company) || 'No business description available.'}
                </p>

                <div className="company-card-actions">
                  {!company.tracked && !company.alreadyAdded && (
                    <button type="button" className="row-action" onClick={() => onAdd(company)}>
                      + Add to my companies
                    </button>
                  )}
                  {!company.tracked && company.alreadyAdded && (
                    <span className="row-note">Already in your companies</span>
                  )}
                  {company.tracked && company.is_manual && (
                    <button type="button" className="row-action" onClick={() => onEdit(company)}>
                      Edit
                    </button>
                  )}
                  {company.tracked && !company.is_manual && (
                    <span className="row-note" title="Registry data from Bolagsverket — not editable">
                      Registry data
                    </span>
                  )}
                  {company.tracked && canRemove && (
                    <button
                      type="button"
                      className="row-action row-action-danger"
                      onClick={() => onRemove(company)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default CompanyList
