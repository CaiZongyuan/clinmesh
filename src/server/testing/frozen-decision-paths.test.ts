import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createNodeSqliteStore } from '../../packages/store';
import { encounterViewSchema, workspaceSchema } from '../../packages/clinical-core';
import { directorySchema, wardViewSchema } from '../../packages/mod-inpatient';
import { builtinModules } from '../builtin-modules';
import { createWorkspaceApp } from '../workspace';

async function openFrozen(file: string, hash: string) {
  const encoded = readFileSync(new URL(`./fixtures/${file}.json.gz.b64`, import.meta.url), 'utf8');
  const previous = z.object({ format: z.string(), workspaceId: z.uuidv7(), tables: z.array(z.object({ name: z.string(), rows: z.array(z.json()) })), pi: z.array(z.json()), sha256: z.literal(hash) }).parse(JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString()));
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  await store.importLogicalSnapshot(previous);
  const upgraded = await store.exportLogicalSnapshot(previous.workspaceId);
  expect(upgraded.format).toBe('clinmesh.snapshot.v9');
  expect(upgraded.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
  expect(upgraded.pi).toEqual(previous.pi);
  const { at, ticket, encounterId } = await store.read(reader => {
    const at = { workspaceId: previous.workspaceId, epoch: reader.listEpochs(previous.workspaceId)[0]!.epoch };
    const session = reader.list(at, 'visitor_sessions')[0]!;
    return { at, ticket: { kind: 'visitor' as const, workspaceId: at.workspaceId, id: session.id, expiresAt: session.expires_at }, encounterId: reader.list(at, 'encounters')[0]!.id };
  });
  const app = createWorkspaceApp(store, { localOpen: true }, builtinModules);
  const request = (path: string, init?: RequestInit) => app.request(path, init, { credential: { ticket }, entering: false });
  const get = async (path: string) => (await request(path)).json();
  const send = (path: string, expectedVersion: number, fields = {}, idempotencyKey = crypto.randomUUID()) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, expectedVersion, epoch: at.epoch, idempotencyKey }) });
  return { store, at, encounterId, get, send };
}

it('completes the genuine 1.2.0 encounter using its previously signed and acknowledged ECG and troponin', async () => {
  const host = await openFrozen('4cd73c40-g02-v5', '717dbd6a4dd65c2644111a4cb54c94863b6337f59d0402ec412169564ed08c3f');
  try {
    const path = `/api/his/encounters/${host.encounterId}`;
    expect(workspaceSchema.parse(await host.get('/api/workspace')).manifest.version).toBe('1.2.0');
    const encounter = encounterViewSchema.parse(await host.get(path));
    expect(encounter.completion.ready).toBe(true);
    const completed = await host.send(`${path}/complete`, encounter.version);
    expect([completed.status, await completed.json()]).toEqual([200, { version: encounter.version + 1 }]);
  } finally { await host.store.close(); }
});

it('projects the signed order and immutable pharmacy handover once for a resumed v8 ward admission', async () => {
  const host = await openFrozen('aabef5a1-c02-v8', '2943217062f8817ca65488766a3efd219d4687b91527614c629d411f071caede');
  try {
    const wardPath = `/api/his/ward/${host.encounterId}`;
    const view = async () => wardViewSchema.parse(await host.get(wardPath));
    const act = async (name: string, fields: object) => {
      const ws = workspaceSchema.parse(await host.get('/api/workspace'));
      const op = ws.operations.find(op => op.name === name)!;
      const response = await host.send(op.path.replace(':id', host.encounterId), name === 'workspace.role' ? ws.sessionVersion : (await view()).version, fields);
      expect(response.status, name).toBe(200); return z.record(z.string(), z.json()).parse(await response.json());
    };
    const directory = directorySchema.parse(await host.get('/api/his/ward'));
    const order = await act('ward.order.sign', { itemId: directory.items.find(row => row.code === 'atorvastatin')!.id, dose: 20, route: 'PO', duration: 'temporary', frequency: 'ONCE' });
    await act('workspace.role', { roleId: 'ward-nurse' }); await act('ward.order.verify', { orderIds: [order.orderId] });
    const task = (await view()).tasks.find(row => row.orderId === order.orderId)!;
    await act('workspace.role', { roleId: 'ward-pharmacist' }); await act('ward.task.dispense', { taskIds: [task.id] });
    await act('workspace.role', { roleId: 'cardiologist' });
    expect(await host.get(`/fhir/R5/MedicationRequest?encounter=${host.encounterId}`)).toMatchObject({ total: 1, entry: [{ resource: { id: order.orderId, dosageInstruction: [{ timing: { repeat: { count: 1 } }, route: { text: 'PO' }, doseAndRate: [{ doseQuantity: { value: 20, unit: 'mg' } }] }] } }] });
    expect(await host.get(`/fhir/R5/MedicationDispense?encounter=${host.encounterId}`)).toMatchObject({ total: 1, entry: [{ resource: { authorizingPrescription: [{ reference: `MedicationRequest/${order.orderId}` }], quantity: { value: 2 } } }] });
    await host.store.read(reader => {
      expect(reader.get(host.at, 'ward_order_directions', String(order.orderId))?.frequency).toBe('ONCE');
      expect(reader.list(host.at, 'ward_incurred_orders', { task_id: task.id })).toHaveLength(1);
      expect(reader.list(host.at, 'ward_deliveries', { task_id: task.id })).toHaveLength(1);
    });
  } finally { await host.store.close(); }
});

