import { useRef, useState } from 'react'

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

// A drag that selects text ends with a click event on mouseup, so the summary
// row has to tell "tap to toggle" apart from "drag to copy an org number".
//
// It must not do that by asking whether a selection exists. .company-card-summary
// is user-select:none, and clicking a non-selectable region does not clear the
// document's selection — so one stray highlight anywhere on the page swallowed
// every later click on the row, permanently, until the user happened to click
// something selectable. Rapid toggling hit the same wall: a double-click leaves a
// word (or a lone space) selected between its two clicks.
//
// Judge the gesture instead — only a pointer that actually travelled is a drag.
const DRAG_SLOP_PX = 4

function isDragGesture(origin, event) {
  // Keyboard-synthesised clicks report detail 0 and carry no pointer origin.
  if (!origin || event.detail === 0) return false
  return (
    Math.abs(event.clientX - origin.x) > DRAG_SLOP_PX ||
    Math.abs(event.clientY - origin.y) > DRAG_SLOP_PX
  )
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
// state that doesn't leak into the parent list's re-renders. Plain text
// input, no autocomplete dropdown — exact-name reuse already happens
// server-side (see addTagToCompany), a picker UI wasn't adding anything.
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
      />
      <button type="submit" className="link-button">
        Add
      </button>
    </form>
  )
}

// A small inline "are you sure" in place of window.confirm, which renders as
// an unstyled native browser dialog. `label` is the question, `confirmLabel`
// the affirmative button's text, `danger` swaps its color for a destructive
// action (Remove) vs a neutral one (Reset cooldown).
function InlineConfirm({ label, confirmLabel, danger, onConfirm, onCancel }) {
  return (
    <span className="company-card-confirm">
      <span className="row-note">{label}</span>
      <button
        type="button"
        className={danger ? 'row-action row-action-danger' : 'row-action'}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
      <button type="button" className="link-button" onClick={onCancel}>
        Cancel
      </button>
    </span>
  )
}

// Every handler is optional so the same list can be reused read-only (the
// Overview page's "who am I in contact with" tracker passes none of them,
// and the corresponding buttons just don't render). `isAdmin` gates Remove
// only — Reset cooldown is open to any tenant member.
function CompanyList({
  companies,
  isAdmin,
  onRemove,
  onAdd,
  onEdit,
  onSetInContact,
  onEndInContact,
  onResetCooldown,
  onAddTag,
  onRemoveTag,
  actionError,
  onDismissError,
}) {
  const [expandedKey, setExpandedKey] = useState(null)
  // Which card is mid-confirm for which action — at most one at a time, and
  // switching cards or actions just replaces it.
  const [confirming, setConfirming] = useState(null)
  // Where the pointer went down on a summary row, so its click can be read as a
  // tap or a drag. One gesture is ever in flight, so one ref covers every card.
  const pointerOrigin = useRef(null)

  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  function toggleExpanded(rowKey) {
    setExpandedKey((current) => (current === rowKey ? null : rowKey))
  }

  function handleSummaryClick(rowKey, event) {
    const origin = pointerOrigin.current
    pointerOrigin.current = null
    if (isDragGesture(origin, event)) return
    // The row can't clear a leftover highlight itself (user-select:none), so a
    // tap does what clicking any other bit of document would have done.
    const selection = window.getSelection()
    if (selection && selection.toString()) selection.removeAllRanges()
    toggleExpanded(rowKey)
  }

  return (
    <>
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
                  onPointerDown={(event) => {
                    pointerOrigin.current = { x: event.clientX, y: event.clientY }
                  }}
                  onMouseDown={(event) => {
                    // Keep rapid toggling from leaving the browser's
                    // double-click word selection behind on the row.
                    if (event.detail > 1) event.preventDefault()
                  }}
                  onClick={(event) => handleSummaryClick(company.rowKey, event)}
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

                  {actionError?.rowKey === company.rowKey && (
                    <p className="company-card-error">
                      {actionError.message}
                      <button type="button" className="link-button" onClick={onDismissError}>
                        Dismiss
                      </button>
                    </p>
                  )}

                  <div className="company-card-actions">
                    {!company.tracked && company.alreadyAdded && (
                      <span className="row-note">Already in your companies</span>
                    )}
                    {company.tracked &&
                      onSetInContact &&
                      confirming?.rowKey !== company.rowKey &&
                      (!company.eligibility || company.eligibility.kind === 'available') && (
                        <button type="button" className="row-action" onClick={() => onSetInContact(company)}>
                          In contact
                        </button>
                      )}
                    {company.tracked &&
                      onEndInContact &&
                      confirming?.rowKey !== company.rowKey &&
                      company.eligibility?.kind === 'in-contact' && (
                        <button
                          type="button"
                          className="row-action"
                          title="Starts a 14-day cooldown"
                          onClick={() => onEndInContact(company)}
                        >
                          Not in contact anymore
                        </button>
                      )}
                    {company.tracked && onResetCooldown && company.eligibility?.kind === 'cooldown' && (
                      <>
                        {confirming?.rowKey === company.rowKey && confirming.kind === 'reset' ? (
                          <InlineConfirm
                            label={`Reset the cooldown on ${company.name}?`}
                            confirmLabel="Reset cooldown"
                            onConfirm={() => {
                              onResetCooldown(company)
                              setConfirming(null)
                            }}
                            onCancel={() => setConfirming(null)}
                          />
                        ) : (
                          confirming?.rowKey !== company.rowKey && (
                            <button
                              type="button"
                              className="row-action"
                              onClick={() => setConfirming({ rowKey: company.rowKey, kind: 'reset' })}
                            >
                              Reset cooldown
                            </button>
                          )
                        )}
                      </>
                    )}
                    {company.tracked && company.is_manual && onEdit && confirming?.rowKey !== company.rowKey && (
                      <button type="button" className="row-action" onClick={() => onEdit(company)}>
                        Edit
                      </button>
                    )}
                    {company.tracked && isAdmin && onRemove && (
                      <>
                        {confirming?.rowKey === company.rowKey && confirming.kind === 'remove' ? (
                          <InlineConfirm
                            label={`Remove ${company.name} from your companies?`}
                            confirmLabel="Remove"
                            danger
                            onConfirm={() => {
                              onRemove(company)
                              setConfirming(null)
                            }}
                            onCancel={() => setConfirming(null)}
                          />
                        ) : (
                          confirming?.rowKey !== company.rowKey && (
                            <button
                              type="button"
                              className="row-action row-action-danger"
                              onClick={() => setConfirming({ rowKey: company.rowKey, kind: 'remove' })}
                            >
                              Remove
                            </button>
                          )
                        )}
                      </>
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
