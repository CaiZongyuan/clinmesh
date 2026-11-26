import { z } from 'zod';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { workspaceSchema, encounterViewSchema } from '../../clinical-core';
import type { StorePort } from '../../store';
import type { AgentEnvironment } from '../index';

export function patientHost(store: StorePort, environment: AgentEnvironment = {}) {
  const settings = { CLINMESH_VISITOR_PASSCODE: 'test-passcode', loadSigningSecret: () => store.visitorSigningSecret() };
  const workspace = createWorkspaceApp(store, settings, [], environment);
  const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }));
  return async (path: string, init?: RequestInit) => app.request(`https://clinic.example${path}`, init);
}
export type PatientHttp = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Pick<Response, 'status' | 'json'> & { headers: { get(name: string): string | null } }>;
export async function openPatient(fetchApi: PatientHttp) {
  const gate = await fetchApi('/api/auth/visitor/enter', { method: 'POST', body: JSON.stringify({ passcode: 'test-passcode' }) });
  const cookie = gate.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { cookie, 'content-type': 'application/json' };
  const workspace = workspaceSchema.parse(await (await fetchApi('/api/workspace', { headers })).json());
  function command(path: string, expectedVersion: number, fields: object, provider: Record<string, string> = {}, key = crypto.randomUUID()) {
    return fetchApi(path, { method: 'POST', headers: { ...headers, ...provider }, body: JSON.stringify({ epoch: workspace.epoch, expectedVersion, idempotencyKey: key, ...fields }) });
  }
  await command('/api/workspace/role', 1, { roleId: 'family-clinician' });
  const patient = workspace.cases.find(item => item.demographics.name === 'Avery Reed')!;
  const opened = await command(`/api/his/cases/${patient.id}/start-encounter`, 0, { language: 'en' });
  const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await opened.json());
  const base = `/api/his/encounters/${encounterId}`;
  const read = async () => encounterViewSchema.parse(await (await fetchApi(base, { headers })).json());
  const ask = (content: string, version: number, provider: Record<string, string> = {}, key?: ReturnType<typeof crypto.randomUUID>) => command(`${base}/consultation/turns`, version, { content, channel: 'text' }, provider, key);
  return { workspace, encounterId, headers, command, base, ask, read };
}
