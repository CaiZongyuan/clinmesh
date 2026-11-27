import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { checkBudget, limit, uploadMetrics } from './check-worker-size';

it('accepts the last byte below the Free budget and rejects equality and overflow', () => {
  expect(() => checkBudget(limit - 1)).not.toThrow();
  for (const bytes of [limit, limit + 1]) expect(() => checkBudget(bytes)).toThrow();
});

it('measures Wrangler side modules before the main module and excludes debug maps and multipart framing', async () => {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'worker.js' }));
  form.set('worker.js', new File(['export default {}'], 'worker.js', { type: 'application/javascript+module' }));
  form.set('data', new File(['teaching data'], 'data'));
  form.set('worker.js.map', new File(['debug only'], 'worker.js.map', { type: 'application/source-map' }));
  expect(await uploadMetrics(form)).toEqual({ modules: [{ name: 'data', bytes: 13 }, { name: 'worker.js', bytes: 17 }], raw: 30, gzip: gzipSync('teaching dataexport default {}').length });
});
