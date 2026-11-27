import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { visitSchema } from '../packages/patient-visit';
import { encounterViewSchema, workspaceSchema } from '../packages/clinical-core';
import { accountSchema, previewSchema } from '../packages/mod-billing';
import { ModuleRegistry, OperationCatalog, registerPlatformOperations } from '../packages/platform';
import { teachingGate, withNodeWorkspace } from '../../scripts/testing/node-workspace';

type Http = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

async function exercise(fetchApi: Http, reopen?: (workspaceId: string) => Promise<void>) {
  for (const path of ['/api/his/encounters', '/api/sim/unknown', '/api/agents/unknown']) {
    const denied = await fetchApi(path);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ code: 'VISITOR_AUTH_REQUIRED' });
  }
  const enter = () => fetchApi('/api/auth/visitor/enter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  const gate = await enter();
  expect(gate.status).toBe(200);
  const cookie = gate.headers.get('set-cookie')!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
  const headers = { cookie: cookie.split(';')[0]!, 'content-type': 'application/json' };
  const workspace = workspaceSchema.parse(await (await fetchApi('/api/workspace', { headers })).json());
  const other = z.object({ workspaceId: z.string() }).parse(await (await enter()).json());
  expect(workspace.workspaceId).not.toBe(other.workspaceId);
  await reopen?.(workspace.workspaceId);
  expect(workspace.manifest.packId).toBe('global-general');
  const patientCase = workspace.cases.find(item => item.demographics.name === 'Avery Reed')!;
  const start = await fetchApi(`/api/his/cases/${patientCase.id}/start-encounter`, { method: 'POST', headers, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion: 0, idempotencyKey: 'start-first' }) });
  expect(start.status).toBe(200);
  const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await start.json());
  const data = await (await fetchApi(`/api/his/encounters/${encounterId}`, { headers })).json();
  const encounter = visitSchema.parse(data);
  expect(encounter.patient.name).toBe('Avery Reed');
  expect(encounter.turns[0]?.speaker).toBe('patient');
  expect(JSON.stringify(data)).not.toMatch(/caseTruth|case_key|source_case_id|patientPersona|Focal right lower lobe consolidation/i);
  const command = (path: string, expectedVersion: number, idempotencyKey: string, fields: Record<string, unknown> = {}, method = 'POST') => fetchApi(path, { method, headers, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion, idempotencyKey, ...fields }) });
  const path = `/api/his/encounters/${encounterId}`;
  expect((await fetchApi(`${path}/billing`, { headers })).status).toBe(403);
  expect((await fetchApi(`${path}/payer`, { headers })).status).toBe(404);
  expect(await (await fetchApi(`${path}/debrief`, { headers })).json()).toEqual({ code: 'CASE_TRUTH_LOCKED' });
  expect((await command(`${path}/complete`, 1, 'unprivileged')).status).toBe(403);
  expect((await command('/api/workspace/role', 1, 'switch-clinician', { roleId: 'family-clinician' })).status).toBe(200);
  expect((await command(`${path}/complete`, 1, 'not-ready')).status).toBe(409);
  const question = { content: 'When did this begin?', channel: 'text' };
  expect(await (await command(`${path}/consultation/turns`, 1, 'unconfigured-question', question)).json()).toMatchObject({ code: 'LLM_PROVIDER_UNCONFIGURED' });
  const fields = { concern: 'Cough', subjective: 'Three days', objective: 'Triage reviewed', assessment: 'Evaluation documented', plan: 'Outpatient follow-up' };
  const save = (content: typeof fields) => command(`${path}/clinical-record/draft`, 1, 'save-note', { fields: content, expectedDraftVersion: 0 }, 'PUT');
  expect((await save(fields)).status).toBe(200);
  expect((await save(fields)).status).toBe(200);
  expect(await (await save({ ...fields, concern: 'Changed' })).json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
  const sign = (draftVersion: number) => command(`${path}/clinical-record/sign`, 2, 'sign-note', { expectedDraftVersion: draftVersion });
  expect((await sign(1)).status).toBe(200);
  expect((await sign(1)).status).toBe(200);
  expect(await (await sign(0)).json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
  const primary = { codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', primary: true };
  expect((await command(`${path}/diagnosis/draft`, 3, 'save-diagnosis', { diagnoses: [primary] }, 'PUT')).status).toBe(200);
  expect((await command(`${path}/diagnosis/confirm`, 4, 'confirm-diagnosis')).status).toBe(200);
  expect((await command(`${path}/no-medication`, 5, 'no-medication', { reason: 'Teaching case reviewed' })).status).toBe(200);
  expect(await (await fetchApi(`${path}/completion`, { headers })).json()).toMatchObject({ ready: true });
  expect((await command(`${path}/complete`, 6, 'complete')).status).toBe(200);
  expect(await (await fetchApi(`${path}/debrief`, { headers })).json()).toMatchObject({ caseTruth: { primaryDiagnosis: { code: 'J18.9' } }, recordRevisions: [{ fields }] });
  expect(await (await command(`${path}/consultation/turns`, 6, 'frozen', question)).json()).toEqual({ code: 'ENCOUNTER_COMPLETED' });
  expect((await command(`/api/his/cases/${patientCase.id}/start-encounter`, 0, 'replay-case')).status).toBe(200);
  const adminRole = await command('/api/workspace/role', 2, 'switch-admin', { roleId: 'coordinator' });
  expect(adminRole.status).toBe(200);
  const grant = { roleId: 'family-clinician', allowedOperations: ['encounter.read'], ttlSeconds: 60 };
  const issued = await command('/api/workspace/capabilities', 0, 'grant', grant);
  expect(issued.status).toBe(200);
  const catalog = new OperationCatalog();
  registerPlatformOperations(catalog, { modules: new ModuleRegistry([]), sign: async () => { throw Error('Schema-only reader'); } });
  const wireSchema = catalog.require('capability.issue').output;
  const received = wireSchema.parse(await issued.json());
  const capability = z.object({ token: z.string(), tokenId: z.uuidv7() }).parse(received);
  const replay = await (await command('/api/workspace/capabilities', 0, 'grant', grant)).json();
  expect(Object.hasOwn(z.record(z.string(), z.json()).parse(replay), 'token')).toBe(false);
  expect(z.object({ tokenId: z.uuidv7() }).parse(wireSchema.parse(replay)).tokenId === capability.tokenId).toBe(true);
  const bearer = { authorization: `Bearer ${capability.token}` };
  expect((await fetchApi(`/api/his/encounters/${encounterId}`, { headers: bearer })).status).toBe(200);
  expect((await fetchApi('/api/workspace', { headers: bearer })).status).toBe(403);
  const issue = async (key: string, ttlSeconds: number) => z.object({ token: z.string(), tokenId: z.uuidv7(), expiresAt: z.iso.datetime() }).parse(await (await command('/api/workspace/capabilities', 0, key, { ...grant, ttlSeconds })).json());
  const expiring = await issue('short-lived', 1);
  const revoked = await issue('revocable', 60);
  expect((await command(`/api/workspace/capabilities/${revoked.tokenId}/revoke`, 1, 'revoke')).status).toBe(200);
  const useToken = (token: string) => fetchApi(path, { headers: { authorization: `Bearer ${token}` } });
  expect((await useToken(revoked.token)).status).toBe(401);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiring.expiresAt) - Date.now() + 5)));
  expect((await useToken(expiring.token)).status).toBe(401);
  const reset = () => command('/api/workspace/reset', 0, 'switch-pack', { packId: 'cn-cardiology' });
  const next = await reset();
  expect(next.status).toBe(200);
  const state = z.object({ epoch: z.uuidv7(), roleId: z.string() }).parse(await next.json());
  expect(state.epoch).not.toBe(workspace.epoch);
  expect(state.roleId).toBe('hospital-admin');
  expect(await (await reset()).json()).toMatchObject(state);
  expect((await fetchApi(`/api/his/encounters/${encounterId}`, { headers: bearer })).status).toBe(401);
  expect(await (await fetchApi('/api/workspace', { headers })).json()).toMatchObject({ epoch: state.epoch, manifest: { packId: 'cn-cardiology', currency: { code: 'CNY' } } });
  expect(await (await fetchApi('/api/his/encounters', { headers })).json()).toEqual([]);
  const audit = await (await fetchApi(`/api/workspace/audit/${workspace.epoch}`, { headers })).json();
  expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'workspace.reset', practitioner_role: 'coordinator' }), expect.objectContaining({ operation: 'encounter.start', practitioner_role: 'intake' })]));
  expect(z.array(z.object({ operation: z.string() })).parse(audit).filter(entry => entry.operation === 'record.sign')).toHaveLength(1);
  const cardio = workspaceSchema.parse(await (await fetchApi('/api/workspace', { headers })).json());
  expect(cardio.diagnoses.map(item => item.code)).toContain('I25.103');
  expect(cardio.diagnoses.map(item => item.code)).not.toContain('J18.9');
  const nextCommand = (path: string, expectedVersion: number, fields: Record<string, unknown>) => fetchApi(path, { method: 'POST', headers, body: JSON.stringify({ ...fields, epoch: state.epoch, idempotencyKey: crypto.randomUUID(), expectedVersion }) });
  expect((await nextCommand('/api/workspace/role', 1, { roleId: 'cardiologist' })).status).toBe(200);
  const cardioCase = cardio.cases.find(item => item.encounterClass === 'outpatient')!;
  const opened = z.object({ encounterId: z.uuidv7() }).parse(await (await nextCommand(`/api/his/cases/${cardioCase.id}/start-encounter`, 0, {})).json());
  const cardioVisit = encounterViewSchema.parse(await (await fetchApi(`/api/his/encounters/${opened.encounterId}`, { headers })).json());
  expect(cardioVisit.template.map(field => field.id)).toContain('outpatient-followup');
  expect(cardioVisit.template.map(field => field.id)).not.toContain('admission');
  const wardCase = cardio.cases.find(item => item.encounterClass === 'inpatient')!;
  const ward = z.object({ encounterId: z.uuidv7() }).parse(await (await nextCommand(`/api/his/cases/${wardCase.id}/start-encounter`, 0, {})).json());
  expect((await nextCommand('/api/workspace/role', 2, { roleId: 'payer-reviewer' })).status).toBe(200);
  const accountPath = (id: string) => `/api/his/encounters/${id}/billing`;
  const read = async (id: string) => accountSchema.parse(await (await fetchApi(accountPath(id), { headers })).json());
  const funds = async (id: string, name: string, fields: Record<string, unknown>) => {
    const result = await nextCommand(`${accountPath(id)}/${name}`, (await read(id)).version, fields);
    expect(result.status).toBe(200);
    return z.record(z.string(), z.json()).parse(await result.json());
  };
  const bill = await read(opened.encounterId);
  const [registration] = bill.charges;
  expect(registration).toMatchObject({ catalogVersion: cardio.manifest.version, amountMinor: 1000, outstandingMinor: 1000 });
  const collection = previewSchema.parse(await funds(opened.encounterId, 'payment.preview', { chargeIds: [registration!.id], simulation: 'delayed-approval' }));
  const receipt = await funds(opened.encounterId, 'payment.confirm', { commitToken: collection.commitToken });
  expect(receipt.status).toBe('unknown');
  await funds(opened.encounterId, 'payment.recover', { paymentId: receipt.paymentId, paymentVersion: 1 });
  await funds(opened.encounterId, 'charge.adjust', { chargeId: registration!.id, amountMinor: 200, reason: 'Teaching correction' });
  const refund = await funds(opened.encounterId, 'refund.allocation.preview', { chargeId: registration!.id, paymentId: receipt.paymentId, amountMinor: 200, reason: 'Refund registration' });
  await funds(opened.encounterId, 'refund.allocation.confirm', { commitToken: refund.commitToken });
  expect(await read(opened.encounterId)).toMatchObject({ netMinor: 800, cashMinor: 800, balanceMinor: 0 });
  const preadmission = await funds(ward.encounterId, 'inpatient.deposit.preview', { amountMinor: 99 });
  await funds(ward.encounterId, 'inpatient.deposit.confirm', { commitToken: preadmission.commitToken });
  expect(await read(ward.encounterId)).toMatchObject({ admissionStatus: 'registered', cashMinor: 99, settlement: null });
  const logout = await nextCommand('/api/auth/logout', 3, {});
  expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  expect((await fetchApi('/api/his/unknown', { headers })).status).toBe(401);
}

it('runs the synthetic outpatient workflow over native Node HTTP and file SQLite', async () => {
  await withNodeWorkspace(origin => exercise((path, init) => fetch(origin + path, init)));
}, 45_000);

it('runs the same workflow through the Wrangler Worker and SQLite Durable Object', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    await exercise((path, init) => worker.fetch(path, init), async workspaceId => {
      await worker.evictDurableObject('WORKSPACE_DO', { name: 'visitor-gate-authority' });
      await worker.evictDurableObject('WORKSPACE_DO', { name: workspaceId });
    });
  }
  finally { await server.close(); }
}, 45_000);
