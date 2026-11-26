import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { teachingGate, withNodeWorkspace } from '../../scripts/testing/node-workspace';
import { encounterViewSchema, workspaceSchema } from '../packages/clinical-core';
import { installHospitalDataPack } from '../packages/data-pack';
import { accountSchema } from '../packages/mod-billing';
import { labViewSchema } from '../packages/mod-lab';
import { createNodeSqliteStore } from '../packages/store';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';
import { builtinModules } from './builtin-modules';
import { createWorkspaceApp } from './workspace';

type Http = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
const object = z.record(z.string(), z.json());
function visitor(http: Http, cookie: string) {
  const headers = { cookie, 'content-type': 'application/json' };
  const read = async (path: string) => (await http(path, { headers })).json();
  const workspace = async () => workspaceSchema.parse(await read('/api/workspace'));
  const write = async (path: string, epoch: string, expectedVersion: number, fields = {}, method = 'POST', status = 200, idempotencyKey = v7()) => {
    const response = await http(path, { headers, method, body: JSON.stringify({ ...fields, epoch, expectedVersion, idempotencyKey }) });
    const body = object.parse(await response.json());
    expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(status);
    return body;
  };
  const role = async (roleId: string) => {
    const session = await workspace();
    return write('/api/workspace/role', session.epoch, session.sessionVersion, { roleId });
  };
  return { read, workspace, write, role };
}

async function investigation(client: ReturnType<typeof visitor>, encounterId: string, code: string) {
  const { epoch } = await client.workspace();
  const path = `/api/his/encounters/${encounterId}/lab`;
  const read = async () => labViewSchema.parse(await client.read(path));
  const service = (await read()).services.find(service => service.code === code)!;
  await client.write(`${path}/draft`, epoch, 0, { serviceIds: [service.id] }, 'PUT');
  const { draft } = await read();
  const key = v7();
  const issue = () => client.write(`${path}/issue`, epoch, draft.version, { items: draft.items }, 'POST', 200, key);
  const receipt = await issue();
  expect(await issue()).toEqual(receipt);
  const order = (await read()).orders[0]!;
  const operate = (action: string, version: number, expectedStatus = 200) => client.write(`/api/his/lab/orders/${order.id}/${action}`, epoch, version, {}, 'POST', expectedStatus);
  return { service, order, read, operate };
}

