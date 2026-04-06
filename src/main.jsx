import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './contexts/AuthContext.jsx'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <>
      <AuthProvider>
        <App />
      </AuthProvider>
      {import.meta.env.DEV ? (
        <div className="dev-mode-indicator" title="Сборка Vite dev — если не видите изменений, сделайте жёсткое обновление (Cmd+Shift+R)">
          DEV · Vite
        </div>
      ) : null}
    </>
  </StrictMode>,
)
