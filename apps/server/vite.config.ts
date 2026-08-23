import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    ssr: 'src/index.ts',
    target: 'node22',
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
