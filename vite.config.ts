import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/client' },
  server: { proxy: { '/api': `http://${process.env.CLINMESH_HOST ?? '127.0.0.1'}:${process.env.CLINMESH_PORT ?? '51868'}` } },
});
