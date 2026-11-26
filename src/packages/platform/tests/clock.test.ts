import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import { createNodeSqliteStore } from '../../store';
import { clockContract } from './clock-contract';

const examples = [{ timezone: 'UTC', firstDates: [], lastDates: ['2028-02-29', '2028-03-01'] }, { timezone: 'Asia/Shanghai', firstDates: ['2028-02-29'], lastDates: ['2028-02-29', '2028-03-01', '2028-03-02'] }];
function verify(receipt: Awaited<ReturnType<typeof clockContract>>, example: typeof examples[number]) {
  expect(receipt.first).toMatchObject({ dates: example.firstDates, receipts: 1, audits: 1, time: { clock_revision: 1, virtual_time: '2028-02-28T16:00:00.000Z' } });
  expect(receipt.failure).toBe('CALENDAR_FAILURE');
  expect(receipt.rolledBack).toEqual(receipt.first);
  expect(receipt.last).toMatchObject({ dates: example.lastDates, receipts: 2, audits: 2, time: { clock_revision: 2, virtual_time: '2028-03-01T16:00:00.000Z' } });
  expect(receipt.invalid).toEqual(['VIRTUAL_TIME_OUT_OF_RANGE', 'VIRTUAL_TIME_OUT_OF_RANGE']);
}
it.each(examples)('commits local midnight facts and rolls back failed hooks in Node SQLite ($timezone)', async example => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try { verify(await clockContract(store, example.timezone), example); } finally { await store.close(); }
});
it('runs the same leap-day and async rollback contract on real Durable Object SQLite', async () => {
  const server = createTestHarness({ workers: [{ config: { name: 'core-clock', main: 'src/packages/platform/tests/clock-worker.ts', compatibility_date: '2026-11-19', compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'CLOCK', class_name: 'ClockWorkspace' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['ClockWorkspace'] }] } }] });
  try {
    await server.listen();
    for (const example of examples) {
      const response = await server.getWorker().fetch(`/?timezone=${encodeURIComponent(example.timezone)}`);
      expect(response.status).toBe(200);
      verify(await response.json() as Awaited<ReturnType<typeof clockContract>>, example);
    }
  } finally { await server.close(); }
}, 30_000);
