import { it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { teachingGate, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { c02Journey } from './cds-journey';

it('runs the c02 FFR, PCI, postoperative, discharge and settlement decisions through native Node', async () => {
  await withNodeWorkspace(origin => c02Journey((path, init) => fetch(origin + path, init)));
}, 60_000);

it('runs the same c02 decisions through workerd and Durable Object SQLite', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const harness = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try { await harness.listen(); await c02Journey((path, init) => harness.getWorker().fetch(path, init)); }
  finally { await harness.close(); }
}, 60_000);
