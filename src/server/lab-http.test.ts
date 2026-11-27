import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { teachingGate } from '../../scripts/testing/node-workspace';
import { workspaceSchema } from '../packages/clinical-core';
import { labViewSchema } from '../packages/mod-lab';
import { accountSchema } from '../packages/mod-billing';

it('serves the registered investigations through workerd and preserves version-bound reviews after DO eviction', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const gate = await worker.fetch('/api/auth/visitor/enter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
    const headers = { cookie: gate.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' };
    const get = async (path: string) => (await worker.fetch(path, { headers })).json();
    const workspace = workspaceSchema.parse(await get('/api/workspace'));
    expect(workspace.tabs).toContainEqual({ id: 'lab', label: { en: 'Investigations', zh: '检验与功能检查' } });
    const write = async (path: string, expectedVersion: number, fields = {}, method = 'POST') => {
      const response = await worker.fetch(path, { method, headers, body: JSON.stringify({ ...fields, epoch: workspace.epoch, expectedVersion, idempotencyKey: crypto.randomUUID() }) });
      const body: unknown = await response.json();
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(200);
      return body;
    };
    await write('/api/workspace/role', 1, { roleId: 'family-clinician' });
    const jordan = workspace.cases.find(item => item.demographics.name === 'Jordan Vale')!;
    const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await write(`/api/his/cases/${jordan.id}/start-encounter`, 0));
    const base = `/api/his/encounters/${encounterId}/lab`;
    const read = async () => labViewSchema.parse(await get(base));
    const troponin = (await read()).services.find(service => service.code === 'hs-tni')!;
    await write(`${base}/draft`, 0, { serviceIds: [troponin.id] }, 'PUT');
    await write(`${base}/issue`, 1, { items: (await read()).draft.items });
    const order = (await read()).orders[0]!;
    const orderPath = `/api/his/lab/orders/${order.id}`;
    await write(`${orderPath}/accept`, 1); await write(`${orderPath}/start`, 2); await write(`${orderPath}/report-now`, 3);
    const first = (await read()).orders[0]!.reports[0]!;
    const reportPath = `/api/his/reports/${first.id}`;
    await write(`${reportPath}/acknowledge`, 4, { reportVersion: 1 });
    await write(`${base}/draft`, 2, { serviceIds: [troponin.id] }, 'PUT');
    await write(`${base}/issue`, 3, { items: (await read()).draft.items });
    const repeat = (await read()).orders.find(other => other.id !== order.id)!;
    await write('/api/workspace/role', 2, { roleId: 'coordinator' });
    await write(`${reportPath}/amend`, 5, { reportVersion: 1 });
    await worker.evictDurableObject('WORKSPACE_DO', { name: workspace.workspaceId });
    const revised = (await read()).orders[0]!;
    expect(revised.reports).toMatchObject([{ id: first.id, acknowledged: { role: 'family-clinician' } }, { previousId: first.id, version: 2, acknowledged: null, observations: [{ value: 120, critical: true }] }]);
    expect(revised.status).toBe('reported');
    await write('/api/workspace/role', 3, { roleId: 'family-clinician' });
    expect((await read()).orders.filter(item => item.status === 'issued').map(item => item.id)).toEqual([repeat.id]);
    await write(`${base}/draft`, 4, { serviceIds: [troponin.id] }, 'PUT');
    expect(await write(`${base}/issue`, 5, { items: (await read()).draft.items })).toMatchObject({ results: [{ serviceId: troponin.id, error: 'ACTIVE_ORDER_EXISTS' }] });
    await write(`/api/his/reports/${revised.reports[1]!.id}/acknowledge`, 6, { reportVersion: 2 });
    expect((await read()).orders[0]!.status).toBe('acknowledged');
    await write('/api/workspace/role', 4, { roleId: 'cashier' });
    const bill = accountSchema.parse(await get(`/api/his/encounters/${encounterId}/billing`));
    expect(bill.charges.filter(line => line.catalogItemId === troponin.id).map(line => [line.orderId, line.amountMinor])).toEqual([[order.id, 2200], [repeat.id, 2200]]);
  } finally { await server.close(); }
}, 30_000);
