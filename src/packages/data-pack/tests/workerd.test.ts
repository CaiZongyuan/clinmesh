import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { readHospitalDataPack } from '../index';

it('installs all bundled packs in workerd and returns only public case information', async () => {
  const server = createTestHarness({ workers: [{ config: {
    name: 'pack-example', main: 'src/packages/data-pack/tests/pack-worker.ts', compatibility_date: '2026-11-19',
    compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'WORKSPACE', class_name: 'PackWorkspace' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['PackWorkspace'] }],
  } }] });
  try {
    await server.listen();
    const response = await server.getWorker().fetch('/');
    expect(response.status).toBe(200);
    const views = await response.json() as NonNullable<ReturnType<typeof readHospitalDataPack>>[];
    expect(views.map(view => [view.manifest.packId, view.cases.length])).toEqual([['global-general', 4], ['cn-cardiology', 3], ['diagnostic-teaching', 1]]);
    expect(JSON.stringify(views)).not.toMatch(/phantom-[abc]\.png|caseTruth|hiddenHistory|patientPersona|reviewPoints|"SIM-G02".{0,300}"I21\.4"/u);
  } finally { await server.close(); }
}, 30_000);
