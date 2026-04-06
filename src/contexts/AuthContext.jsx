/* eslint-disable react-hooks/set-state-in-effect -- синхронизация состояния с Supabase Auth / профилем */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getSupabase, isSupabaseConfigured, normalizeAuthError } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  /** null | 'missing' | 'fetch_failed' — только при наличии session */
  const [profileError, setProfileError] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [loading, setLoading] = useState(true)

  const supabase = getSupabase()

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    let mounted = true
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return
      setSession(s)
      if (event === 'INITIAL_SESSION') setLoading(false)
    })
    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [supabase])

  useEffect(() => {
    if (!supabase || !session?.user?.id) {
      setProfile(null)
      setProfileError(null)
      setProfileLoading(false)
      return
    }
    let cancelled = false
    setProfileLoading(true)
    setProfileError(null)
    supabase
      .from('profiles')
      .select('id, name, avatar_url')
      .eq('id', session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setProfile(null)
          if (error.code === 'PGRST116') {
            setProfileError('missing')
          } else {
            setProfileError('fetch_failed')
          }
          setProfileLoading(false)
          return
        }
        if (!data) {
          setProfile(null)
          setProfileError('missing')
          setProfileLoading(false)
          return
        }
        setProfile(data)
        setProfileError(null)
        setProfileLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [supabase, session?.user?.id])

  const signIn = useCallback(
    async (email, password) => {
      if (!supabase) return { error: new Error('Supabase не настроен') }
      const result = await supabase.auth.signInWithPassword({ email, password })
      if (result.error) return { ...result, error: normalizeAuthError(result.error) }
      return result
    },
    [supabase],
  )

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setProfile(null)
    setProfileError(null)
  }, [supabase])

  const refreshProfile = useCallback(async () => {
    if (!supabase || !session?.user?.id) return
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, avatar_url')
      .eq('id', session.user.id)
      .single()
    if (error) {
      if (error.code === 'PGRST116') setProfileError('missing')
      else setProfileError('fetch_failed')
      return
    }
    if (data) {
      setProfile(data)
      setProfileError(null)
    }
  }, [supabase, session?.user?.id])

  const value = useMemo(
    () => ({
      supabase,
      configured: isSupabaseConfigured(),
      session,
      profile,
      profileError,
      profileLoading,
      loading,
      signIn,
      signOut,
      refreshProfile,
    }),
    [supabase, session, profile, profileError, profileLoading, loading, signIn, signOut, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- хук рядом с провайдером
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
