import { z } from 'zod'
import { doctorAgentTaskPermitPayloadSchema } from '@clinmesh/contracts/agent'
import { hostDoctorRecognitionTimeoutMs, type ModelUsageContext } from '@clinmesh/contracts/model-usage'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'

const permit = z.string().min(32).max(8192)
export const hostModelWaitSchema = z.discriminatedUnion('phase', [
  z.object({ permit, phase: z.literal('waiting'), deadlineAt: z.iso.datetime() }).strict(),
  z.object({ permit, phase: z.literal('finished') }).strict(),
])
type Task = z.infer<typeof doctorAgentTaskPermitPayloadSchema>
const rowSchema = z.object({ task_json: z.string(), task_id: z.string(), epoch: z.string() })

/** Short leases expose live Host waiters; they never authorize or schedule model calls. */
export class HostModelWaiting {
  constructor(private readonly database: ClinMeshDatabase, private readonly tasks: {
    verify(token: string): Task
    resolve(task: Task): ModelUsageContext | undefined
    now(): Date
  }) {}

  update(input: z.infer<typeof hostModelWaitSchema>): boolean {
    const task = this.tasks.verify(input.permit)
    if (input.phase === 'finished') {
      // Signature verification permits an expired task to withdraw its own lease.
      this.database.driver.prepare('DELETE FROM model_host_wait WHERE task_id = ?').run(task.taskId)
      return false
    }
    const context = this.tasks.resolve(task)
    if (context === undefined) throw new Error('Host task is no longer valid')
    const now = this.tasks.now().getTime()
    const deadline = Math.min(Date.parse(input.deadlineAt), Date.parse(task.expiresAt), now + hostDoctorRecognitionTimeoutMs)
    if (deadline <= now || this.#admitted(context.workspaceId, context.epoch, task.taskId)) {
      this.clear(context)
      return false
    }
    this.database.driver.prepare(`INSERT INTO model_host_wait(workspace_id, epoch, task_id, task_json, deadline_at, lease_until)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, epoch, task_id) DO UPDATE SET
      deadline_at = MIN(deadline_at, excluded.deadline_at), lease_until = excluded.lease_until`)
      .run(context.workspaceId, context.epoch, task.taskId, JSON.stringify(task), new Date(deadline).toISOString(), new Date(now + 1000).toISOString())
    return true
  }

  clear(context: Pick<ModelUsageContext, 'workspaceId' | 'epoch' | 'taskId'>): void {
    this.database.driver.prepare('DELETE FROM model_host_wait WHERE workspace_id = ? AND epoch = ? AND task_id = ?')
      .run(context.workspaceId, context.epoch, context.taskId)
  }

  count(workspaceId: string): number {
    const now = this.tasks.now().toISOString()
    this.database.driver.prepare('DELETE FROM model_host_wait WHERE lease_until <= ? OR deadline_at <= ?').run(now, now)
    const rows = z.array(rowSchema).parse(this.database.driver.prepare('SELECT task_json, task_id, epoch FROM model_host_wait WHERE workspace_id = ?').all(workspaceId))
    let count = 0
    for (const row of rows) {
      const task = doctorAgentTaskPermitPayloadSchema.parse(JSON.parse(row.task_json))
      const context = this.tasks.resolve(task)
      if (context === undefined || this.#admitted(workspaceId, row.epoch, row.task_id)) {
        this.database.driver.prepare('DELETE FROM model_host_wait WHERE workspace_id = ? AND epoch = ? AND task_id = ?')
          .run(workspaceId, row.epoch, row.task_id)
      } else count++
    }
    return count
  }

  #admitted(workspaceId: string, epoch: string, taskId: string): boolean {
    return this.database.driver.prepare(`SELECT 1 FROM model_usage_attempt WHERE workspace_id = ? AND epoch = ?
      AND feature = 'doctor_delegation' AND json_extract(record_json, '$.context.taskId') = ?`).get(workspaceId, epoch, taskId) !== undefined
  }
}
