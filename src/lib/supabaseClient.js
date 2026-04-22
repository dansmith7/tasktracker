import { createClient } from '@supabase/supabase-js'

/** Убирает пробелы и обрамляющие кавычки (часто попадают при вставке в Vercel). */
function normalizeEnvValue(raw) {
  if (raw == null) return ''
  let s = String(raw).trim()
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim()
  }
  return s
}

/** Supabase требует полный HTTP(S) URL; иначе createClient бросает «Invalid supabaseUrl». */
function isValidHttpUrl(s) {
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const url = normalizeEnvValue(import.meta.env.VITE_SUPABASE_URL)
const anon = normalizeEnvValue(import.meta.env.VITE_SUPABASE_ANON_KEY)

export function isSupabaseConfigured() {
  return Boolean(url && anon && isValidHttpUrl(url))
}

/** Ref проекта из hostname `xxxx.supabase.co` — для подсказок в dev, какой инстанс подключён. */
export function getSupabaseProjectRef() {
  if (!url || !isValidHttpUrl(url)) return null
  try {
    const host = new URL(url).hostname
    const m = /^([^.]+)\.supabase\.co$/i.exec(host)
    return m ? m[1] : host
  } catch {
    return null
  }
}

/** Подсказка, если остались явные плейсхолдеры из .env.example. */
export function getSupabaseEnvWarning() {
  if (!url || !anon) return null
  if (!isValidHttpUrl(url)) {
    return 'VITE_SUPABASE_URL должен быть полным адресом вида https://xxxx.supabase.co (без пробелов и лишних символов). После правки .env перезапустите npm run dev.'
  }
  const urlBad = /YOUR_PROJECT|xxx\.supabase|example\.com/i.test(url)
  const keyBad = /^your_anon_key$/i.test(anon) || /^paste_your/i.test(anon)
  if (urlBad || keyBad) {
    return 'Указаны шаблонные значения (YOUR_PROJECT / your_anon_key). Вставьте реальные Project URL и anon key из Supabase → Settings → API. Локально — в файл .env; на Vercel — Project → Settings → Environment Variables (имена VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY), затем Redeploy. Без этого файла на Vercel нет — только эти переменные.'
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
  if (/invalid login credentials|invalid credentials/i.test(msg)) {
    return new Error(
      'Неверный email или пароль. Если вы сменили проект в .env / .env.local, учётные записи в новом проекте другие — создайте пользователя в Supabase → Authentication → Users → Add user (или задайте пароль существующему там же).',
    )
  }
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
