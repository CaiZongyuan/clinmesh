import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    ssr: true,
    target: 'node22',
    rollupOptions: {
      external: ['better-sqlite3'],
      input: {
        'database-cli': 'src/database-cli.ts',
        index: 'src/index.ts',
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
