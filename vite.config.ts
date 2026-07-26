import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    environmentMatchGlobs: [['**/*.dom.test.ts', 'happy-dom']],
    // P3.4: several files spin up their own Hocuspocus server + Postgres pool against one shared
    // DATABASE_URL (no per-test DB, matching CI's single services:postgres container). Parallel file
    // execution was racing bootstrapSchema and exhausting connections under load — serialize files to
    // keep the suite deterministic; it's cheap enough that wall-clock time isn't a real cost here.
    fileParallelism: false,
  },
})
