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

function CompanyTable({ companies }) {
  if (companies.length === 0) {
    return <p>No companies match your search yet.</p>
  }

  return (
    <table className="company-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Org number</th>
          <th>Legal form</th>
          <th>City</th>
          <th>Industry</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((company) => {
          const status = registryStatus(company)
          return (
            <tr key={company.id}>
              <td>
                {company.name}
                {company.no_marketing && (
                  <span
                    className="badge badge-neutral"
                    title="Reklamspärr — opted out of marketing contact"
                  >
                    No marketing
                  </span>
                )}
              </td>
              <td>{company.org_number ?? '—'}</td>
              <td>{COMPANY_FORM_LABELS[company.company_form] ?? company.company_form ?? '—'}</td>
              <td>{company.city ?? '—'}</td>
              <td>{company.industry_label ?? '—'}</td>
              <td>
                <span className={`badge badge-${status.tone}`}>{status.label}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default CompanyTable
