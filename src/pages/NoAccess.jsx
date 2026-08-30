import AuthScreen from '../components/AuthScreen'
import { useAuth } from '../context/AuthContext'

function NoAccess() {
  const { signOut } = useAuth()

  return (
    <AuthScreen heading="No access">
      <p style={{ marginBottom: 20 }}>
        Your account isn&rsquo;t linked to a GRUND tenant yet. Ask your admin to add your email
        domain, then sign in again.
      </p>
      <button className="btn" onClick={signOut}>
        Sign out
      </button>
    </AuthScreen>
  )
}

export default NoAccess
