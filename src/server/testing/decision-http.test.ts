import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { teachingGate, withNodeDatabase } from '../../../scripts/testing/node-workspace';
import { openPharmacySession, type PharmacyHttp } from '../../../scripts/testing/pharmacy-session';
import { scoreViewSchema } from '../../packages/mod-cds';

async function checkDecisionHttp(transport: PharmacyHttp) {
  const session = await openPharmacySession(transport);
  const path = await session.start('Riley Dale', 'J06.9');
  expect(scoreViewSchema.parse(await session.get(`${path}/cds/scores`)).scores).toHaveLength(6);
  const lines = [{ codeSystem: 'urn:clinmesh:general:drug', code: 'doxycycline', dose: 100, routeCode: 'PO', timesPerDay: 1, days: 1, quantity: 1 }];
  const alert = await session.command(`${path}/prescriptions`, 5, { lines });
  expect([alert.status, await alert.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION' } }]);
  const clinicalOverride = { ruleCodes: ['ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION'], reasonCode: 'outside-result-verified', note: 'Reviewed documented outside culture.' };
  const key = crypto.randomUUID();
  const sign = () => session.command(`${path}/prescriptions`, 5, { lines, clinicalOverride }, 'POST', key);
  expect(await session.applied(sign())).toEqual(await session.applied(sign()));
  expect(await session.get('/fhir/R5/MedicationRequest')).toMatchObject({ resourceType: 'Bundle', total: 1, entry: [{ resource: { status: 'active', medication: { concept: { coding: [{ code: 'doxycycline' }] } } } }] });
  expect(await session.get('/fhir/R5/metadata')).toMatchObject({ resourceType: 'CapabilityStatement', fhirVersion: '5.0.0' });
  const unsupported = await transport('/fhir/R5/Patient', { method: 'PATCH', headers: { cookie: session.cookie } });
  expect([unsupported.status, unsupported.headers.get('allow'), await unsupported.json()]).toEqual([405, 'GET', expect.objectContaining({ resourceType: 'OperationOutcome' })]);
}

it('serves decision support and R5 through the native Node HTTP listener', async () => {
  const root = 'node_modules/.cache/clinmesh-decision-http';
  await mkdir(root, { recursive: true });
  await using directory = await mkdtempDisposable(join(root, 'node-'));
  await withNodeDatabase(join(directory.path, 'workspace.sqlite'), origin => checkDecisionHttp((path, init) => fetch(origin + path, init)));
}, 45000);

it('serves the same decision and projection through real workerd and Durable Object SQLite', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const harness = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    await checkDecisionHttp((path, init) => worker.fetch(path, init));
  } finally { await harness.close(); }
}, 45000);
