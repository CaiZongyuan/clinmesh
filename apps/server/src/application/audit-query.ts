import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

export interface AuditEventView {
  actorId: string
  auditId: string
  currentHash: string
  operation: string
  outcome: string
  previousHash: string
  sequence: number
}

export class AuditQuery {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  list(context: RepositoryContext): AuditEventView[] {
    const rows = this.#database.driver.prepare(`
      SELECT audit_id, sequence, previous_hash, current_hash, actor_id, operation, outcome
      FROM audit_log
      WHERE workspace_id = ? AND epoch = ?
      ORDER BY sequence
    `).all(context.workspaceId, context.epoch) as Array<{
      actor_id: string
      audit_id: string
      current_hash: string
      operation: string
      outcome: string
      previous_hash: string
      sequence: number
    }>
    return rows.map(row => ({
      actorId: row.actor_id,
      auditId: row.audit_id,
      currentHash: row.current_hash,
      operation: row.operation,
      outcome: row.outcome,
      previousHash: row.previous_hash,
      sequence: row.sequence,
    }))
  }
}
