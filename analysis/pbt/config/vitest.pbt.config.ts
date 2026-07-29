import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/pbt/**/*.pbt.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/test/pbt/provider/**'],
    fileParallelism: false,
  },
})
