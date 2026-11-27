import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const client = resolve(root, 'src/web');
const clientCache = resolve(root, 'node_modules/.vite-client');

export default defineConfig(({ isSsrBuild }) => ({
  root: isSsrBuild ? root : client,
  publicDir: isSsrBuild ? false : resolve(root, 'assets/clinical-public'),
  cacheDir: clientCache,
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(root, isSsrBuild ? 'dist/server' : 'dist/client'), emptyOutDir: true, manifest: !isSsrBuild },
  server: {
    fs: {
      allow: [client, clientCache],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.{test,spec}.*', '**/tests/**'],
    },
    proxy: { '/api': `http://${process.env.CLINMESH_HOST ?? '127.0.0.1'}:${process.env.CLINMESH_PORT ?? '51868'}` },
  },
}));
