import { v7 } from 'uuid';
import general from '../../../../data/packs/global-general/pack.json';
import { pharmacySession } from '../../../../scripts/testing/pharmacy-session';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { installHospitalDataPack, parseHospitalDataPack, type HospitalDataPack } from '../../data-pack';
import { createVisitorGate, type Ticket } from '../../platform';
import { createNodeSqliteStore, type StorePort } from '../../store';
import { createPharmacyModule } from '../index';

export async function configuredPharmacy(configure: (pack: HospitalDataPack) => void) {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const pack = structuredClone(parseHospitalDataPack(general));
  configure(pack);
  const module = createPharmacyModule();
  const ticket = { kind: 'visitor' as const, workspaceId: v7(), id: v7(), expiresAt: '2099-01-01T00:00:00Z' };
  const at = await store.withTransaction(async tx => {
    const time = '2026-11-20T00:00:00Z';
    const scope = installHospitalDataPack(tx, { workspaceId: ticket.workspaceId, expectedEpoch: null, virtualTime: time }, pack);
    await module.initializeEpoch!(tx, scope, time, time);
    tx.insert(scope, 'visitor_sessions', { id: ticket.id, practitioner_role: 'intake', version: 1, revoked: false, expires_at: ticket.expiresAt });
    return scope;
  });
  return { store, at, ticket, ...await pharmacyClient(store, ticket) };
}

export async function pharmacyClient(store: StorePort, ticket: Ticket) {
  const module = createPharmacyModule();
  const settings = { loadSigningSecret: () => store.visitorSigningSecret() };
  const workspace = createWorkspaceApp(store, settings, [module]);
  const api = createApp('node', settings, (incoming, credential, entering) => workspace.fetch(incoming, { credential, entering }), [module]);
  const cookie = `cm_visitor=${await createVisitorGate(settings).sign(ticket)}`;
  const fetchApi = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    return Promise.resolve(api.request(path, { ...init, headers }));
  };
  return { fetchApi, session: await pharmacySession(fetchApi, cookie) };
}