it('retains v8 bed, material, report and surgery facts and enforces PCI quality in the active old cardiology pack', async () => {
  const host = await openFrozen('aabef5a1-c02-v8', '2943217062f8817ca65488766a3efd219d4687b91527614c629d411f071caede');
  try {
    const ws = workspaceSchema.parse(await host.get('/api/workspace'));
    expect(ws.manifest.version).toBe('1.4.0');
    const wardPath = `/api/his/ward/${host.encounterId}`;
    const before = wardViewSchema.parse(await host.get(wardPath));
    expect(before).toMatchObject({ patient: '周秀兰', bed: 'heart-01', surgeries: [{ status: 'standby-pci', report: { observations: expect.arrayContaining([expect.objectContaining({ code: 'LAD-FFR', value: 0.86 })]) } }] });
    const directory = directorySchema.parse(await host.get('/api/his/ward'));
    const item = (code: string) => directory.items.find(row => row.code === code)!.id;
    const path = ws.operations.find(op => op.name === 'ward.surgery.convert-to-pci')!.path.replace(':id', host.encounterId);
    const refused = await host.send(path, before.version, { requestId: before.surgeries[0]!.id, procedureId: item('36.0700'), materials: [{ itemId: item('des-3x18'), quantity: 1 }] });
    expect([refused.status, await refused.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'PCI_NON_ISCHEMIC_LESION' } }]);
    expect(wardViewSchema.parse(await host.get(wardPath))).toEqual(before);
    const endpoint = (name: string) => ws.operations.find(op => op.name === `ward.surgery.${name}`)!.path.replace(':id', host.encounterId);
    expect((await host.send(endpoint('finalize-standby'), before.version, { requestId: before.surgeries[0]!.id })).status).toBe(200);
    const completed = wardViewSchema.parse(await host.get(wardPath));
    const decision = { procedureId: item('36.0700'), type: 'elective', plannedAt: ws.virtualTime, location: 'cath-lab', surgeon: 'cv-staff-01', anesthesia: 'local', reason: 'Individualized review of coronary physiology', preopOrderPolicy: 'continue-active', materials: [{ itemId: item('des-3x18'), quantity: 1 }] };
    const blocked = await host.send(endpoint('request'), completed.version, decision);
    expect([blocked.status, await blocked.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'PCI_NON_ISCHEMIC_LESION' } }]);
    expect(await host.store.read(reader => reader.list(host.at, 'clinical_overrides'))).toEqual([]);
    const key = crypto.randomUUID();
    const approve = () => host.send(endpoint('request'), completed.version, { ...decision, clinicalOverride: { reasonCode: 'specialist-judgment', note: 'Documented individualized lesion review.', ruleCodes: ['PCI_NON_ISCHEMIC_LESION'] } }, key);
    const first = await approve(); expect(first.status).toBe(200);
    expect(await (await approve()).json()).toEqual(await first.json());
    await host.store.read(reader => {
      expect(reader.list(host.at, 'clinical_overrides')).toMatchObject([{ rule_code: 'PCI_NON_ISCHEMIC_LESION' }]);
      expect(reader.list(host.at, 'audit_events', { operation: 'clinical.override' })).toHaveLength(1);
    });
  } finally { await host.store.close(); }
});
