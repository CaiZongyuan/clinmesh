import type { ScenarioDataset, ScenarioDatasetList } from '@clinmesh/contracts/scenario'
import { scenarioDatasetSchema } from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'

const scenarioDatasetRowSchema = z.object({
  content_hash: z.string(),
  content_json: z.string(),
  created_at: z.string(),
  dataset_id: z.string(),
  diagnostics_json: z.string(),
  name: z.string(),
  provider_id: z.enum(['builtin', 'synthea']),
  updated_at: z.string(),
  version: z.number().int().positive(),
  workspace_id: z.string(),
}).strict()

const countRowSchema = z.object({ count: z.number().int().nonnegative() }).strict()

type ScenarioDatasetRow = z.infer<typeof scenarioDatasetRowSchema>

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
    const result = this.#database.driver.prepare(`
      SELECT workspace_id, dataset_id, name, provider_id, version, content_json,
        content_hash, diagnostics_json, created_at, updated_at
      FROM scenario_dataset
      WHERE workspace_id = ? AND dataset_id = ?
    `).get(workspaceId, datasetId)
    if (result === undefined) return undefined
    const row = scenarioDatasetRowSchema.parse(result)
    return this.#map(row)
  }

  list(input: {
    page: number
    pageSize: number
    search?: string
    workspaceId: string
  }): ScenarioDatasetList {
    const search = input.search ?? null
    const total = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM scenario_dataset
      WHERE workspace_id = ?
        AND (
          ? IS NULL
          OR instr(lower(name), lower(?)) > 0
          OR instr(lower(dataset_id), lower(?)) > 0
          OR instr(lower(provider_id), lower(?)) > 0
        )
    `).get(input.workspaceId, search, search, search, search)).count
    const rows = z.array(scenarioDatasetRowSchema).parse(this.#database.driver.prepare(`
      SELECT workspace_id, dataset_id, name, provider_id, version, content_json,
        content_hash, diagnostics_json, created_at, updated_at
      FROM scenario_dataset
      WHERE workspace_id = ?
        AND (
          ? IS NULL
          OR instr(lower(name), lower(?)) > 0
          OR instr(lower(dataset_id), lower(?)) > 0
          OR instr(lower(provider_id), lower(?)) > 0
        )
      ORDER BY updated_at DESC, dataset_id
      LIMIT ? OFFSET ?
    `).all(
      input.workspaceId,
      search,
      search,
      search,
      search,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ))
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
