import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { z } from 'zod';
import { encounterViewSchema, workspaceSchema } from '../../packages/clinical-core';
import type { PlatformHost } from './platform-hosts';
import { workbenchJourney } from './platform-workbench';

const record = z.record(z.string(), z.json());
export async function platformJourney(source: PlatformHost, target: PlatformHost) {
  const { origin } = source;
  expect((await fetch(`${origin}/api/workspace`)).status).toBe(401);
  const opened = await workbenchJourney(origin);
  const { headers } = opened;
  const outpatient = opened.id;
  let workspace = opened.workspace;
  const get = async (path: string) => { const response = await fetch(origin + path, { headers }); expect(response.status, path).toBe(200); return record.parse(await response.json()); };
  const refresh = async () => { workspace = workspaceSchema.parse(await get('/api/workspace')); };
  async function send(name: string, id: string, expectedVersion: number, fields = {}) {
    const entry = workspace.operations.find(item => item.name === name);
    if (!entry) throw Error(`Unavailable ${name} for ${workspace.roleId}`);
    const response = await fetch(origin + entry.path.replace(':id', id), { method: entry.method, headers, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion, idempotencyKey: crypto.randomUUID(), ...fields }) });
    const output = await response.json();
    if (!response.ok) throw Error(`${name} ${JSON.stringify(output)}`);
    return record.parse(output);
  }
  async function role(roleId: string) { await send('workspace.role', '', workspace.sessionVersion, { roleId }); await refresh(); }
  async function reset(packId: string) { const old = workspace.epoch; await send('workspace.reset', '', workspace.clockRevision, { packId }); await refresh(); expect(workspace.epoch).not.toBe(old); expect(workspace.manifest.packId).toBe(packId); }
  const clinical = async (id: string) => encounterViewSchema.parse(await get(`/api/his/encounters/${id}`));
  const visit = await clinical(outpatient);
  await send('diagnosis.draft', outpatient, visit.version, { diagnoses: [{ primary: true, codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9' }] });
  await send('diagnosis.confirm', outpatient, (await clinical(outpatient)).version);
  await send('prescription.no-medication', outpatient, (await clinical(outpatient)).version, { reason: 'Synthetic follow-up planned' });
  await role('coordinator');
  const grant = await send('capability.issue', '', 0, { roleId: 'family-clinician', allowedOperations: ['encounter.read', 'encounter.complete'], ttlSeconds: 600 });
  const cli = async (words: string[]) => {
    const result = await promisify(execFile)(process.execPath, ['bin/clinmesh.mjs', ...words, '--json'], { windowsHide: true, env: { ...process.env, CLINMESH_SERVER_URL: origin, CLINMESH_TOKEN: z.string().parse(grant.token) } });
    return z.object({ data: record, ok: z.literal(true) }).parse(JSON.parse(result.stdout)).data;
  };
  const ready = await cli(['encounter', 'read', '--id', outpatient]);
  await cli(['encounter', 'complete', '--id', outpatient, '--epoch', workspace.epoch, '--expected-version', String(ready.version), '--idempotency-key', crypto.randomUUID(), '--yes']);
  expect(await cli(['encounter', 'read', '--id', outpatient])).toMatchObject({ status: 'completed' });
  const evaluate = (arm: string) => fetch(`${origin}/api/eval/runs`, { method: 'POST', headers: { ...headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ arm, packId: 'global-general', caseId: 'g01', maxTurns: 12, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
  if (source.objects) {
    const objects = await source.objects();
    const unsupported = await evaluate('mirage-vfs');
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toEqual({ code: 'EVALUATION_ARM_UNAVAILABLE' });
    expect(await source.objects()).toEqual(objects);
  }
  const launch = await evaluate('direct-tools');
  const run = await launch.json();
  expect(run).toMatchObject({ status: 'completed', arm: 'direct-tools', hits: { diagnosis: true }, patientTurns: 1 });
  const { runId, encounterId: evaluated } = z.object({ runId: z.uuidv7(), encounterId: z.uuidv7() }).parse(run);
  expect(await get(`/api/eval/runs/${runId}`)).toEqual(run);
  await reset('cn-cardiology');
  await role('registration-desk');
  const targetCase = workspace.cases.find(item => item.demographics.name === '赵德明')!;
  const inpatient = z.uuidv7().parse((await send('ward.register', targetCase.id, 0, { ward: 'heart-ward' })).encounterId);
  const ward = () => get(`/api/his/ward/${inpatient}`);
  const act = async (name: string, fields = {}) => send(`ward.${name}`, inpatient, z.int().parse((await ward()).version), fields);
  await role('ward-nurse'); await act('bed.assign', { bed: 'heart-01' });
  await role('cardiologist');
  await act('diagnose', { diagnoses: [{ codeSystem: 'urn:clinmesh:reference:nhsa-diagnosis', code: 'I25.103', ordinal: 1, primary: true, poa: 'Y' }] });
  expect((await get(`/api/his/encounters/${inpatient}/cds/scores`)).scores).toEqual(expect.any(Array));
  await expect(act('discharge.issue')).rejects.toThrow('CLINICAL_QUALITY_ALERT');
  await act('discharge.issue', { clinicalOverride: { reasonCode: 'specialist-judgment', ruleCodes: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'], note: 'Teaching specialist reviewed recent bleeding and arranged medication reassessment.' } });
  const admitted = await clinical(inpatient);
  const fields = Object.fromEntries(admitted.template.filter(item => item.required).map(item => [item.id, 'Teaching clinician reviewed discharge.']));
  await send('record.draft', inpatient, admitted.version, { expectedDraftVersion: admitted.draftVersion, fields });
  await send('record.sign', inpatient, (await clinical(inpatient)).version);
  await role('ward-nurse'); await act('discharge.depart');
  await role('payer-reviewer');
  const bill = () => get(`/api/his/encounters/${inpatient}/billing`);
  const settle = async (name: string, fields = {}) => send(name, inpatient, z.int().parse((await bill()).version), fields);
  const balance = z.int().parse((await bill()).balanceMinor);
  if (balance > 0) { const deposit = await settle('inpatient.deposit.preview', { amountMinor: balance }); await settle('inpatient.deposit.confirm', { commitToken: deposit.commitToken }); }
  const quote = await settle('inpatient.settlement.preview'); await settle('inpatient.discharge.settle', { commitToken: quote.commitToken });
  await role('ward-nurse'); await act('discharge.clear');
  await role('cardiologist'); await send('encounter.complete', inpatient, (await clinical(inpatient)).version);
  await act('chart.submit', { summary: 'Reviewed', disposition: 'Home', followUp: 'Cardiology' });
  await role('records-coder'); await act('chart.review', { revision: 1, coding: 'Verified POA' });
  const archive = z.uuidv7().parse((await act('chart.archive', { revision: 1 })).archiveId);
  expect(await ward()).toMatchObject({ status: 'cleared', bed: null, clinical: 'completed', chart: { state: 'archived' } });
  const admin = workspace.roles.find(item => item.capabilities.includes('workspace-admin'))!;
  await role(admin.id); await reset('global-general');
  const snapshots = [];
  for (const [id, expectedIds, evaluation] of [[workspace.workspaceId, [outpatient, inpatient, archive], false], [runId, [evaluated], true]] as const) {
    const original = await source.capture(id, evaluation);
    expect(original.pi.length).toBeGreaterThanOrEqual(2);
    expect(original.pi.every(session => session.tables.some(table => table.rows.length > 0))).toBe(true);
    const restored = await target.restore(original, evaluation);
    expect(restored).toEqual(original);
    const rows = restored.tables.flatMap(table => table.rows);
    for (const id of expectedIds) expect(rows.some(row => row.id === id)).toBe(true);
    if (!evaluation) expect(restored.tables.find(table => table.name === 'workspace_epochs')!.rows).toHaveLength(3);
    snapshots.push({ workspaceId: id, sha256: restored.sha256, piSessions: restored.pi.length, businessIds: expectedIds });
  }
  expect(await (await fetch(`${target.recoveryOrigin}/api/eval/runs/${runId}`, { headers })).json()).toEqual(run);
  expect(await (await fetch(`${target.recoveryOrigin}/api/workspace`, { headers })).json()).toMatchObject({ workspaceId: workspace.workspaceId, epoch: workspace.epoch });
  return { outpatient, inpatient, archive, runId, evaluated, snapshots };
}
