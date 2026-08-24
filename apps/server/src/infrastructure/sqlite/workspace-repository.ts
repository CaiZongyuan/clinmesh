import type { ClinMeshDatabase } from './database.ts'
import type { RepositoryContext } from './fhir-repository.ts'

export interface InstallWorkspaceInput extends RepositoryContext {
  scenarioId: string
  scenarioRunId: string
  workspaceName: string
}

export class WorkspaceContextError extends Error {
  readonly code = 'CONTEXT_INACTIVE'
}

export class WorkspaceRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  install(input: InstallWorkspaceInput): void {
    const now = new Date().toISOString()
    this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      this.#database.driver.prepare(`
        INSERT INTO workspace (workspace_id, name, active_epoch, created_at)
        VALUES (?, ?, NULL, ?)
      `).run(input.workspaceId, input.workspaceName, now)
      this.#database.driver.prepare(`
        INSERT INTO workspace_epoch (
          workspace_id, epoch, state, scenario_id, created_at, activated_at
        ) VALUES (?, ?, 'active', ?, ?, ?)
      `).run(input.workspaceId, input.epoch, input.scenarioId, now, now)
      this.#database.driver.prepare(`
        INSERT INTO scenario_run (
          workspace_id, epoch, scenario_run_id, scenario_id, status, started_at
        ) VALUES (?, ?, ?, ?, 'active', ?)
      `).run(input.workspaceId, input.epoch, input.scenarioRunId, input.scenarioId, now)
      this.#database.driver.prepare(`
        UPDATE workspace SET active_epoch = ? WHERE workspace_id = ?
      `).run(input.epoch, input.workspaceId)
      this.#database.driver.prepare(`
        INSERT INTO audit_head (workspace_id, epoch, sequence, hash)
        VALUES (?, ?, 0, ?)
      `).run(input.workspaceId, input.epoch, '0'.repeat(64))
      this.#database.driver.exec('COMMIT')
    } catch (error) {
      this.#database.driver.exec('ROLLBACK')
      throw error
    }
  }

  assertActive(context: RepositoryContext, scenarioRunId: string): void {
    const row = this.#database.driver.prepare(`
      SELECT run.status AS run_status, epoch.state AS epoch_state
      FROM workspace
      JOIN workspace_epoch AS epoch
        ON epoch.workspace_id = workspace.workspace_id
       AND epoch.epoch = workspace.active_epoch
      JOIN scenario_run AS run
        ON run.workspace_id = epoch.workspace_id
       AND run.epoch = epoch.epoch
      WHERE workspace.workspace_id = ?
        AND workspace.active_epoch = ?
        AND run.scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, scenarioRunId) as {
      epoch_state: string
      run_status: string
    } | undefined
    if (row === undefined || row.epoch_state !== 'active' || row.run_status !== 'active') {
      throw new WorkspaceContextError('The Workspace, Epoch, or Scenario Run is not active')
    }
  }

  assertKnown(context: RepositoryContext, scenarioRunId: string): void {
    const row = this.#database.driver.prepare(`
      SELECT 1
      FROM workspace_epoch AS epoch
      JOIN scenario_run AS run
        ON run.workspace_id = epoch.workspace_id
       AND run.epoch = epoch.epoch
      WHERE epoch.workspace_id = ? AND epoch.epoch = ?
        AND run.scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, scenarioRunId)
    if (row === undefined) {
      throw new WorkspaceContextError('The Workspace, Epoch, or Scenario Run is unknown')
    }
  }
}
