import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Phase 5.1: `vite preview` (and `vite` when VITE_API_URL=/api) proxies /api to the local API, so the
// production bundle can be tried locally with the same same-origin /api path that the hosting
// rewrite provides in production (see vercel.json). Override the target with SUBSENSE_API_PROXY.
const apiProxy = {
  '/api': { target: process.env.SUBSENSE_API_PROXY || 'http://localhost:5000', changeOrigin: false },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
})
