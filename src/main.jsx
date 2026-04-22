import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DevSyncBanner } from './components/DevSyncBanner.jsx'
import { LocalMockBanner } from './components/LocalMockBanner.jsx'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { isDevLoginAny, isOfflineDevMode } from './lib/localDev.js'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <>
      <AuthProvider>
        {import.meta.env.DEV && !isOfflineDevMode() ? <DevSyncBanner /> : null}
        {import.meta.env.DEV && isOfflineDevMode() ? <LocalMockBanner devLoginAny={isDevLoginAny()} /> : null}
        <App />
      </AuthProvider>
      {import.meta.env.DEV ? (
        <div
          className="dev-mode-indicator"
          title="Адрес dev-сервера — как в терминале после npm run dev. Если порт 5173 занят, сначала закройте другой процесс."
        >
          DEV · {typeof window !== 'undefined' ? window.location.origin : 'Vite'}
        </div>
      ) : null}
    </>
  </StrictMode>,
)
