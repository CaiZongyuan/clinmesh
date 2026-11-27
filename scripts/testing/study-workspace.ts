import { v7 } from 'uuid';
import { z } from 'zod';
import { workspaceSchema, encounterViewSchema } from '../../src/packages/clinical-core';
import { installHospitalDataPack, type HospitalDataPack } from '../../src/packages/data-pack';
import { studyViewSchema, type StudyKind } from '../../src/packages/diagnostic-studies';
import { createNodeSqliteStore } from '../../src/packages/store';
import { builtinModules } from '../../src/server/builtin-modules';
import { createWorkspaceApp } from '../../src/server/workspace';

export async function studyWorkspace(pack: HospitalDataPack, environment = {}) {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const workspaceId = v7();
  const id = v7();
  const expiresAt = '2099-01-01T00:00:00Z';
  const at = await store.withTransaction(tx => {
    const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-01-01T00:00:00Z' }, pack);
    tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'clinician', revoked: false, version: 1, expires_at: expiresAt });
    return at;
  });
  const app = createWorkspaceApp(store, { localOpen: true }, builtinModules, environment);
  const credential = { ticket: { workspaceId, id, expiresAt, kind: 'visitor' as const } };
  const request = (path: string, init?: RequestInit) => app.request(path, init, { credential, entering: false });
  const read = async (path: string) => (await request(path)).json() as Promise<unknown>;
  const workspace = async () => workspaceSchema.parse(await read('/api/workspace'));
  const write = async (path: string, version: number, fields = {}, key = v7(), method = 'POST', headers = {}) => {
    const response = await request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ...fields, epoch: at.epoch, expectedVersion: version, idempotencyKey: key }) });
    const data = z.record(z.string(), z.json()).parse(await response.json());
    if (!response.ok) throw Error(`${response.status} ${data.code}`);
    return data;
  };
  const startCase = async (id: string) => z.uuidv7().parse((await write(`/api/his/cases/${id}/start-encounter`, 0)).encounterId);
  const encounterId = await startCase((await workspace()).cases[0]!.id);
  const base = `/api/his/encounters/${encounterId}`;
  const encounter = async () => encounterViewSchema.parse(await read(base));
  const study = (kind: StudyKind) => {
    const view = async () => studyViewSchema.parse(await read(`${base}/${kind}`));
    const issue = async (name: string, surgery?: string) => {
      const item = (await view()).services.find(item => item.display.en === name)!.quote;
      return z.uuidv7().parse((await write(`${base}/${kind}/issue`, (await encounter()).version, { item, priorSurgeryId: surgery })).orderId);
    };
    const advance = (orderId: string, action: string, version: number) => write(`/api/his/${kind}/orders/${orderId}/${action}`, version);
    const report = async (orderId: string) => { await advance(orderId, 'accept', 1); await advance(orderId, 'start', 2); await advance(orderId, 'report-now', 3); return (await view()).orders.find(item => item.id === orderId)!.reports[0]!; };
    const review = (reportId: string, action: string, version: number, reportVersion: number, mode?: string) => write(`/api/his/${kind}/reports/${reportId}/${action}`, version, { reportVersion, mode });
    return { view, issue, advance, report, review };
  };
  const role = async (roleId: string) => write('/api/workspace/role', (await workspace()).sessionVersion, { roleId });
  return { store, at, request, read, workspace, write, role, startCase, encounter, encounterId, base, study, close: () => store.close() };
}
