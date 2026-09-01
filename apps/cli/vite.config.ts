import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      fileName: () => 'clinmesh.js',
      formats: ['es'],
    },
    minify: false,
    rollupOptions: {
      external: builtinModules.flatMap(module => [module, `node:${module}`]),
    },
    sourcemap: true,
    target: 'node22',
  },
})
