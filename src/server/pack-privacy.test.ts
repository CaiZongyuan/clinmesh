import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('keeps the source bundles out of the development web server', async () => {
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    await server.listen();
    const origin = server.resolvedUrls!.local[0]!;
    for (const packId of ['global-general', 'cn-cardiology']) {
      const response = await fetch(new URL(`data/packs/${packId}/pack.json`, origin));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('caseTruth');
    }
  } finally { await server.close(); }
});
