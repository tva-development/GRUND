import { useState } from 'react'

const COMPANY_FORM_OPTIONS = [
  { value: 'none', label: '—' },
  { value: 'AB', label: 'Aktiebolag' },
  { value: 'HB', label: 'Handelsbolag' },
  { value: 'KB', label: 'Kommanditbolag' },
  { value: 'EK', label: 'Ekonomisk förening' },
  { value: 'BRF', label: 'Bostadsrättsförening' },
  { value: 'E', label: 'Enskild firma' },
  { value: 'other', label: 'Other' },
]

const EMPTY_FIELDS = {
  name: '',
  org_number: '',
  company_form: 'none',
  address: '',
  city: '',
  zip: '',
  industry_label: '',
}

function CompanyForm({ initialValues, submitLabel, onSubmit, onCancel }) {
  const [fields, setFields] = useState({ ...EMPTY_FIELDS, ...initialValues })

  function setField(key, value) {
    setFields((current) => ({ ...current, [key]: value }))
  }

  function handleSubmit(event) {
    event.preventDefault()
    if (!fields.name.trim()) return
    onSubmit({ ...fields, name: fields.name.trim() })
  }

  return (
    <form className="company-lookup-prompt company-form" onSubmit={handleSubmit}>
      <div className="company-form-grid">
        <label>
          Name *
          <input
            type="text"
            value={fields.name}
            onChange={(event) => setField('name', event.target.value)}
            required
          />
        </label>
        <label>
          Org number
          <input
            type="text"
            value={fields.org_number}
            onChange={(event) => setField('org_number', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Legal form
          <select
            value={fields.company_form}
            onChange={(event) => setField('company_form', event.target.value)}
          >
            {COMPANY_FORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Industry
          <input
            type="text"
            value={fields.industry_label}
            onChange={(event) => setField('industry_label', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Address
          <input
            type="text"
            value={fields.address}
            onChange={(event) => setField('address', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          City
          <input
            type="text"
            value={fields.city}
            onChange={(event) => setField('city', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Zip
          <input
            type="text"
            value={fields.zip}
            onChange={(event) => setField('zip', event.target.value)}
            placeholder="Optional"
          />
        </label>
      </div>
      <div className="company-form-actions">
        <button className="btn" type="submit">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

export default CompanyForm
