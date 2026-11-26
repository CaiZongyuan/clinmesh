import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import { createNodeSqliteStore } from '../../store';
import { clinicalContract } from './clinical-contract';

function verify(result: Awaited<ReturnType<typeof clinicalContract>>, changed: boolean) {
  expect(result).toMatchObject({ incomplete: 'REQUIRED_FIELDS_MISSING', staleDraft: 'VERSION_CONFLICT', invalidCoding: 'DIAGNOSIS_NOT_IN_CATALOG', twoPrimary: 'ONE_PRIMARY_DIAGNOSIS_REQUIRED' });
  expect(result.dirty).toMatchObject({ checks: expect.arrayContaining([{ id: 'drafts-reviewed', label: expect.anything(), passed: false }]) });
  expect(result.before.turns.map(turn => [turn.ordinal, turn.speaker, turn.channel])).toEqual([[1, 'patient', 'text'], [2, 'clinician', 'voice'], [3, 'patient', 'text']]);
  expect(result.before.recordRevisions.map(item => item.fields.concern)).toEqual(['concern', 'Amended']);
  expect(result.before.recordRevisions[1]?.previousId).toBe(result.before.recordRevisions[0]!.id);
  expect(result.before.diagnosisRevisions.map(item => item.diagnoses.filter(member => member.primary).map(member => member.code))).toEqual([['J18.9'], ['I10']]);
  expect(result.before.diagnosisRevisions[1]?.previousId).toBe(result.before.diagnosisRevisions[0]!.id);
  expect(result.before.completion.ready).toBe(true);
  expect(result.outcomes).toEqual(Array(2).fill(changed ? 'COMPLETION_BLOCKED' : 'committed'));
  expect(result.after).toMatchObject({ encounter: { status: changed ? 'active' : 'completed', version: changed ? 13 : 14 }, audits: changed ? 0 : 1, receipts: changed ? 0 : 1 });
}
it.each([false, true])('checks live pre-freeze module facts and immutable revisions in Node SQLite (changed=%s)', async changed => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try { verify(await clinicalContract(store, changed), changed); } finally { await store.close(); }
});
it('checks both completion decisions and revision chains on Durable Object SQLite', async () => {
  const server = createTestHarness({ workers: [{ config: { name: 'clinical-contract', main: 'src/packages/clinical-core/tests/clinical-worker.ts', compatibility_date: '2026-11-19', compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'CLINIC', class_name: 'ClinicalWorkspace' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['ClinicalWorkspace'] }] } }] });
  try {
    await server.listen();
    for (const changed of [false, true]) {
      const response = await server.getWorker().fetch(changed ? '/change' : '/same');
      expect(response.status).toBe(200);
      verify(await response.json() as Awaited<ReturnType<typeof clinicalContract>>, changed);
    }
  } finally { await server.close(); }
}, 30_000);
