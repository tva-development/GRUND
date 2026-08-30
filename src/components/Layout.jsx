import { NavLink, Outlet } from 'react-router-dom'

const navLinkStyle = ({ isActive }) => ({
  color: isActive ? 'var(--ink)' : 'var(--slate)',
  fontWeight: isActive ? 600 : 400,
})

function Layout() {
  return (
    <>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 24px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--mono)',
        }}
      >
        <span style={{ fontWeight: 600 }}>TVÅ / GRUND</span>
        <nav style={{ display: 'flex', gap: 20 }}>
          <NavLink to="/companies" style={navLinkStyle}>
            Companies
          </NavLink>
          <NavLink to="/tasks" style={navLinkStyle}>
            Tasks
          </NavLink>
        </nav>
      </header>
      <main style={{ flex: 1, padding: '24px' }}>
        <Outlet />
      </main>
    </>
  )
}

export default Layout
