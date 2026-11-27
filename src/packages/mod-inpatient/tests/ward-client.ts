import { expect } from 'vitest';
import { z } from 'zod';
import { workspaceSchema } from '../../clinical-core';
import { teachingGate } from '../../../../scripts/testing/node-workspace';

type WardHttp = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
export async function wardClient(request: WardHttp, packId = 'cn-cardiology') {
  const entered = await request('/api/auth/visitor/enter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  expect(entered.status).toBe(200);
  const headers = { cookie: entered.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' };
  const object = z.record(z.string(), z.json());
  const get = async (path: string) => { const response = await request(path, { headers }); expect(response.status, path).toBe(200); return object.parse(await response.json()); };
  const workspace = async () => workspaceSchema.parse(await get('/api/workspace'));
  let current = await workspace();
  expect(current.operations.some(item => item.name.startsWith('ward.'))).toBe(false);
  expect((await request('/api/his/ward', { headers })).status).toBe(404);
  async function send(name: string, targetId: string, expectedVersion: number, fields = {}, key = crypto.randomUUID()) {
    const operation = current.operations.find(item => item.name === name);
    if (!operation) throw Error(`Unavailable operation ${name} for ${current.roleId}`);
    const response = await request(operation.path.replace(':id', targetId), { method: operation.method, headers, body: JSON.stringify({ epoch: current.epoch, expectedVersion, idempotencyKey: key, ...fields }) });
    const result = await response.json();
    if (!response.ok) throw Error(`${name} ${response.status} ${JSON.stringify(result)}`);
    return object.parse(result);
  }
  async function role(roleId: string) {
    if (current.roleId !== roleId) await send('workspace.role', '', current.sessionVersion, { roleId });
    current = await workspace();
  }
  await role('coordinator');
  await send('workspace.reset', '', 0, { packId });
  current = await workspace();
  async function admit(patientName: string) {
    await role('registration-desk');
    const source = current.cases.find(item => item.demographics.name === patientName)!;
    const receipt = await send('ward.register', source.id, 0, { ward: 'heart-ward' });
    return z.uuidv7().parse(receipt.encounterId);
  }
  return { get, send, role, admit, workspace, cookie: headers.cookie, current: () => current };
}
