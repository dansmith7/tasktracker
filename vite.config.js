import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Если 5173 занят, Vite поднимает следующий порт — без этого `strictPort` роняет `npm run dev` и «ничего не открывается». */
function warnIfNotDefaultPort() {
  const wanted = 5173
  return {
    name: 'warn-if-not-default-port',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address()
        if (addr && typeof addr === 'object' && addr.port != null && addr.port !== wanted) {
          console.warn(
            `\n\x1b[33m⚠  Порт ${wanted} занят — откройте в браузере именно этот адрес:\x1b[0m\n\x1b[32m   http://localhost:${addr.port}/\x1b[0m\n`,
          )
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), warnIfNotDefaultPort()],
  server: {
    port: 5173,
    strictPort: false,
    open: true,
  },
  envDir: '.',
})
