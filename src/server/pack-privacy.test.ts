import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createServer, isFileLoadingAllowed, normalizePath, preview } from 'vite';
import { expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../..');
const marker = 'synthetic-private-artifact-marker';

it('serves the client entry and HMR while keeping private files outside the dev allowlist', async () => {
  const directory = mkdtempSync(join(repository, 'node_modules', '.clinical-web-'));
  const artifact = join(directory, 'sibling-artifact.txt');
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    await server.listen();
    const origin = server.resolvedUrls!.local[0]!;
    const page = await fetch(origin).then(response => response.text());
    expect(page.includes('src="/main.tsx"') && page.includes('/@vite/client')).toBe(true);
    for (const url of ['/main.tsx', '/@vite/client']) {
      const response = await fetch(new URL(url, origin));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('javascript');
    }
    expect((await fetch(new URL('/dev/ui-kit', origin))).status).toBe(200);
    const privateFiles = [
      'dist/worker.bundle', 'dist/server/node-server.js', 'src/server/builtin-data-packs.ts', 'src/web/App.test.tsx',
      'src/packages/data-pack/tests/compiler.test.ts', 'data/packs/global-general/pack.json', 'data/packs/cn-cardiology/pack.json',
      '.data/workspace.sqlite', artifact,
    ];
    for (const file of privateFiles) {
      expect(isFileLoadingAllowed(server.config, normalizePath(resolve(repository, file))), basename(file)).toBe(false);
    }
    writeFileSync(artifact, marker);
    expect(isFileLoadingAllowed(server.config, normalizePath(artifact))).toBe(false);
    const bytes = await fetch(new URL(`node_modules/${basename(directory)}/sibling-artifact.txt`, origin)).then(response => response.text());
    expect(bytes.includes(marker)).toBe(false);
  } finally {
    await server.close();
    rmSync(directory, { force: true, recursive: true });
  }
}, 30_000);

it('previews only the client build alongside a synthetic server artifact', async () => {
  const directory = mkdtempSync(join(repository, 'node_modules', '.clinical-preview-'));
  const client = join(directory, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'public.json'), JSON.stringify({ name: 'Synthetic clinic' }));
  writeFileSync(join(directory, 'private.txt'), marker);
  const server = await preview({ logLevel: 'silent', build: { outDir: client }, preview: { host: '127.0.0.1', port: 0 } });
  try {
    const origin = server.resolvedUrls!.local[0]!;
    expect(await fetch(new URL('public.json', origin)).then(response => response.json())).toEqual({ name: 'Synthetic clinic' });
    expect((await fetch(new URL('private.txt', origin)).then(response => response.text())).includes(marker)).toBe(false);
  } finally {
    await server.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
