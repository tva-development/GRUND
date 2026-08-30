function CompanySearchBar({ value, onChange }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Search by name or org number…"
      className="company-search"
    />
  )
}

export default CompanySearchBar
