import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { teachingGate, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { wardClient } from './ward-client';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { createNodeSqliteStore } from '../../store';
import { createInpatientModule } from '../index';
import { encounterViewSchema } from '../../clinical-core';

async function pciJourney(request: Parameters<typeof wardClient>[0]) {
  const ward = await wardClient(request);
  const encounter = await ward.admit('赵德明');
  const read = () => ward.get(`/api/his/ward/${encounter}`);
  const act = async (name: string, fields = {}) => ward.send(`ward.${name}`, encounter, z.int().parse((await read()).version), fields);
  await ward.role('ward-nurse');
  await act('bed.assign', { bed: 'heart-01' });
  await ward.role('cardiologist');
  await act('diagnose', { diagnoses: [{ codeSystem: 'urn:clinmesh:reference:nhsa-diagnosis', code: 'I25.103', primary: true, ordinal: 1, poa: 'Y' }] });
  const items = z.array(z.object({ id: z.string(), code: z.string() })).parse((await ward.get('/api/his/ward')).items);
  const item = (code: string) => items.find(item => item.code === code)!.id;
  const prescription = await act('order.sign', { itemId: item('atorvastatin'), duration: 'long', frequency: 'QN', dose: 10, route: 'PO' });
  const { requestId } = await act('surgery.request', { procedureId: item('88.5500'), type: 'elective', plannedAt: ward.current().virtualTime, location: 'cath-lab', surgeon: 'cv-staff-01', anesthesia: 'local', reason: 'Assess coronary anatomy', preopOrderPolicy: 'stop-on-completion', standbyAdHocPci: true });
  await expect(act('surgery.start', { requestId })).rejects.toThrow('SURGERY_NOT_READY');
  await act('surgery.consent', { requestId, diagnosisRevision: 1, signer: 'Patient', risks: 'Contrast and intervention risks discussed' });
  await ward.role('ward-nurse');
  await act('surgery.check', { requestId, checklist: 'Patient, procedure and access confirmed' });
  await ward.role('cardiologist');
  await act('surgery.execute', { requestId });
  expect(await read()).toMatchObject({ surgeries: [{ status: 'standby-pci', report: { observations: expect.arrayContaining([expect.objectContaining({ code: 'LAD-FFR', value: 0.74 })]) } }], orders: [{ status: 'signed' }] });
  await act('surgery.convert-to-pci', { requestId, procedureId: item('36.0700'), materials: [{ itemId: item('des-3x18'), quantity: 1 }] });
  await act('surgery.start', { requestId });
  const { useId } = await act('surgery.record-material', { requestId, itemId: item('des-3x18'), quantity: 1 });
  await expect(act('surgery.correct-material', { requestId, useId, quantity: 1 })).rejects.toThrow();
  const beforeCorrection = await act('surgery.preview-completion', { requestId });
  await act('surgery.correct-material', { requestId, useId, quantity: 1, note: 'A second check confirmed the unit was unopened' });
  await expect(act('surgery.complete', { requestId, fingerprint: beforeCorrection.fingerprint })).rejects.toThrow('STALE_SURGERY_PREVIEW');
  await expect(act('surgery.complete', { requestId, fingerprint: (await act('surgery.preview-completion', { requestId })).fingerprint })).rejects.toThrow('SURGERY_NOTE_REQUIRED');
  await act('surgery.record-material', { requestId, itemId: item('des-3x18'), quantity: 1 });
  const preview = await act('surgery.preview-completion', { requestId });
  expect(preview.autoStop).toEqual([prescription.orderId]);
  await act('surgery.complete', { requestId, fingerprint: preview.fingerprint });
  expect(await read()).toMatchObject({ surgeries: [{ status: 'completed', stages: [{ stage: 'planned' }, { stage: 'ad-hoc-pci' }], postoperative: expect.arrayContaining([expect.objectContaining({ code: 'aspirin' })]) }], orders: [{ status: 'stop-requested' }] });
  await act('surgery.acknowledge', { requestId });
  await ward.role('cardiologist');
  const discharge = async () => {
    if (!ward.current().enabledModules.includes('mod-cds')) return act('discharge.issue');
    await expect(act('discharge.issue')).rejects.toThrow('CLINICAL_QUALITY_ALERT');
    const version = z.int().parse((await read()).version), key = crypto.randomUUID();
    const fields = { clinicalOverride: { reasonCode: 'specialist-judgment', note: 'Teaching specialist reviewed bleeding risk and arranged a medication reassessment.', ruleCodes: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'] } };
    const approved = await ward.send('ward.discharge.issue', encounter, version, fields, key);
    expect(await ward.send('ward.discharge.issue', encounter, version, fields, key)).toEqual(approved);
  };
  await discharge();
  await ward.role('ward-nurse');
  await expect(act('discharge.depart')).rejects.toThrow('DISCHARGE_BLOCKED');
  await act('order.verify-stop', { orderIds: [prescription.orderId] });
  await act('discharge.depart');
  expect(await read()).toMatchObject({ status: 'departed', bed: 'heart-01', finance: { canClearBed: false } });
  await expect(act('discharge.clear')).rejects.toThrow('SETTLEMENT_REQUIRED');
  await ward.role('cardiologist'); await act('discharge.recall', { reason: 'Review new symptoms' });
  await discharge(); await ward.role('ward-nurse'); await act('discharge.depart');
  await ward.role('payer-reviewer');
  const bill = () => ward.get(`/api/his/encounters/${encounter}/billing`);
  const funds = async (name: string, fields = {}) => ward.send(name, encounter, z.int().parse((await bill()).version), fields);
  const account = await bill();
  expect(account).toMatchObject({ unpostedSources: [], netMinor: 346000, balanceMinor: 346000 });
  const pay = await funds('inpatient.deposit.preview', { amountMinor: account.balanceMinor });
  await funds('inpatient.deposit.confirm', { commitToken: pay.commitToken });
  const settlement = await funds('inpatient.settlement.preview');
  await funds('inpatient.discharge.settle', { commitToken: settlement.commitToken });
  await ward.role('cardiologist'); await expect(act('discharge.recall', { reason: 'Late recall' })).rejects.toThrow('SETTLEMENT_LOCKED');
  await ward.role('ward-nurse'); await act('discharge.clear');
  expect(await read()).toMatchObject({ status: 'cleared', bed: null, clinical: 'active' });
  await ward.role('cardiologist'); await act('chart.submit', { summary: 'Intervention concluded', disposition: 'Home', followUp: 'Cardiac clinic' });
  await ward.role('records-coder'); await act('chart.review', { revision: 1, coding: 'Primary diagnosis and procedures checked' });
  await expect(act('chart.archive', { revision: 1 })).rejects.toThrow('CLINICAL_COMPLETION_REQUIRED');
  await ward.role('cardiologist');
  const visit = encounterViewSchema.parse(await ward.get(`/api/his/encounters/${encounter}`));
  await expect(ward.send('encounter.complete', encounter, visit.version)).rejects.toThrow('COMPLETION_BLOCKED');
  const fields = Object.fromEntries(visit.template.filter(field => field.required).map(field => [field.id, `Reviewed ${field.id} for PCI discharge`]));
  await ward.send('record.draft', encounter, visit.version, { fields, expectedDraftVersion: visit.draftVersion });
  await ward.send('record.sign', encounter, visit.version + 1);
  await ward.send('encounter.complete', encounter, visit.version + 2);
  await ward.role('records-coder'); await act('chart.archive', { revision: 1 });
  expect(await read()).toMatchObject({ status: 'cleared', bed: null, clinical: 'completed', chart: { state: 'archived', archive: { patient: '赵德明', revision: 1 } } });
  await ward.role('cardiologist'); await expect(act('order.request-stop', { orderIds: [prescription.orderId] })).rejects.toThrow('CHART_ARCHIVED');
}

it('completes the PCI admission, first settlement and immutable chart over Node HTTP', () => withNodeWorkspace(origin => pciJourney((path, init) => fetch(origin + path, init)), false, { CLINMESH_PORT: '51963' }), 60_000);
it('completes the same PCI journey through the deployed Worker entrypoint and DO SQLite', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const host = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try {
    await host.listen();
    const worker = host.getWorker();
    await pciJourney(async (path, init) => worker.fetch(path, init));
  } finally { await host.close(); }
}, 60_000);

it('retains the departed bed until one CAS clear succeeds when the billing module is absent', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const modules = [createInpatientModule()];
    const settings = { ...teachingGate, loadSigningSecret: () => store.visitorSigningSecret() };
    const service = createWorkspaceApp(store, settings, modules);
    const app = createApp('node', settings, (request, credential, entering) => service.fetch(request, { credential, entering }), modules);
    const ward = await wardClient(async (path, init) => app.request(path, init));
    const encounter = await ward.admit('赵德明');
    await ward.role('ward-nurse'); await ward.send('ward.bed.assign', encounter, 1, { bed: 'heart-01' });
    await ward.role('cardiologist');
    await ward.send('ward.diagnose', encounter, 2, { diagnoses: [{ codeSystem: 'urn:clinmesh:reference:nhsa-diagnosis', code: 'I25.103', ordinal: 1, primary: true, poa: 'Y' }] });
    await ward.send('ward.discharge.issue', encounter, 3);
    await ward.send('ward.discharge.recall', encounter, 4, { reason: 'Recheck before leaving ward' });
    await ward.send('ward.discharge.issue', encounter, 5);
    await ward.role('ward-nurse'); await ward.send('ward.discharge.depart', encounter, 6);
    expect(await ward.get(`/api/his/ward/${encounter}`)).toMatchObject({ bed: 'heart-01', finance: { canClearBed: true, locked: false } });
    const attempts = await Promise.allSettled([ward.send('ward.discharge.clear', encounter, 7), ward.send('ward.discharge.clear', encounter, 7)]);
    expect(attempts.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await ward.get(`/api/his/ward/${encounter}`)).toMatchObject({ status: 'cleared', bed: null });
  } finally { await store.close(); }
});
