import type { ClinMeshDatabase } from './database.ts'

type QueuedJobRow = { created_at: string; job_id: string; workspace_id: string }
type Position = readonly [createdAt: string, jobId: string]

/** Scheduling progress only; persisted jobs and model request budgets remain authoritative. */
export class QueuedJobScan<T extends QueuedJobRow> {
  #after: Position = ['', '']
  #end: Position | undefined

  constructor(private readonly database: ClinMeshDatabase, private readonly selectJob: string,
    private readonly parse: (row: unknown) => T) {}

  next(canResume: (workspaceId: string, taskId: string) => boolean): T | undefined {
    let canWrap = this.#end !== undefined
    while (true) {
      if (this.#end === undefined) {
        const row = this.database.driver.prepare(`${this.selectJob}
          WHERE status = 'queued' ORDER BY created_at DESC, job_id DESC LIMIT 1`).get()
        if (row === undefined) return undefined
        const last = this.parse(row)
        this.#end = [last.created_at, last.job_id]
      }
      const next = this.database.driver.prepare(`${this.selectJob}
        WHERE status = 'queued' AND (created_at, job_id) > (?, ?) AND (created_at, job_id) <= (?, ?)
        ORDER BY created_at, job_id LIMIT 1`)
      while (true) {
        // Finish the read before readiness checks, which can open nested write transactions.
        const row = next.get(...this.#after, ...this.#end)
        if (row === undefined) break
        const candidate = this.parse(row)
        this.#after = [candidate.created_at, candidate.job_id]
        if (canResume(candidate.workspace_id, candidate.job_id)) return candidate
      }
      this.#after = ['', '']
      this.#end = undefined
      if (!canWrap) return undefined
      // Fix a new tail only after finishing the previous round; arrivals cannot extend that round.
      canWrap = false
    }
  }
}
