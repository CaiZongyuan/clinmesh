import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const client = resolve(root, 'src/web');
const clientCache = resolve(root, 'node_modules/.vite-client');

const browserGraph: Plugin = { name: 'browser-chunk-graph', apply: 'build', writeBundle(_options, bundle) {
  const chunks = Object.values(bundle).flatMap(chunk => chunk.type === 'chunk' ? [{ file: chunk.fileName, entry: chunk.isEntry, imports: chunk.imports, dynamicImports: chunk.dynamicImports,
    modules: Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => relative(root, id).replaceAll('\\', '/')) }] : []);
  writeFileSync(resolve(root, 'dist/browser-chunks.json'), JSON.stringify(chunks));
} };

export default defineConfig(({ isSsrBuild }) => ({
  root: isSsrBuild ? root : client,
  publicDir: isSsrBuild ? false : resolve(root, 'assets/clinical-public'),
  cacheDir: clientCache,
  plugins: [react(), tailwindcss(), !isSsrBuild && browserGraph],
  build: { outDir: resolve(root, isSsrBuild ? 'dist/server' : 'dist/client'), emptyOutDir: true },
  server: {
    fs: {
      allow: [client, clientCache],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.{test,spec}.*', '**/tests/**'],
    },
    proxy: { '/api': `http://${process.env.CLINMESH_HOST ?? '127.0.0.1'}:${process.env.CLINMESH_PORT ?? '51868'}` },
  },
}));
