/** Экран, если в auth есть пользователь, но нет строки в public.profiles */
export function ProfileMissingScreen({ message, onSignOut }) {
  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <h1 className="heading-h1 auth-panel__title">Профиль не найден</h1>
        <p className="auth-panel__lede auth-error auth-error--multiline" role="alert">
          {message}
        </p>
        <p className="auth-panel__hint muted">
          Аккаунты создаются администратором вручную. Должны существовать и запись в Authentication, и строка в таблице{' '}
          <code className="auth-inline-code">profiles</code>.
        </p>
        <div className="auth-actions">
          <button type="button" className="btn-primary" onClick={onSignOut}>
            Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
