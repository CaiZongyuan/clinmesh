import type { ScenarioDataset, ScenarioDatasetList } from '@clinmesh/contracts/scenario'
import { scenarioDatasetSchema } from '@clinmesh/contracts/scenario'
import type { ClinMeshDatabase } from './database.ts'

interface ScenarioDatasetRow {
  content_hash: string
  content_json: string
  created_at: string
  dataset_id: string
  diagnostics_json: string
  name: string
  provider_id: ScenarioDataset['providerId']
  updated_at: string
  version: number
  workspace_id: string
}

export class ScenarioDatasetRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  create(dataset: ScenarioDataset, actorId: string): void {
    this.#database.driver.prepare(`
      INSERT INTO scenario_dataset (
        workspace_id, dataset_id, name, provider_id, version, content_json,
        content_hash, diagnostics_json, created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dataset.workspaceId,
      dataset.datasetId,
      dataset.name,
      dataset.providerId,
      dataset.version,
      JSON.stringify(dataset.content),
      dataset.contentHash,
      JSON.stringify(dataset.diagnostics),
      actorId,
      dataset.createdAt,
      dataset.updatedAt,
    )
  }

  createPackage(input: {
    actorId: string
    createdAt: string
    dataset: ScenarioDataset
    packageId: string
  }): void {
    this.#database.driver.prepare(`
      INSERT INTO scenario_package (
        workspace_id, package_id, source_dataset_id, source_dataset_version,
        content_json, content_hash, created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.dataset.workspaceId,
      input.packageId,
      input.dataset.datasetId,
      input.dataset.version,
      JSON.stringify(input.dataset.content),
      input.dataset.contentHash,
      input.actorId,
      input.createdAt,
    )
  }

  delete(workspaceId: string, datasetId: string, expectedVersion: number): boolean {
    const result = this.#database.driver.prepare(`
      DELETE FROM scenario_dataset
      WHERE workspace_id = ? AND dataset_id = ? AND version = ?
    `).run(workspaceId, datasetId, expectedVersion)
    return result.changes === 1
  }

  get(workspaceId: string, datasetId: string): ScenarioDataset | undefined {
    const row = this.#database.driver.prepare(`
      SELECT workspace_id, dataset_id, name, provider_id, version, content_json,
        content_hash, diagnostics_json, created_at, updated_at
      FROM scenario_dataset
      WHERE workspace_id = ? AND dataset_id = ?
    `).get(workspaceId, datasetId) as ScenarioDatasetRow | undefined
    if (row === undefined) return undefined
    return this.#map(row)
  }

  list(input: { page: number; pageSize: number; workspaceId: string }): ScenarioDatasetList {
    const total = (this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM scenario_dataset WHERE workspace_id = ?
    `).get(input.workspaceId) as { count: number }).count
    const rows = this.#database.driver.prepare(`
      SELECT workspace_id, dataset_id, name, provider_id, version, content_json,
        content_hash, diagnostics_json, created_at, updated_at
      FROM scenario_dataset
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, dataset_id
      LIMIT ? OFFSET ?
    `).all(
      input.workspaceId,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ) as ScenarioDatasetRow[]
    return {
      items: rows.map((row) => {
        const dataset = this.#map(row)
        return {
          contentHash: dataset.contentHash,
          createdAt: dataset.createdAt,
          datasetId: dataset.datasetId,
          diagnosticCounts: {
            error: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
            warning: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length,
          },
          name: dataset.name,
          patientCount: dataset.content.patients.length,
          providerId: dataset.providerId,
          updatedAt: dataset.updatedAt,
          version: dataset.version,
        }
      }),
      page: input.page,
      pageSize: input.pageSize,
      total,
    }
  }

  update(dataset: ScenarioDataset, expectedVersion: number): boolean {
    const result = this.#database.driver.prepare(`
      UPDATE scenario_dataset
      SET name = ?, version = ?, content_json = ?, content_hash = ?,
        diagnostics_json = ?, updated_at = ?
      WHERE workspace_id = ? AND dataset_id = ? AND version = ?
    `).run(
      dataset.name,
      dataset.version,
      JSON.stringify(dataset.content),
      dataset.contentHash,
      JSON.stringify(dataset.diagnostics),
      dataset.updatedAt,
      dataset.workspaceId,
      dataset.datasetId,
      expectedVersion,
    )
    return result.changes === 1
  }

  #map(row: ScenarioDatasetRow): ScenarioDataset {
    return scenarioDatasetSchema.parse({
      content: JSON.parse(row.content_json),
      contentHash: row.content_hash,
      createdAt: row.created_at,
      datasetId: row.dataset_id,
      diagnostics: JSON.parse(row.diagnostics_json),
      name: row.name,
      providerId: row.provider_id,
      updatedAt: row.updated_at,
      version: row.version,
      workspaceId: row.workspace_id,
    })
  }
}
