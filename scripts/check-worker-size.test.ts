import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { checkBudget, limit, uploadMetrics } from './check-worker-size';

it('accepts the last byte below the Free budget and rejects equality and overflow', () => {
  expect(() => checkBudget(limit - 1)).not.toThrow();
  for (const bytes of [limit, limit + 1]) expect(() => checkBudget(bytes)).toThrow();
});

it('measures Wrangler side modules before the main module and excludes debug maps and multipart framing', async () => {
  const form = new FormData();
  const side = 'abc'.repeat(20), main = 'abc'.repeat(15) + '1234'.repeat(15);
  form.set('metadata', JSON.stringify({ main_module: 'worker.js' }));
  form.set('worker.js', new File([main], 'worker.js', { type: 'application/javascript+module' }));
  form.set('data', new File([side], 'data'));
  form.set('worker.js.map', new File(['debug only'], 'worker.js.map', { type: 'application/source-map' }));
  expect(gzipSync(main + side).length).not.toBe(gzipSync(side + main).length);
  expect(await uploadMetrics(form)).toEqual({ modules: [{ name: 'data', bytes: side.length }, { name: 'worker.js', bytes: main.length }], raw: side.length + main.length, gzip: gzipSync(side + main).length });
});
