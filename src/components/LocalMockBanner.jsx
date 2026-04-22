import { resetLocalMockStore } from '../lib/localMockStore.js'

/** Плашка в dev при офлайн-режиме (мок или «любой вход»). */
export function LocalMockBanner({ devLoginAny = false }) {
  if (!import.meta.env.DEV) return null
  return (
    <div className="local-mock-banner" role="status">
      <div className="local-mock-banner__row">
        <strong>{devLoginAny ? 'Локальный вход' : 'Локальный мок'}</strong>
        <span>
          {devLoginAny
            ? 'Принимается любой email и пароль. Supabase не используется — данные в localStorage.'
            : 'Supabase не используется. Данные в браузере (localStorage).'}
        </span>
        <button
          type="button"
          className="local-mock-banner__reset"
          onClick={() => {
            resetLocalMockStore()
            window.location.reload()
          }}
        >
          Сбросить демо-данные
        </button>
      </div>
    </div>
  )
}
