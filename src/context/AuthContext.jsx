import { createContext, useContext, useEffect, useState } from 'react'

import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(undefined)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [appUser, setAppUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    async function loadAppUser(nextSession) {
      if (!nextSession) {
        if (active) setAppUser(null)
        return
      }
      const { data } = await supabase
        .from('app_user')
        .select('*')
        .eq('id', nextSession.user.id)
        .maybeSingle()
      if (active) setAppUser(data)
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      await loadAppUser(data.session)
      if (active) setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      await loadAppUser(nextSession)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  const value = {
    session,
    appUser,
    loading,
    signOut: () => supabase.auth.signOut(),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
