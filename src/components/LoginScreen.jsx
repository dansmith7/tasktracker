import { useState } from 'react'
import { getSupabaseEnvWarning } from '../lib/supabaseClient.js'

export function LoginScreen({ onSignIn, loading, devLoginAny = false }) {
  const envWarning = devLoginAny ? null : getSupabaseEnvWarning()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      const { error: err } = await onSignIn(email.trim(), password)
      if (err) setError(err.message || 'Ошибка входа')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-panel__head">
          <p className="auth-panel__eyebrow">Task tracker</p>
          <h1 className="heading-h1 auth-panel__title">Вход</h1>
          <p className="auth-panel__lede">
            {devLoginAny ? (
              <>
                <strong>Локальная разработка:</strong> подойдёт любой email и пароль. Данные не уходят в Supabase.
              </>
            ) : (
              <>Внутренний инструмент: вход только по учётной записи, выданной администратором.</>
            )}
          </p>
          {envWarning ? (
            <p className="auth-error auth-error--box" role="status">
              {envWarning}
            </p>
          ) : null}
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              placeholder="you@company.com"
            />
          </label>
          <label className="auth-field">
            <span>Пароль</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              minLength={devLoginAny ? 1 : 6}
              placeholder="••••••••"
            />
          </label>
          {error ? (
            <p className="auth-error auth-error--multiline" role="alert">
              {error}
            </p>
          ) : null}
          <div className="auth-actions">
            <button type="submit" className="btn-primary" disabled={pending || loading}>
              Войти
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
