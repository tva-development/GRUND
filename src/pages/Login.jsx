import { useState } from 'react'

import AuthScreen from '../components/AuthScreen'
import { supabase } from '../lib/supabaseClient'

function Login() {
  const [pendingProvider, setPendingProvider] = useState(null)
  const [error, setError] = useState(null)

  async function handleSignIn(provider) {
    setError(null)
    setPendingProvider(provider)
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    })
    if (signInError) {
      setError(signInError.message)
      setPendingProvider(null)
    }
  }

  return (
    <AuthScreen heading="Sign in">
      <p style={{ marginBottom: 20 }}>
        Sign in with your student union&rsquo;s Google or Microsoft account.
      </p>
      {error && <p style={{ marginBottom: 16 }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button
          className="btn"
          onClick={() => handleSignIn('google')}
          disabled={pendingProvider !== null}
        >
          Continue with Google
        </button>
        <button
          className="btn"
          onClick={() => handleSignIn('azure')}
          disabled={pendingProvider !== null}
        >
          Continue with Microsoft
        </button>
      </div>
    </AuthScreen>
  )
}

export default Login
