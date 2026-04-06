import { useCallback, useEffect, useState } from 'react'
import { fetchProfiles, fetchProjectsTree } from '../lib/trackerApi'

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
 * Данные только из Supabase. Realtime и фоновый full-sync отключены — мутации в trackerApi + refresh().
 * @param {import('@supabase/supabase-js').SupabaseClient | null} supabase
 * @param {string | null} userId
 * @param {boolean} enabled
 */
export function useTrackerData(supabase, userId, enabled) {
  const [projects, setProjects] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!supabase || !enabled) {
      setLoading(false)
      return
    }
    try {
      const [tree, profs] = await Promise.all([fetchProjectsTree(supabase), fetchProfiles(supabase)])
      setProjects(tree)
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
      setProjects([])
      setUsers([])
      return
    }
    setLoading(true)
    void refresh()
  }, [enabled, refresh])

  return { projects, users, loading, refresh }
}
