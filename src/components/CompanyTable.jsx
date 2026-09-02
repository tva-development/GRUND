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

// Starting widths only — every column is drag-resizable from its right edge,
// and the table scrolls horizontally rather than squeezing columns, so a long
// industry label or address stays readable instead of being compressed away.
const COLUMNS = [
  { key: 'name', label: 'Name', width: 220 },
  { key: 'orgNumber', label: 'Org number', width: 140 },
  { key: 'companyForm', label: 'Legal form', width: 150 },
  { key: 'address', label: 'Address', width: 190 },
  { key: 'city', label: 'City', width: 130 },
  { key: 'industry', label: 'Industry', width: 260 },
  { key: 'actions', label: '', width: 210 },
]

const MIN_COLUMN_WIDTH = 70

function CompanyTable({
  companies,
  canRemove,
  onRemove,
  onAdd,
  selectedRowKey,
  onRowClick,
  onRowDoubleClick,
  onEdit,
}) {
  const [widths, setWidths] = useState(() =>
    Object.fromEntries(COLUMNS.map((column) => [column.key, column.width])),
  )

  function startResize(event, key) {
    // Stop the row/header click handlers from firing while dragging a divider.
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = widths[key]

    function handleMove(moveEvent) {
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX))
      setWidths((current) => ({ ...current, [key]: nextWidth }))
    }

    function handleUp() {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      document.body.classList.remove('is-col-resizing')
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    document.body.classList.add('is-col-resizing')
  }

  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  const totalWidth = COLUMNS.reduce((sum, column) => sum + widths[column.key], 0)

  return (
    <div className="company-table-scroll">
      <table className="company-table" style={{ width: totalWidth }}>
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} style={{ width: widths[column.key] }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key}>
                {column.label}
                <span
                  className="col-resize-handle"
                  onMouseDown={(event) => startResize(event, column.key)}
                  title={`Drag to resize the ${column.label || 'actions'} column`}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => {
            // Registry rows have no uuid, so both keying and selection go via
            // rowKey — every row in the list has one, tenant or registry.
            const selected = company.rowKey === selectedRowKey
            const className = [
              selected ? 'company-row-selected' : null,
              company.tracked ? null : 'company-row-untracked',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <tr
                key={company.rowKey}
                className={className || undefined}
                onClick={(event) => onRowClick?.(event, company)}
                onDoubleClick={() => onRowDoubleClick?.(company)}
              >
                <td className="cell-truncate" title={company.name}>
                  {company.name}
                  {company.no_marketing && (
                    <span
                      className="badge badge-neutral badge-inline"
                      title="Reklamspärr — opted out of marketing contact"
                    >
                      No marketing
                    </span>
                  )}
                </td>
                <td className="cell-truncate" title={company.org_number ?? undefined}>
                  {company.org_number ?? '—'}
                </td>
                <td className="cell-truncate">
                  {COMPANY_FORM_LABELS[company.company_form] ?? company.company_form ?? '—'}
                </td>
                <td className="cell-truncate" title={company.address ?? undefined}>
                  {company.address ?? '—'}
                </td>
                <td className="cell-truncate" title={company.city ?? undefined}>
                  {company.city ?? '—'}
                </td>
                <td className="cell-truncate" title={company.industry_label ?? undefined}>
                  {company.industry_label ?? '—'}
                </td>
                <td className="company-row-actions">
                  {/* A registry row isn't the tenant's yet — the only thing it
                      offers is becoming theirs. Everything else (edit, remove)
                      needs a `company` row to hang off. */}
                  {!company.tracked && !company.alreadyAdded && (
                    <button
                      type="button"
                      className="row-action"
                      onClick={(event) => {
                        event.stopPropagation()
                        onAdd(company)
                      }}
                      title={`Add ${company.name} to your companies`}
                    >
                      + Add to my companies
                    </button>
                  )}
                  {!company.tracked && company.alreadyAdded && (
                    <span className="row-note" title="Already in your companies">
                      ✓ Added
                    </span>
                  )}
                  {company.tracked && selected && company.is_manual && (
                    <button
                      type="button"
                      className="row-action"
                      onClick={(event) => {
                        event.stopPropagation()
                        onEdit(company)
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {company.tracked && selected && !company.is_manual && (
                    <span className="row-note" title="Registry data from Bolagsverket — not editable">
                      Registry data
                    </span>
                  )}
                  {company.tracked && canRemove && (
                    <button
                      type="button"
                      className="row-action row-action-danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemove(company)
                      }}
                      title={`Remove ${company.name} from your companies`}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default CompanyTable
