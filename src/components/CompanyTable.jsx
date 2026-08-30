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

function registryStatus(company) {
  if (company.in_liquidation) return { label: 'In liquidation', tone: 'warn' }
  if (company.deregistered_at) return { label: 'Deregistered', tone: 'bad' }
  if (company.is_active === false) return { label: 'Inactive', tone: 'bad' }
  if (company.is_active === true) return { label: 'Active', tone: 'good' }
  return { label: 'Unknown', tone: 'neutral' }
}

function CompanyTable({
  companies,
  canRemove,
  onRemove,
  selectedCompanyId,
  onRowClick,
  onRowDoubleClick,
  onEdit,
}) {
  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  return (
    <table className="company-table">
      <colgroup>
        <col style={{ width: '18%' }} />
        <col style={{ width: '10%' }} />
        <col style={{ width: '12%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '9%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '9%' }} />
        <col style={{ width: '12%' }} />
      </colgroup>
      <thead>
        <tr>
          <th>Name</th>
          <th>Org number</th>
          <th>Legal form</th>
          <th>Address</th>
          <th>City</th>
          <th>Industry</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {companies.map((company) => {
          const status = registryStatus(company)
          const selected = company.id === selectedCompanyId
          return (
            <tr
              key={company.id}
              className={selected ? 'company-row-selected' : undefined}
              onClick={(event) => onRowClick?.(event, company)}
              onDoubleClick={() => onRowDoubleClick?.(company)}
            >
              <td className="cell-truncate">
                <span title={company.name}>{company.name}</span>
                {company.no_marketing && (
                  <span
                    className="badge badge-neutral"
                    title="Reklamspärr — opted out of marketing contact"
                  >
                    No marketing
                  </span>
                )}
              </td>
              <td className="cell-truncate">{company.org_number ?? '—'}</td>
              <td className="cell-truncate">
                {COMPANY_FORM_LABELS[company.company_form] ?? company.company_form ?? '—'}
              </td>
              <td className="cell-truncate" title={company.address ?? undefined}>
                {company.address ?? '—'}
              </td>
              <td className="cell-truncate">{company.city ?? '—'}</td>
              <td className="cell-truncate" title={company.industry_label ?? undefined}>
                {company.industry_label ?? '—'}
              </td>
              <td>
                <span className={`badge badge-${status.tone}`}>{status.label}</span>
              </td>
              <td className="company-row-actions">
                {selected && company.is_manual && (
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
                {selected && !company.is_manual && (
                  <span className="row-note">Registry data — not editable</span>
                )}
                {canRemove && (
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
  )
}

export default CompanyTable
