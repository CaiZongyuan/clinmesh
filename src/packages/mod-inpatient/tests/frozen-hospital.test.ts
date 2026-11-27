import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_DATA_PACKS } from '../../../server/builtin-data-packs';
import { builtinModules } from '../../../server/builtin-modules';
import { createWorkspaceApp } from '../../../server/workspace';
import { installHospitalDataPack, parseHospitalDataPack } from '../../data-pack';
import { sha256 } from '../../platform';
import { canonicalJson, createNodeSqliteStore } from '../../store';

it('opens historical cardiology cases and advances across midnight without offering unconfigured inpatient commands', async () => {
  const source = createNodeSqliteStore({ dbPath: ':memory:' }), restored = createNodeSqliteStore({ dbPath: ':memory:' });
  const hospital = structuredClone(BUILTIN_DATA_PACKS['cn-cardiology']);
  const historical = structuredClone(hospital); historical.manifest.version = '1.3.0'; delete historical.knowledge!.inpatient;
  expect(() => parseHospitalDataPack(historical)).toThrow('knowledge.inpatient');
  const id = v7(), workspaceId = v7(), expiresAt = '2099-01-01T00:00:00Z', now = '2028-01-01T15:00:00Z';
  try {
    const at = await source.withTransaction(tx => {
      const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: now }, hospital);
      tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'cardiologist', expires_at: expiresAt, revoked: false, version: 1 });
      return at;
    });
    const { sha256: _digest, ...snapshot } = await source.exportLogicalSnapshot(workspaceId);
    const legacy = { ...snapshot, format: 'clinmesh.snapshot.v7', tables: snapshot.tables.slice(0, snapshot.tables.findIndex(table => table.name === 'ward_certificates')) };
    const pack = legacy.tables.find(table => table.name === 'data_pack_installations')!.rows[0]!;
    pack.pack_version = '1.3.0'; pack.manifest = z.json().parse(historical.manifest); pack.knowledge = z.json().parse(historical.knowledge);
    await restored.importLogicalSnapshot({ ...legacy, sha256: await sha256(canonicalJson(legacy)) });
    const app = createWorkspaceApp(restored, { localOpen: true }, builtinModules);
    const env = { credential: { ticket: { kind: 'visitor' as const, workspaceId, id, expiresAt } }, entering: false };
    const get = (path: string) => app.request(path, {}, env);
    const write = (path: string, expectedVersion: number, fields = {}) => app.request(path, { method: 'POST', body: JSON.stringify({ ...fields, epoch: at.epoch, expectedVersion, idempotencyKey: v7() }) }, env);
    const workspace = z.object({ enabledModules: z.array(z.string()), cases: z.array(z.object({ id: z.string(), encounterClass: z.string() })) }).parse(await (await get('/api/workspace')).json());
    expect(workspace.enabledModules).not.toContain('mod-inpatient');
    expect((await get('/api/his/ward')).status).toBe(404);
    const patient = workspace.cases.find(row => row.encounterClass === 'inpatient')!;
    const opened = await write(`/api/his/cases/${patient.id}/start-encounter`, 0);
    const visit = z.object({ encounterId: z.uuidv7() }).parse(await opened.json());
    await restored.withTransaction(tx => tx.insert(at, 'inpatient_admissions', { id: v7(), encounter_id: visit.encounterId, ward: 'heart-ward', status: 'admitted', version: 1, virtual_at: now, recorded_at: now }));
    expect((await get(`/api/his/encounters/${visit.encounterId}`)).status).toBe(200);
    expect((await write('/api/workspace/role', 1, { roleId: 'hospital-admin' })).status).toBe(200);
    expect((await write('/api/workspace/advance-time', 0, { to: '2028-01-02T01:00:00Z' })).status).toBe(200);
  } finally { await Promise.all([source.close(), restored.close()]); }
});
