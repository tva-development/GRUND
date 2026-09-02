import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import { AuthProvider, useAuth } from './context/AuthContext'
import Companies from './pages/Companies'
import Login from './pages/Login'
import Overview from './pages/Overview'

function LoginRoute() {
  const { loading, session } = useAuth()

  if (loading) {
    return null
  }

  if (session) {
    return <Navigate to="/companies" replace />
  }

  return <Login />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/companies" replace />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/overview" element={<Overview />} />
        </Route>
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
