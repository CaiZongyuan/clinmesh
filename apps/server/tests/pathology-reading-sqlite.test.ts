import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createPathologyReadingScenario } from './fixtures/pathology-reading-scenario.ts'

it('真实SQLite拒绝把会话、检查点或原申请绑定到另一工作区或Epoch', async () => {
  const s = await createPathologyReadingScenario()
  try {
    const opened = await s.session(), driver = s.runtime.database.driver
    const workspaceId = 'workspace-demo', epoch = 'epoch-1', bindingId = [...s.remote.bindings.keys()][0]!
    new WorkspaceRepository(s.runtime.database).install({ workspaceId: 'synthetic-other-workspace', epoch,
      scenarioId: 'synthetic-isolation', scenarioRunId: 'synthetic-other-run', workspaceName: '合成隔离工作区' })
    driver.prepare(`INSERT INTO workspace_epoch (workspace_id,epoch,state,scenario_id,created_at)
      VALUES (?,?,'closed','synthetic-isolation',?)`).run(workspaceId, 'synthetic-other-epoch', new Date().toISOString())
    for (const target of [{ workspaceId: 'synthetic-other-workspace', epoch }, { workspaceId, epoch: 'synthetic-other-epoch' }]) {
      expect(() => driver.prepare(`INSERT INTO pathology_reading_session
        (workspace_id,epoch,id,actor_id,auth_session_id,idempotency_key,request_hash,binding_id,head_report_id,head_report_version,
          context_json,actor_json,generation,config_version,callback_token_hash,expires_at)
        SELECT ?,?,id,actor_id,auth_session_id,idempotency_key,request_hash,binding_id,head_report_id,head_report_version,
          context_json,actor_json,generation,config_version,callback_token_hash,expires_at
        FROM pathology_reading_session WHERE workspace_id=? AND epoch=? AND id=?`)
        .run(target.workspaceId, target.epoch, workspaceId, epoch, opened.id)).toThrow(/FOREIGN KEY constraint failed/)
      expect(() => driver.prepare(`INSERT INTO pathology_reading_checkpoint_intent
        (workspace_id,epoch,binding_id,intent_id,previous_revision) VALUES (?,?,?,?,0)`)
        .run(target.workspaceId, target.epoch, bindingId, randomUUID())).toThrow(/FOREIGN KEY constraint failed/)
      expect(() => driver.prepare(`INSERT INTO pathology_reading_binding
        (workspace_id,epoch,request_id,binding_id,instance_id,content_hash,input_json,state)
        SELECT ?,?,request_id,?,instance_id,content_hash,input_json,state FROM pathology_reading_binding
        WHERE workspace_id=? AND epoch=? AND binding_id=?`)
        .run(target.workspaceId, target.epoch, randomUUID(), workspaceId, epoch, bindingId)).toThrow(/FOREIGN KEY constraint failed/)
    }
    driver.prepare(`INSERT INTO pathology_reading_checkpoint_intent
      (workspace_id,epoch,binding_id,intent_id,previous_revision) VALUES (?,?,?,?,0)`)
      .run(workspaceId, epoch, bindingId, 'synthetic-valid-intent')
    expect(driver.pragma('foreign_key_check')).toEqual([])
  } finally { await s.close() }
})
