import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import { openStudyWorkspace, studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { parseHospitalDataPack } from '../../data-pack';
import { issueReceipt, labViewSchema } from '../../mod-lab';
import { createNodeSqliteStore } from '../../store';

const authoredSummary = { en: 'Focal right lower lobe consolidation.', zh: '右肺下叶局灶性实变。' };
const compressed = readFileSync(new URL('./fixtures/cc914872-visible-studies.json.gz', import.meta.url));
const archive = z.object({ workspaceId: z.uuidv7(), format: z.literal('clinmesh.snapshot.v6'), sha256: z.literal('ab9b0df02f2c0b7452744267cdb56e8d0f1054e8712ea2429419b7df790c6d69'), tables: z.array(z.object({ name: z.string(), rows: z.array(z.record(z.string(), z.json())) })), pi: z.array(z.json()) }).parse(JSON.parse(gunzipSync(compressed).toString('utf8')));

it('retains v6 oversized image series, signs the authored chest report, and publishes troponin at 12 ng/L', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(archive);
    const workspaceId = archive.workspaceId;
    const at = await store.read(reader => ({ workspaceId, epoch: reader.listEpochs(workspaceId)[0]!.epoch }));
    const radiology = await openStudyWorkspace(store, at, workspaceId, {}, 'Avery Reed');
    const imaging = radiology.study('imaging');
    const report = await imaging.report(await imaging.issue('Chest radiograph'));
    expect(report).toMatchObject({ sections: { kind: 'summary', summary: authoredSummary }, version: 1, frameCount: 0, requireFirstFrame: false });
    await imaging.review(report.id, 'acknowledge', 4, 1, 'text');
    const laboratory = await openStudyWorkspace(store, at, workspaceId, {}, 'Jordan Vale');
    const path = `${laboratory.base}/lab`;
    const view = async () => labViewSchema.parse(await laboratory.read(path));
    const service = (await view()).services.find(item => item.code === 'hs-tni')!;
    await laboratory.write(`${path}/draft`, 0, { serviceIds: [service.id] }, undefined, 'PUT');
    const draft = (await view()).draft;
    const issued = issueReceipt.parse(await laboratory.write(`${path}/issue`, draft.version, { items: draft.items }));
    const orderId = z.object({ orderId: z.uuidv7() }).parse(issued.results[0]).orderId;
    for (const [index, action] of ['accept', 'start', 'report-now'].entries()) await laboratory.write(`/api/his/lab/orders/${orderId}/${action}`, index + 1);
    expect((await view()).orders[0]).toMatchObject({ status: 'reported', reports: [{ observations: [{ value: 12, unit: 'ng/L' }] }] });
    const restored = await store.exportLogicalSnapshot(workspaceId);
    const original = archive.tables.find(table => table.name === 'case_truths');
    expect(restored.tables.find(table => table.name === 'case_truths')).toEqual(original);
    const imageLists = original!.rows.flatMap(row => z.object({ results: z.array(z.object({ images: z.array(z.string()).optional() })) }).parse(row.truth).results.flatMap(result => result.images ? [result.images] : []));
    expect(imageLists.map(images => images.length).sort()).toEqual([129, 130]);
    expect(imageLists.some(images => images.some(ref => ref.length > 2048))).toBe(true);
    const missing = laboratory.study('imaging');
    const missingId = await missing.issue('Chest radiograph');
    await missing.advance(missingId, 'accept', 1); await missing.advance(missingId, 'start', 2);
    expect(await missing.advance(missingId, 'report-now', 3)).toMatchObject({ status: 'generation-failed' });
  } finally { await store.close(); }
});

it('serves the original general-clinic chest report with only radiology enabled', async () => {
  const pack = structuredClone(parseHospitalDataPack(general));
  pack.manifest.enabledModules = ['mod-imaging'];
  const host = await studyWorkspace(pack, {}, 'Avery Reed');
  try {
    const imaging = host.study('imaging');
    const report = await imaging.report(await imaging.issue('Chest radiograph'));
    expect(report.sections).toEqual({ kind: 'summary', summary: authoredSummary });
    await imaging.review(report.id, 'acknowledge', 4, 1, 'text');
    expect((await imaging.view()).orders[0]!.reports[0]!.acknowledged?.role).toBe('family-clinician');
  } finally { await host.close(); }
});

it.each([
  { invalid: '129 frames', images: Array.from({ length: 129 }, () => 'series/frame.png') },
  { invalid: 'overlong URL', images: [`https://teaching.invalid/frame.png?signature=${'a'.repeat(2048)}`] },
  { invalid: 'URL with embedded credentials', images: ['https://account:demo@example.invalid/frame.png'] },
])('rejects $invalid on new installation', ({ images }) => {
  const pack = structuredClone(parseHospitalDataPack(general));
  pack.cases[0]!.caseTruth.results[0]!.images = images;
  expect(() => parseHospitalDataPack(pack)).toThrow('INVALID_PACK');
});
