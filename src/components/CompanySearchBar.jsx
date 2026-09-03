function CompanySearchBar({ value, onChange }) {
  return (
    <div className="company-search-wrap">
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search by name or org number…"
        className="company-search"
      />
      {value && (
        <button
          type="button"
          className="company-search-clear"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          Clear
        </button>
      )}
    </div>
  )
}

export default CompanySearchBar
