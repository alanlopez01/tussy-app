import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      // En dev, las APIs pegan contra producción (tienen las credenciales)
      '/api': {
        target: 'https://tussy-app.vercel.app',
        changeOrigin: true,
      },
    },
  },
})
