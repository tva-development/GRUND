import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import NoAccess from '../pages/NoAccess'

function RequireAuth() {
  const { loading, session, appUser } = useAuth()

  if (loading) {
    return null
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (!appUser) {
    return <NoAccess />
  }

  return <Outlet />
}

export default RequireAuth
