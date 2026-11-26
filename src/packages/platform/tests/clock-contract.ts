import { v7 } from 'uuid';
import type { StorePort } from '../../store';
import { CoreError, ModuleRegistry, OperationCatalog, registerPlatformOperations, type ClinMeshModule, type Credential } from '../index';

export async function clockContract(store: StorePort, timezone: string) {
  const at = { workspaceId: v7(), epoch: v7() };
  const id = v7();
  const start = '2028-02-28T15:59:59.000Z';
  const credential: Credential = { ticket: { ...at, kind: 'visitor', id, expiresAt: '2099-01-01T00:00:00Z' } };
  await store.withTransaction(tx => {
    tx.createWorkspace({ id: at.workspaceId, recorded_at: start });
    tx.createEpoch(at, { status: 'active', clock_revision: 0, virtual_time: start });
    tx.insert(at, 'data_pack_installations', { id: v7(), pack_id: 'teaching', pack_version: '1', manifest: { timezone, enabledModules: ['calendar'] }, organization: { practitionerRoles: [{ id: 'admin', name: { en: 'Admin', zh: '管理员' }, capabilities: ['workspace-admin'] }] }, knowledge: {}, recorded_at: start });
    tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'admin', version: 1, revoked: false, expires_at: credential.ticket.expiresAt });
  });
  let fail = false;
  let failAdvanced = false;
  const calendar: ClinMeshModule<OperationCatalog> = { id: 'calendar', kind: 'clinical', version: '1', midnight(tx, scope, date) {
    tx.insert(scope, 'patients', { id: v7(), display_name: date, birth_date: null, version: 1 });
    if (fail) {
      const rejected = Promise.reject(new CoreError(409, 'CALENDAR_FAILURE'));
      void rejected.catch(() => {});
      return rejected;
    }
    return Promise.resolve();
  }, clockAdvanced(tx, scope) {
    if (!failAdvanced) return;
    const rejected = Promise.resolve().then(() => {
      tx.insert(scope, 'patients', { id: v7(), display_name: 'Failed clock advance', birth_date: null, version: 1 });
      throw new CoreError(409, 'ADVANCE_FAILURE');
    });
    void rejected.catch(() => {});
    return rejected;
  } };
  const catalog = new OperationCatalog();
  registerPlatformOperations(catalog, { sign: async () => '', modules: new ModuleRegistry([calendar, { ...calendar, id: 'disabled', midnight() { throw Error('disabled module invoked'); } }]) });
  const advance = (to: string, expectedVersion: number, key: string) => catalog.require('workspace.advance-time').invoke({ store, credential, targetId: at.workspaceId, body: async () => ({ epoch: at.epoch, expectedVersion, idempotencyKey: key, to }) });
  const state = () => store.read(reader => ({ time: reader.getEpoch(at), dates: reader.list(at, 'patients').map(patient => patient.display_name), receipts: reader.list(at, 'command_receipts').length, audits: reader.list(at, 'audit_events').length }));
  await advance('2028-02-28T16:00:00.000Z', 0, 'first');
  const first = await state();
  fail = true;
  const failure = await advance('2028-03-01T16:00:00.000Z', 1, 'second').then(() => 'committed', (error: Error) => error.message);
  const rolledBack = await state();
  fail = false;
  failAdvanced = true;
  const advancedFailure = await advance('2028-03-01T16:00:00.000Z', 1, 'second').then(() => 'committed', (error: Error) => error.message);
  const afterAdvancedFailure = await state();
  failAdvanced = false;
  await advance('2028-03-01T16:00:00.000Z', 1, 'second');
  const last = await state();
  const invalid = await Promise.all(['2028-03-01T16:00:00.000Z', '2029-03-03T16:00:00.000Z'].map(to => advance(to, 2, to).then(() => 'committed', (error: Error) => error.message)));
  return { first, rolledBack, last, failure, advancedFailure, afterAdvancedFailure, invalid };
}
