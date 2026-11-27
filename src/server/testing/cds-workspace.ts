import { v7 } from 'uuid';
import { pharmacySession } from '../../../scripts/testing/pharmacy-session';
import { installHospitalDataPack, type HospitalDataPack } from '../../packages/data-pack';
import { createVisitorGate, type ClinMeshModule, type OperationCatalog } from '../../packages/platform';
import { createNodeSqliteStore } from '../../packages/store';
import { createApp } from '../app';
import { BUILTIN_DATA_PACKS } from '../builtin-data-packs';
import { builtinModules } from '../builtin-modules';
import { createWorkspaceApp } from '../workspace';

export async function cdsWorkspace(configure?: (pack: HospitalDataPack) => void, modules: readonly ClinMeshModule<OperationCatalog>[] = builtinModules, source: HospitalDataPack = BUILTIN_DATA_PACKS['global-general']) {
  const pack = structuredClone(source);
  configure?.(pack);
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const ticket = { kind: 'visitor' as const, workspaceId: v7(), id: v7(), expiresAt: '2099-01-01T00:00:00.000Z' };
  const now = '2026-06-10T09:00:00.000Z';
  const at = await store.withTransaction(async tx => {
    const at = installHospitalDataPack(tx, { workspaceId: ticket.workspaceId, expectedEpoch: null, virtualTime: now }, pack);
    for (const module of modules) if (pack.manifest.enabledModules.includes(module.id)) await module.initializeEpoch?.(tx, at, now, now);
    tx.insert(at, 'visitor_sessions', { id: ticket.id, practitioner_role: 'intake', version: 1, revoked: false, expires_at: ticket.expiresAt });
    return at;
  });
  const settings = { loadSigningSecret: () => store.visitorSigningSecret() };
  const cookie = `cm_visitor=${await createVisitorGate(settings).sign(ticket)}`;
  const workspace = createWorkspaceApp(store, settings, modules);
  const app = createApp('node', settings, (req, credential, entering) => workspace.fetch(req, { credential, entering }), modules);
  const fetchApi = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, { ...init, headers: { cookie, ...init?.headers } }));
  return { store, at, now, fetchApi, ...await pharmacySession(fetchApi, cookie) };
}
