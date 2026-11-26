import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, expectTypeOf, it } from 'vitest';
import { createNodeSqliteStore, runStoreConformanceSuite, type PublicEntity, type EditableEntity } from '../index';
import { verifyRestore } from './conformance';

it('runs the portable contract against files and reopens the persisted workspace', async () => {
  const directory = mkdtempSync(resolve('node_modules', '.clinmesh-store-'));
  const dbPath = join(directory, 'source.sqlite');
  const source = createNodeSqliteStore({ dbPath });
  const target = createNodeSqliteStore({ dbPath: join(directory, 'target.sqlite') });
  try {
    const peer = createNodeSqliteStore({ dbPath });
    try {
      const sharedWriter = await Promise.all([
        source.withTransaction(async tx => { await Promise.resolve(); return tx.getWorkspace('0192eaf2-cb03-7000-8000-000000000001'); }),
        peer.withTransaction(tx => tx.getWorkspace('0192eaf2-cb03-7000-8000-000000000001')),
      ]);
      expect(sharedWriter).toEqual([undefined, undefined]);
    } finally { await peer.close(); }
    const snapshot = await runStoreConformanceSuite(source, value => verifyRestore(target, value));
    await source.close();
    const reopened = createNodeSqliteStore({ dbPath });
    try { expect(await reopened.exportLogicalSnapshot(snapshot.workspaceId)).toEqual(snapshot); } finally { await reopened.close(); }
  } finally {
    await Promise.all([source.close(), target.close()]);
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
  expectTypeOf<'case_truths'>().not.toExtend<PublicEntity>();
  expectTypeOf<'clinical_record_revisions' | 'audit_events'>().not.toExtend<EditableEntity>();
});
