import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || ''
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export function isSupabaseConfigured() {
  return Boolean(url && anon)
}

/** Подсказка, если в .env остались значения из примера — запросы к Auth упадут с «Failed to fetch». */
export function getSupabaseEnvWarning() {
  if (!url || !anon) return null
  const urlBad = /YOUR_PROJECT|xxx\.supabase|example\.com/i.test(url)
  const keyBad = /^your_anon_key$/i.test(anon.trim()) || /^paste_your/i.test(anon.trim())
  if (urlBad || keyBad) {
    return 'В .env всё ещё шаблон из .env.example: укажите реальный Project URL и anon public key (Supabase → Settings → API), затем перезапустите npm run dev.'
  }
  return null
}

/**
 * Сообщения Auth из сети (Failed to fetch) — не информативны; подменяем на шаги проверки.
 * @param {import('@supabase/supabase-js').AuthError | Error | null} err
 */
export function normalizeAuthError(err) {
  if (!err) return err
  const msg = err.message || String(err)
  const isNetwork =
    msg === 'Failed to fetch' ||
    /load failed|networkerror|network request failed|fetch/i.test(msg) ||
    err.name === 'TypeError'
  if (isNetwork) {
    return new Error(
      'Не удалось связаться с Supabase. Проверьте: 1) в .env реальный VITE_SUPABASE_URL вида https://xxxx.supabase.co; 2) проект не на паузе (Dashboard); 3) после правки .env выполните полный перезапуск dev-сервера; 4) VPN/браузер не блокирует запросы.',
    )
  }
  return err
}

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let clientSingleton = null

export function getSupabase() {
  if (!isSupabaseConfigured()) return null
  if (!clientSingleton) {
    clientSingleton = createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }
  return clientSingleton
}
