import { getSupabaseProjectRef, isSupabaseConfigured } from '../lib/supabaseClient'

/**
 * В dev напоминает: приложение и «админка» (Supabase Dashboard / Table Editor) смотрят в одну БД.
 * Изоляция — отдельный проект Supabase + переменные в `.env.local`.
 */
export function DevSyncBanner() {
  if (!import.meta.env.DEV || !isSupabaseConfigured()) return null
  const ref = getSupabaseProjectRef()
  return (
    <div className="dev-sync-banner" role="status">
      <div className="dev-sync-banner__row">
        <strong className="dev-sync-banner__title">Локальная разработка</strong>
        {ref ? (
          <span className="dev-sync-banner__ref">
            Supabase: <code>{ref}</code>
          </span>
        ) : null}
      </div>
      <p className="dev-sync-banner__text">
        Клиент ходит в тот же проект, что вы открываете в Dashboard — отдельной «синхронизации» нет, это одна база.
        Чтобы не затрагивать данные продакшена при правках и фичах, создайте{' '}
        <strong>второй проект</strong> в Supabase и пропишите его <code>VITE_SUPABASE_URL</code> и{' '}
        <code>VITE_SUPABASE_ANON_KEY</code> в файле <code>.env.local</code> (он перекрывает <code>.env</code> и не
        коммитится).
      </p>
    </div>
  )
}
