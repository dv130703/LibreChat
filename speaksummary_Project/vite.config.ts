import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // The Python backend (esp. backend/.venv) holds tens of thousands of
      // files and blows past the inotify watcher limit (ENOSPC) if watched.
      ignored: ['**/backend/**', '**/.git/**', '**/.venv/**'],
    },
    proxy: {
      // The API clients call same-origin '/api/...' so the browser never needs
      // to know the backend's host. Transcription of a long recording can run
      // for many minutes, so the proxy must not time the connection out.
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})
