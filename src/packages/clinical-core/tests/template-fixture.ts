import { v7 } from 'uuid';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import { createWorkspaceApp } from '../../../server/workspace';
import { installHospitalDataPack, readHospitalDataPack } from '../../data-pack';
import type { Credential } from '../../platform';
import type { StorePort } from '../../store';
import { encounterViewSchema } from '../index';

export async function templateFixture(store: StorePort) {
  const workspaceId = v7();
  const id = v7();
  const credential: Credential = { ticket: { kind: 'visitor', workspaceId, id, expiresAt: '2099-01-01T00:00:00Z' } };
  const pack = { ...general, manifest: { ...general.manifest, timezone: 'Asia/Shanghai', clinicalRecordTemplate: [
    { id: 'concern', title: { en: 'Concern', zh: '主诉' }, required: true },
    { id: 'minor', title: { en: 'Guardian note', zh: '监护记录' }, required: true, showWhen: { maxAge: 17 } },
  ] }, cases: general.cases.map(item => ({ ...item, demographics: { ...item.demographics, birthDate: '2010-04-17' } })) };
  const at = await store.withTransaction(tx => {
    const scope = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-04-16T15:59:59Z' }, pack);
    tx.insert(scope, 'visitor_sessions', { id, practitioner_role: 'family-clinician', expires_at: credential.ticket.expiresAt, version: 1, revoked: false });
    return scope;
  });
  const app = createWorkspaceApp(store, {});
  const send = (path: string, init?: RequestInit) => app.request(path, init, { credential, entering: false });
  const command = (path: string, method: string, expectedVersion: number, fields: Record<string, unknown> = {}) => send(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, epoch: at.epoch, expectedVersion, idempotencyKey: v7() }) });
  const caseId = await store.read(reader => readHospitalDataPack(reader, at)!.cases[0]!.id);
  const opened = z.object({ encounterId: z.uuidv7() }).parse(await (await command(`/api/his/cases/${caseId}/start-encounter`, 'POST', 0)).json());
  const path = `/api/his/encounters/${opened.encounterId}`;
  const read = async () => encounterViewSchema.parse(await (await send(path)).json());
  async function birthday() {
    const admin = await command('/api/workspace/role', 'POST', 1, { roleId: 'coordinator' });
    const midnight = await command('/api/workspace/advance-time', 'POST', 0, { to: '2028-04-16T16:00:00Z' });
    const clinician = await command('/api/workspace/role', 'POST', 2, { roleId: 'family-clinician' });
    return [admin.status, midnight.status, clinician.status];
  }
  return { workspaceId, at, send, command, read, birthday, opened, path };
}
