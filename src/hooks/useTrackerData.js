import { useCallback, useEffect, useState } from 'react'
import { isOfflineDevMode } from '../lib/localDev.js'
import { fetchProfiles, fetchProjectsTree } from '../lib/trackerApi.js'

const USER_AVATAR_COLORS = ['#60d812', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6']

function profileToAppUser(p) {
  const hash = [...p.id].reduce((a, c) => a + c.charCodeAt(0), 0)
  return {
    id: p.id,
    name: p.name || '—',
    avatarUrl: p.avatar_url || undefined,
    avatarColor: USER_AVATAR_COLORS[Math.abs(hash) % USER_AVATAR_COLORS.length],
  }
}

/**
 * Данные из Supabase или из офлайн-мока (VITE_LOCAL_DEV_MOCK / VITE_DEV_LOGIN_ANY). Realtime отключён.
 * @param {import('@supabase/supabase-js').SupabaseClient | null} supabase
 * @param {string | null} userId
 * @param {boolean} enabled
 */
export function useTrackerData(supabase, userId, enabled) {
  const [topics, setTopics] = useState([])
  const [projects, setProjects] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    if (!supabase && !isOfflineDevMode()) {
      setLoading(false)
      return
    }
    try {
      const client = supabase
      const [tree, profs] = await Promise.all([fetchProjectsTree(client), fetchProfiles(client)])
      setTopics(tree.topics ?? [])
      setProjects(tree.projects ?? [])
      setUsers((profs ?? []).map(profileToAppUser))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [supabase, enabled])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setTopics([])
      setProjects([])
      setUsers([])
      return
    }
    if (!supabase && !isOfflineDevMode()) {
      setLoading(false)
      setTopics([])
      setProjects([])
      setUsers([])
      return
    }
    setLoading(true)
    void refresh()
  }, [enabled, refresh, supabase])

  return { topics, projects, users, loading, refresh }
}
