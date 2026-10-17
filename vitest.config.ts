import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  plugins: [react()],
  resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'] },
  test: { environment: 'jsdom', include: ['src/__verify__/**/*.test.tsx'], testTimeout: 15000, css: false },
})