async function prepaid(http: Http) {
  const enter = await http('/api/auth/visitor/enter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  const client = visitor(http, enter.headers.get('set-cookie')!.split(';')[0]!);
  const initial = await client.workspace();
  await client.role('coordinator');
  await client.write('/api/workspace/reset', initial.epoch, initial.clockRevision, { packId: 'cn-cardiology' });
  await client.role('cardiologist');
  const { epoch, cases, diagnoses, tabs } = await client.workspace();
  expect(tabs.map(tab => tab.id)).toEqual(expect.arrayContaining(['lab', 'billing']));
  const patient = cases.find(item => item.encounterClass === 'outpatient')!;
  const encounter = await client.write(`/api/his/cases/${patient.id}/start-encounter`, epoch, 0);
  const id = z.uuidv7().parse(encounter.encounterId);
  const path = `/api/his/encounters/${id}`;
  const { template } = encounterViewSchema.parse(await client.read(path));
  const fields = Object.fromEntries(template.filter(field => field.required).map(field => [field.id, `Synthetic ${field.id}`]));
  await client.write(`${path}/clinical-record/draft`, epoch, 1, { expectedDraftVersion: 0, fields }, 'PUT');
  await client.write(`${path}/clinical-record/sign`, epoch, 2);
  const diagnosis = diagnoses[0]!;
  await client.write(`${path}/diagnosis/draft`, epoch, 3, { diagnoses: [{ codeSystem: diagnosis.codeSystem, code: diagnosis.code, primary: true }] }, 'PUT');
  await client.write(`${path}/diagnosis/confirm`, epoch, 4);
  const lab = await investigation(client, id, 'tni');
  expect(await lab.operate('accept', 1, 409)).toEqual({ code: 'PAYMENT_REQUIRED' });
  await client.role('payer-reviewer');
  const account = async () => accountSchema.parse(await client.read(`${path}/billing`));
  const funds = async (name: string, input: Record<string, unknown>) => client.write(`${path}/billing/${name}`, epoch, (await account()).version, input);
  const bill = await account();
  const charges = bill.charges.filter(charge => charge.orderId === lab.order.id);
  expect(charges).toHaveLength(1);
  expect(charges[0]).toMatchObject({ catalogItemId: lab.service.id, catalogVersion: '1.2.0', quantity: 1, unitPriceMinor: 8500, amountMinor: 8500, outstandingMinor: 8500 });
  expect(bill.currency.code).toBe('CNY');
  const preview = await funds('payment.preview', { chargeIds: [charges[0]!.id], simulation: 'delayed-approval' });
  const attempt = await funds('payment.confirm', { commitToken: preview.commitToken });
  expect(attempt.status).toBe('unknown');
  await client.role('cardiologist');
  expect(await lab.operate('accept', 1, 409)).toEqual({ code: 'PAYMENT_REQUIRED' });
  await client.role('payer-reviewer');
  await funds('payment.recover', { paymentId: attempt.paymentId, paymentVersion: 1 });
  expect((await account()).charges.find(charge => charge.id === charges[0]!.id)).toMatchObject({ netPaidMinor: 8500, outstandingMinor: 0, released: true });
  await client.role('cardiologist');
  await lab.operate('accept', 1); await lab.operate('start', 2); await lab.operate('report-now', 3);
  expect((await lab.read()).orders[0]!.reports[0]).toMatchObject({ observations: [{ value: 0.68, unit: 'ng/mL', interpretation: 'high' }] });
}

it('releases a prepaid CNY investigation only after real payment recovery over the native Node listener', async () => {
  await withNodeWorkspace(origin => prepaid((path, init) => fetch(origin + path, init)));
}, 30_000);

it('runs the same clinical and cashier HTTP loop through workerd and workspace DO SQLite', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try { await server.listen(); await prepaid((path, init) => server.getWorker().fetch(path, init)); } finally { await server.close(); }
}, 30_000);

it('accepts an order under a free policy with the production billing module installed', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const pack = structuredClone(BUILTIN_DATA_PACKS['global-general']);
  pack.manifest.policies.outpatientInvestigationBillingPolicy = 'free';
  const workspaceId = v7();
  const id = v7();
  const expiresAt = '2099-01-01T00:00:00Z';
  try {
    await store.withTransaction(tx => {
      const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-01-01T00:00:00Z' }, pack);
      tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'family-clinician', revoked: false, expires_at: expiresAt, version: 1 });
    });
    const app = createWorkspaceApp(store, { localOpen: true }, builtinModules);
    const client = visitor(async (path, init) => app.request(path, init, { credential: { ticket: { kind: 'visitor', workspaceId, id, expiresAt } }, entering: false }), '');
    const session = await client.workspace();
    expect(session.enabledModules).toContain('mod-billing');
    const patient = session.cases.find(item => item.demographics.name === 'Jordan Vale')!;
    const opened = await client.write(`/api/his/cases/${patient.id}/start-encounter`, session.epoch, 0);
    const encounterId = z.uuidv7().parse(opened.encounterId);
    const lab = await investigation(client, encounterId, 'hs-tni');
    await lab.operate('accept', 1); await lab.operate('start', 2); await lab.operate('report-now', 3);
    expect((await lab.read()).orders[0]!.reports[0]).toMatchObject({ observations: [{ value: 12, unit: 'ng/L' }] });
    await client.role('cashier');
    expect(accountSchema.parse(await client.read(`/api/his/encounters/${encounterId}/billing`))).toMatchObject({ policy: 'free', charges: [], balanceMinor: 0 });
  } finally { await store.close(); }
});
