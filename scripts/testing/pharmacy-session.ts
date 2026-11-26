import { z } from 'zod';
import { workspaceSchema } from '../../src/packages/clinical-core';
import { teachingGate } from './node-workspace';

export type PharmacyHttp = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{ status: number; headers: { get(key: string): string | null }; json(): Promise<unknown> }>;

export async function openPharmacySession(fetchApi: PharmacyHttp) {
  const entered = await fetchApi('/api/auth/visitor/enter', { method: 'POST', body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  const cookie = entered.headers.get('set-cookie')!.split(';')[0]!;
  return pharmacySession(fetchApi, cookie);
}

export async function pharmacySession(fetchApi: PharmacyHttp, cookie: string) {
  const headers = { cookie, 'content-type': 'application/json' };
  const get = async (path: string) => (await fetchApi(path, { headers })).json();
  const workspace = workspaceSchema.parse(await get('/api/workspace'));
  const command = (path: string, expectedVersion: number, fields: object = {}, method = 'POST', idempotencyKey = crypto.randomUUID()) => fetchApi(path, { method, headers, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion, idempotencyKey, ...fields }) });
  async function applied(request: ReturnType<typeof command>) {
    const response = await request;
    const body = await response.json();
    if (response.status !== 200) throw Error(`Expected success: ${JSON.stringify(body)}`);
    return body;
  }
  let roleVersion = workspace.sessionVersion;
  const role = (roleId: string) => applied(command('/api/workspace/role', roleVersion++, { roleId }));
  async function start(name: string, code: string) {
    const patient = workspace.cases.find(item => item.demographics.name === name)!;
    const opened = await applied(command(`/api/his/cases/${patient.id}/start-encounter`, 0));
    const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(opened);
    const path = `/api/his/encounters/${encounterId}`;
    const fields = Object.fromEntries(workspace.manifest.clinicalRecordTemplate.filter(item => item.required).map(item => [item.id, item.id]));
    await applied(command(`${path}/clinical-record/draft`, 1, { expectedDraftVersion: 0, fields }, 'PUT'));
    await applied(command(`${path}/clinical-record/sign`, 2));
    await applied(command(`${path}/diagnosis/draft`, 3, { diagnoses: [{ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code, primary: true }] }, 'PUT'));
    await applied(command(`${path}/diagnosis/confirm`, 4));
    return path;
  }
  await role('family-clinician');
  return { get, workspace, role, command, applied, start, cookie };
}
