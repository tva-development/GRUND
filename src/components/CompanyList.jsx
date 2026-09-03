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

// A click that ends a text selection still fires a click event on mouseup —
// without this check, dragging to select an org number or a name would also
// toggle the card open/closed out from under you.
function hasActiveSelection() {
  const selection = window.getSelection()
  return !!selection && selection.toString().length > 0
}

// See eligibilityBadge in pages/Companies.jsx for how these four shapes get
// picked: available, in-contact (the viewer's own reversible marker —
// there's no "committed by me" variant, see the comment there), contacting
// (a teammate marked it, not yet committed), or cooldown (a committed
// interaction — contactedBy is only set when it was a teammate, not the
// viewer, since "Contacted by you" alongside a cooldown you already know
// about isn't telling you anything).
function EligibilityBadges({ eligibility }) {
  if (!eligibility) return null
  if (eligibility.kind === 'available') {
    return <span className="badge badge-available">Available</span>
  }
  if (eligibility.kind === 'in-contact') {
    return <span className="badge badge-in-contact">In contact</span>
  }
  if (eligibility.kind === 'contacting') {
    return <span className="badge badge-neutral">Being contacted by {eligibility.contactedBy}</span>
  }
  return (
    <>
      <span className="badge badge-cooldown">Cooldown, {eligibility.daysLeft}d left</span>
      {eligibility.contactedBy && <span className="badge badge-neutral">Contacted by {eligibility.contactedBy}</span>}
    </>
  )
}

// Its own component (not inline JSX) so each card's draft text is local
// state that doesn't leak into the parent list's re-renders.
function TagInput({ company, onAdd }) {
  const [value, setValue] = useState('')

  function handleSubmit(event) {
    event.preventDefault()
    if (!value.trim()) return
    onAdd(company, value)
    setValue('')
  }

  return (
    <form className="company-card-tag-form" onSubmit={handleSubmit}>
      <input
        type="text"
        className="company-card-tag-input"
        placeholder="Add tag…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        list="company-tag-options"
      />
      <button type="submit" className="link-button">
        Add
      </button>
    </form>
  )
}

// Every handler is optional so the same list can be reused read-only (the
// Overview page's "who am I in contact with" tracker passes none of them,
// and the corresponding buttons just don't render). `isAdmin` gates both
// Remove and Reset cooldown — same permission, two different actions.
function CompanyList({
  companies,
  isAdmin,
  onRemove,
  onAdd,
  onEdit,
  onSetInContact,
  onEndInContact,
  onResetCooldown,
  allTags,
  onAddTag,
  onRemoveTag,
}) {
  const [expandedKey, setExpandedKey] = useState(null)

  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  function toggleExpanded(rowKey) {
    if (hasActiveSelection()) return
    setExpandedKey((current) => (current === rowKey ? null : rowKey))
  }

  return (
    <>
      {allTags && allTags.length > 0 && (
        <datalist id="company-tag-options">
          {allTags.map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
        </datalist>
      )}
      <ul className="company-list">
        {companies.map((company) => {
          const expanded = company.rowKey === expandedKey
          const canQuickAdd = !company.tracked && !company.alreadyAdded && onAdd
          return (
            <li key={company.rowKey} className="company-card">
              <div className="company-card-header">
                <div
                  className="company-card-summary"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => toggleExpanded(company.rowKey)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    toggleExpanded(company.rowKey)
                  }}
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
                    {(company.tags ?? []).map((tag) => (
                      <span key={tag.id} className="badge badge-neutral">
                        {tag.name}
                      </span>
                    ))}
                    {company.tracked && <EligibilityBadges eligibility={company.eligibility} />}
                    {!company.tracked && company.alreadyAdded && (
                      <span className="company-card-added" title="Already in your companies">
                        ✓ Added
                      </span>
                    )}
                  </span>
                </div>
                {canQuickAdd && (
                  <button
                    type="button"
                    className="row-action company-card-quick-add"
                    onClick={() => onAdd(company)}
                    title={`Add ${company.name} to your companies`}
                  >
                    + Add
                  </button>
                )}
              </div>

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
                  {company.daysLeft != null && (
                    <p className="company-card-detail-row">
                      <strong>Cooldown ends in:</strong> {company.daysLeft} day{company.daysLeft === 1 ? '' : 's'}
                    </p>
                  )}
                  <p className="company-card-description">
                    {description(company) || 'No business description available.'}
                  </p>

                  {company.tracked && (onAddTag || (company.tags ?? []).length > 0) && (
                    <div className="company-card-tags">
                      {(company.tags ?? []).map((tag) => (
                        <span key={tag.id} className="badge badge-neutral">
                          {tag.name}
                          {onRemoveTag && (
                            <button
                              type="button"
                              className="company-card-tag-remove"
                              onClick={() => onRemoveTag(company, tag.id)}
                              aria-label={`Remove tag ${tag.name}`}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {onAddTag && <TagInput company={company} onAdd={onAddTag} />}
                    </div>
                  )}

                  <div className="company-card-actions">
                    {!company.tracked && company.alreadyAdded && (
                      <span className="row-note">Already in your companies</span>
                    )}
                    {company.tracked &&
                      onSetInContact &&
                      (!company.eligibility || company.eligibility.kind === 'available') && (
                        <button type="button" className="row-action" onClick={() => onSetInContact(company)}>
                          In contact
                        </button>
                      )}
                    {company.tracked && onEndInContact && company.eligibility?.kind === 'in-contact' && (
                      <button
                        type="button"
                        className="row-action"
                        title="Starts a 14-day cooldown"
                        onClick={() => onEndInContact(company)}
                      >
                        Not in contact anymore
                      </button>
                    )}
                    {company.tracked &&
                      onResetCooldown &&
                      isAdmin &&
                      company.eligibility?.kind === 'cooldown' && (
                        <button type="button" className="row-action" onClick={() => onResetCooldown(company)}>
                          Reset cooldown
                        </button>
                      )}
                    {company.tracked && company.is_manual && onEdit && (
                      <button type="button" className="row-action" onClick={() => onEdit(company)}>
                        Edit
                      </button>
                    )}
                    {company.tracked && isAdmin && onRemove && (
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
    </>
  )
}

export default CompanyList
