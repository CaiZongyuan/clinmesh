import { createHash } from 'node:crypto';
import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { z } from 'zod';
import cardiology from '../../data/packs/cn-cardiology/pack.json';
import { installHospitalDataPack } from '../packages/data-pack';
import { labViewSchema } from '../packages/mod-lab';
import { canonicalJson, createNodeSqliteStore } from '../packages/store';
import { builtinModules } from './builtin-modules';
import { createWorkspaceApp } from './workspace';

it('opens the v2 cardiology snapshot with ECG and TTE available and rejects invasive angiography from the lab draft', async () => {
  const pack = structuredClone(cardiology);
  Reflect.deleteProperty(pack.knowledge, 'pharmacy');
  Reflect.deleteProperty(pack.knowledge, 'cds');
  Reflect.deleteProperty(pack.catalog.medications.find(item => item.code === 'dapagliflozin')!.safety, 'contraindicatedEgfrBelow');
  pack.manifest.version = '1.0.0';
  pack.catalog.services = pack.catalog.services.filter(service => service.kind !== 'registration');
  const rules = pack.knowledge.regionalRules['mod-drg-cn'];
  for (const key of ['diagnosisSystem', 'procedureSystem', 'tiers', 'catalogCoverage', 'plans']) Reflect.deleteProperty(rules, key);
  for (const service of pack.catalog.services) { Reflect.deleteProperty(service, 'requiresProcedure'); Reflect.deleteProperty(service, 'modality'); }
  for (const patient of pack.cases) for (const result of patient.caseTruth.results) {
    Reflect.deleteProperty(result, 'stSegmentDeviation');
    for (const observation of result.observations) { Reflect.deleteProperty(observation, 'unit'); Reflect.deleteProperty(observation, 'interpretation'); }
  }
  const digest = (value: unknown) => createHash('sha256').update(canonicalJson(z.json().parse(value))).digest('hex');
  expect(digest(pack)).toBe('a78c9f8b3f84b1f35a4e48393d8eda2615c314c4570844b7b4a55749db5e83a3');
  const source = createNodeSqliteStore({ dbPath: ':memory:' });
  const restored = createNodeSqliteStore({ dbPath: ':memory:' });
  const workspaceId = v7();
  const id = v7();
  const expiresAt = '2099-01-01T00:00:00Z';
  try {
    const { at, caseId, cagId } = await source.withTransaction(tx => {
      const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-01-01T00:00:00Z' }, { ...pack, knowledge: { ...pack.knowledge, pharmacy: cardiology.knowledge.pharmacy } });
      tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'cardiologist', revoked: false, expires_at: expiresAt, version: 1 });
      return { at, caseId: tx.list(at, 'clinical_cases')[0]!.id, cagId: tx.list(at, 'catalog_items', { kind: 'services', code: 'cag' })[0]!.id };
    });
    const exported = await source.exportLogicalSnapshot(workspaceId);
    exported.tables.find(table => table.name === 'data_pack_installations')!.rows[0]!.knowledge = pack.knowledge;
    const v2 = { format: 'clinmesh.snapshot.v2', workspaceId, tables: exported.tables.slice(0, exported.tables.findIndex(table => table.name === 'charge_sources')), pi: exported.pi };
    await restored.importLogicalSnapshot({ ...v2, sha256: digest(v2) });
    const app = createWorkspaceApp(restored, { localOpen: true }, builtinModules);
    const env = { entering: false, credential: { ticket: { kind: 'visitor' as const, workspaceId, id, expiresAt } } };
    const send = (path: string, method: 'POST' | 'PUT', fields = {}) => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epoch: at.epoch, idempotencyKey: v7(), expectedVersion: 0, ...fields }) }, env);
    const opened = await send(`/api/his/cases/${caseId}/start-encounter`, 'POST');
    const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await opened.json());
    const path = `/api/his/encounters/${encounterId}/lab`;
    const view = labViewSchema.parse(await (await app.request(path, {}, env)).json());
    expect(view.services.filter(service => service.kind === 'examination').map(service => service.code).sort()).toEqual(['ecg', 'tte']);
    const save = await send(`${path}/draft`, 'PUT', { serviceIds: [cagId] });
    expect(save.status).toBe(409);
    expect(await save.json()).toEqual({ code: 'CATALOG_CONFLICT' });
  } finally { await Promise.all([source.close(), restored.close()]); }
});
