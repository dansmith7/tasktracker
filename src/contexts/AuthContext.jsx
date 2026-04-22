/* eslint-disable react-hooks/set-state-in-effect -- синхронизация состояния с Supabase Auth / профилем */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { DEV_LOCAL_USER_ID, isDevLoginAny, isLocalDevMock, isOfflineDevMode } from '../lib/localDev.js'
import { setDevProfileDisplayName } from '../lib/localMockStore.js'
import { getSupabase, isSupabaseConfigured, normalizeAuthError } from '../lib/supabaseClient'

const AuthContext = createContext(null)

const MOCK_PROFILE = {
  id: DEV_LOCAL_USER_ID,
  name: 'Локальная разработка',
  avatar_url: null,
}

const MOCK_SESSION = { user: { id: DEV_LOCAL_USER_ID } }

export function AuthProvider({ children }) {
  const localMock = isLocalDevMock()
  const devLoginAny = isDevLoginAny()
  const offlineDev = isOfflineDevMode()

  const [session, setSession] = useState(() => (localMock ? MOCK_SESSION : null))
  const [profile, setProfile] = useState(() => (localMock ? MOCK_PROFILE : null))
  /** null | 'missing' | 'fetch_failed' — только при наличии session */
  const [profileError, setProfileError] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [loading, setLoading] = useState(() => !offlineDev)

  const supabase = offlineDev ? null : getSupabase()

  useEffect(() => {
    if (offlineDev) {
      setLoading(false)
      return
    }
    if (!supabase) {
      setLoading(false)
      return
    }
    let mounted = true

    supabase.auth
      .getSession()
      .then(({ data: { session: s } }) => {
        if (!mounted) return
        setSession(s)
        setLoading(false)
      })
      .catch(() => {
        if (!mounted) return
        setLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!mounted) return
      setSession(s)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [offlineDev, supabase])

  useEffect(() => {
    if (offlineDev) return
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
  }, [offlineDev, supabase, session?.user?.id])

  const signIn = useCallback(
    async (email, password) => {
      if (localMock) {
        setSession(MOCK_SESSION)
        setProfile(MOCK_PROFILE)
        setProfileError(null)
        return { data: { session: MOCK_SESSION, user: MOCK_SESSION.user }, error: null }
      }
      if (devLoginAny) {
        const em = (email || '').trim()
        if (!em) return { error: new Error('Введите email') }
        const pwd = password ?? ''
        if (!String(pwd).trim()) {
          return { error: new Error('Введите пароль (в локальном режиме подойдёт любой)') }
        }
        const displayName = em.includes('@') ? em.split('@')[0].trim() || 'Dev' : em
        setDevProfileDisplayName(displayName)
        setSession(MOCK_SESSION)
        setProfile({ id: DEV_LOCAL_USER_ID, name: displayName, avatar_url: null })
        setProfileError(null)
        return { data: { session: MOCK_SESSION, user: MOCK_SESSION.user }, error: null }
      }
      if (!supabase) return { error: new Error('Supabase не настроен') }
      const result = await supabase.auth.signInWithPassword({ email, password })
      if (result.error) return { ...result, error: normalizeAuthError(result.error) }
      return result
    },
    [localMock, devLoginAny, supabase],
  )

  const signOut = useCallback(async () => {
    if (localMock) {
      setSession(MOCK_SESSION)
      setProfile(MOCK_PROFILE)
      setProfileError(null)
      return
    }
    if (devLoginAny) {
      setSession(null)
      setProfile(null)
      setProfileError(null)
      return
    }
    if (!supabase) return
    await supabase.auth.signOut()
    setProfile(null)
    setProfileError(null)
  }, [localMock, devLoginAny, supabase])

  const refreshProfile = useCallback(async () => {
    if (offlineDev) return
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
  }, [offlineDev, supabase, session])

  const value = useMemo(
    () => ({
      supabase,
      localDevMock: localMock,
      devLoginAny,
      offlineDev,
      configured: offlineDev || isSupabaseConfigured(),
      session,
      profile,
      profileError,
      profileLoading,
      loading,
      signIn,
      signOut,
      refreshProfile,
    }),
    [
      localMock,
      devLoginAny,
      offlineDev,
      supabase,
      session,
      profile,
      profileError,
      profileLoading,
      loading,
      signIn,
      signOut,
      refreshProfile,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- хук рядом с провайдером
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
