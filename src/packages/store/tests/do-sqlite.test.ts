import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import { createNodeSqliteStore, type LogicalSnapshot } from '../index';
import { verifyRestore } from './conformance';
import billingBaseline from './fixtures/e3842543-v3.json';
import { patientBaseline } from './patient-baseline';

it('runs the Store contract inside a real Workspace Durable Object', async () => {
  const server = createTestHarness({ workers: [{ config: {
    name: 'store-conformance', main: 'src/packages/store/tests/conformance-worker.ts', compatibility_date: '2026-11-19',
    compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'STORE', class_name: 'ConformanceObject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ConformanceObject'] }],
  } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const response = await worker.fetch('/conformance');
    expect(response.status).toBe(200);
    const snapshot = await response.json() as LogicalSnapshot;
    const node = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const nodeSnapshot = await verifyRestore(node, snapshot);
      expect(nodeSnapshot).toEqual(snapshot);
      const fromNode = await worker.fetch('/restore', { method: 'POST', body: JSON.stringify(nodeSnapshot) });
      expect(await fromNode.json()).toEqual(snapshot);
      for (const previous of [billingBaseline, patientBaseline]) {
        const imported = await worker.fetch(`/${previous.format}`, { method: 'POST', body: JSON.stringify(previous) });
        const upgraded = await imported.json() as LogicalSnapshot;
        expect(upgraded.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
        expect(upgraded.pi).toEqual(previous.pi);
        expect(upgraded.tables.find(table => table.name === 'inventory_lot_quarantines')!.rows).toMatchObject([{ source_version: previous.format, quantity_at_migration: -3 }]);
      }
    } finally { await node.close(); }
  } finally { await server.close(); }
}, 30_000);
