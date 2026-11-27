import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { teachingGate, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { studyViewSchema } from '../../diagnostic-studies';
import { wardClient } from './ward-client';

async function operativePathology(http: Parameters<typeof wardClient>[0]) {
  const ward = await wardClient(http, 'diagnostic-teaching');
  await ward.role('clinician');
  const source = ward.current().cases[0]!;
  const encounter = z.string().parse((await ward.send('ward.register', source.id, 0, { ward: 'surgical-ward' })).encounterId);
  const read = () => ward.get(`/api/his/ward/${encounter}`);
  const act = async (operation: string, fields = {}) => ward.send(`ward.${operation}`, encounter, z.int().parse((await read()).version), fields);
  await ward.role('surgical-nurse'); await act('bed.assign', { bed: 'surgical-01' });
  await ward.role('clinician');
  const items = z.array(z.object({ code: z.string(), id: z.uuidv7() })).parse((await ward.get('/api/his/ward')).items);
  const operate = async (code: string) => {
    const procedureId = items.find(item => item.code === code)!.id;
    const { requestId } = await act('surgery.request', { procedureId, type: 'elective', plannedAt: ward.current().virtualTime, surgeon: 'teaching-surgeon', location: 'clinic', anesthesia: 'local', reason: 'Review the chest wall nodule specimen', preopOrderPolicy: 'continue-active' });
    await act('surgery.consent', { requestId, signer: 'Ellis Rowan', diagnosisRevision: 0, risks: 'Reviewed procedure and specimen risks' });
    await ward.role('surgical-nurse'); await act('surgery.check', { requestId, checklist: 'Confirmed procedure and patient' });
    await ward.role('clinician');
    return z.uuidv7().parse((await act('surgery.execute', { requestId })).executionId);
  };
  const path = `/api/his/encounters/${encounter}/pathology`;
  const study = () => ward.get(path).then(value => studyViewSchema.parse(value));
  const report = async (link: string) => {
    const view = await study();
    const encounterVersion = z.int().parse((await ward.get(`/api/his/encounters/${encounter}`)).version);
    const issued = await ward.send('pathology.issue', encounter, encounterVersion, { item: view.services[0]!.quote, priorSurgeryId: link });
    const orderId = z.uuidv7().parse(issued.orderId);
    await ward.send('pathology.accept', orderId, 1); await ward.send('pathology.start', orderId, 2);
    await ward.send('pathology.report-now', orderId, 3);
    return (await study()).orders.find(row => row.id === orderId)!;
  };
  const excision = await operate('NODULE-EXCISION');
  expect((await study()).completedSurgeries.map(row => row.id)).toContain(excision);
  const performed = await report(excision);
  expect(performed).toMatchObject({ priorSurgeryId: excision, status: 'reported', reports: [{ frameCount: 0, requireFirstFrame: false, sections: { diagnosis: { en: 'Benign encapsulated lipoma in this excision.' } } }] });
  await ward.send('pathology.acknowledge', performed.reports[0]!.id, 4, { reportVersion: 1, mode: 'text' });
  expect((await study()).orders.find(row => row.id === performed.id)?.reports[0]?.acknowledged).toMatchObject({ role: 'clinician' });
  const absent = await report(await operate('NODULE-BIOPSY'));
  expect(absent).toMatchObject({ status: 'generation-failed', reports: [] });
  const historical = await report('excision-01');
  expect(historical).toMatchObject({ priorSurgeryId: 'excision-01', reports: [{ sections: { diagnosis: { en: 'Lipoma of the chest wall.' } } }] });
}

it('binds authored pathology to the actual inpatient procedure over Node HTTP', () => withNodeWorkspace(origin => operativePathology((path, init) => fetch(origin + path, init)), false, { CLINMESH_PORT: '51965' }), 45_000);
it('binds the same operative specimens and text acknowledgements over Worker HTTP', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const host = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try { await host.listen(); const worker = host.getWorker(); await operativePathology((path, init) => worker.fetch(path, init)); }
  finally { await host.close(); }
}, 45_000);
