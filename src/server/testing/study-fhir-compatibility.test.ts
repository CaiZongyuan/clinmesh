import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { studyViewSchema } from '../../packages/diagnostic-studies';
import { createNodeSqliteStore } from '../../packages/store';
import { builtinModules } from '../builtin-modules';
import { createWorkspaceApp } from '../workspace';

it('imports signed v7 radiology and pathology reports with their prior versions, frame gates and FHIR references intact', async () => {
  const encoded = readFileSync(new URL('./fixtures/8040f4b9-v7-studies.json.gz.b64', import.meta.url), 'utf8');
  const previous = z.object({ format: z.literal('clinmesh.snapshot.v7'), workspaceId: z.uuidv7(), tables: z.array(z.object({ name: z.string(), rows: z.array(z.json()) })), pi: z.array(z.json()), sha256: z.literal('8e2a52cbb52f03ff602bae4f448ccc0a2b340c6b52f7c49e9a675019471e7c14') }).parse(JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString()));
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const migrated = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(migrated.format).toBe('clinmesh.snapshot.v9');
    expect(migrated.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    expect(previous.tables.at(-1)).toMatchObject({ name: 'study_requests', rows: [expect.any(Object), expect.objectContaining({ prior_surgery_id: 'excision-01' })] });
    const { ticket, encounterId } = await store.read(reader => {
      const at = { workspaceId: previous.workspaceId, epoch: reader.listEpochs(previous.workspaceId)[0]!.epoch };
      const visitor = reader.list(at, 'visitor_sessions')[0]!;
      return { ticket: { kind: 'visitor' as const, workspaceId: at.workspaceId, id: visitor.id, expiresAt: visitor.expires_at }, encounterId: reader.list(at, 'encounters')[0]!.id };
    });
    const app = createWorkspaceApp(store, { localOpen: true }, builtinModules);
    const get = async (path: string) => {
      const response = await app.request(path, {}, { credential: { ticket }, entering: false });
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const bundle = z.object({ total: z.int(), entry: z.array(z.object({ resource: z.object({ id: z.string(), conclusion: z.string() }) })) });
    expect(bundle.parse(await get('/fhir/R5/DiagnosticReport')).total).toBe(2);
    for (const kind of ['imaging', 'pathology'] as const) {
      const [order] = studyViewSchema.parse(await get(`/api/his/encounters/${encounterId}/${kind}`)).orders;
      expect(order?.reports).toMatchObject([{ version: 1, acknowledged: { role: 'clinician' } }, { version: 2, acknowledged: null }]);
      for (const report of order!.reports) {
        const resource = z.object({ conclusion: z.string(), meta: z.object({ versionId: z.string() }) }).parse(await get(`/fhir/R5/DiagnosticReport/${order!.id}/_history/${report.version}`));
        expect(resource.meta.versionId).toBe(String(report.version));
        const sections = report.sections;
        if (sections.kind === 'imaging') { expect(resource.conclusion).toContain(sections.findings.en); expect(resource.conclusion).toContain(sections.impression.en); }
        else if (sections.kind === 'pathology') { expect(resource.conclusion).toContain(sections.microscopy.en); expect(resource.conclusion).toContain(sections.diagnosis.en); }
        else throw Error('Expected a structured study report');
      }
    }
    expect(await store.exportLogicalSnapshot(previous.workspaceId)).toEqual(migrated);
  } finally { await store.close(); }
});
