import {
  investigationResultSnapshotSchema,
  type InvestigationResultSnapshot,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'

const rowSchema = z.object({
  case_id: z.string().min(1),
  catalog_item_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  model_id: z.string().min(1).nullable(),
  output_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  prompt_version: z.string().min(1).nullable(),
  provenance_json: z.string().nullable(),
  requested_concept_json: z.string(),
  result_json: z.string(),
  snapshot_id: z.string().min(1),
  source: z.enum(['synthea-exact', 'investigation-agent']),
  source_detail: z.enum(['adult-reference-baseline', 'mixed']).nullable(),
  workspace_id: z.string().min(1),
}).strict()

const selectSnapshot = `
  SELECT workspace_id, snapshot_id, case_id, catalog_item_id,
    requested_concept_json, result_json, source, source_detail, provenance_json, model_id,
    prompt_version, prompt_hash, input_hash, output_hash, created_at
  FROM investigation_result_snapshot
`

export class InvestigationResultRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  getByCaseItem(
    workspaceId: string,
    caseId: string,
    catalogItemId: string,
  ): InvestigationResultSnapshot | undefined {
    const row = this.#database.driver.prepare(`${selectSnapshot}
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = ?
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1
    `).get(workspaceId, caseId, catalogItemId)
    return row === undefined ? undefined : this.#map(rowSchema.parse(row))
  }

  getByEvidence(
    workspaceId: string,
    caseId: string,
    catalogItemId: string,
    inputHash: string,
  ): InvestigationResultSnapshot | undefined {
    const row = this.#database.driver.prepare(`${selectSnapshot}
      WHERE workspace_id = ? AND case_id = ? AND catalog_item_id = ? AND input_hash = ?
    `).get(workspaceId, caseId, catalogItemId, inputHash)
    return row === undefined ? undefined : this.#map(rowSchema.parse(row))
  }

  getById(workspaceId: string, snapshotId: string): InvestigationResultSnapshot | undefined {
    const row = this.#database.driver.prepare(`${selectSnapshot}
      WHERE workspace_id = ? AND snapshot_id = ?
    `).get(workspaceId, snapshotId)
    return row === undefined ? undefined : this.#map(rowSchema.parse(row))
  }

  createOrGet(snapshot: InvestigationResultSnapshot): InvestigationResultSnapshot {
    const parsed = investigationResultSnapshotSchema.parse(snapshot)
    this.#database.driver.prepare(`
      INSERT INTO investigation_result_snapshot (
        workspace_id, snapshot_id, case_id, catalog_item_id,
        requested_concept_json, result_json, source, source_detail, provenance_json, model_id,
        prompt_version, prompt_hash, input_hash, output_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, case_id, catalog_item_id, input_hash) DO NOTHING
    `).run(
      parsed.workspaceId,
      parsed.snapshotId,
      parsed.caseId,
      parsed.catalogItemId,
      JSON.stringify(parsed.requestedConcept),
      JSON.stringify(parsed.content),
      parsed.source === 'adult-reference-baseline'
        || (parsed.source === 'mixed' && parsed.model === null)
        ? 'synthea-exact'
        : parsed.source === 'mixed' ? 'investigation-agent' : parsed.source,
      parsed.source === 'adult-reference-baseline' || parsed.source === 'mixed'
        ? parsed.source
        : null,
      parsed.provenance === undefined ? null : JSON.stringify(parsed.provenance),
      parsed.model,
      parsed.promptVersion,
      parsed.promptHash,
      parsed.inputHash,
      parsed.outputHash,
      parsed.createdAt,
    )
    return this.getByEvidence(
      parsed.workspaceId,
      parsed.caseId,
      parsed.catalogItemId,
      parsed.inputHash,
    )!
  }

  #map(row: z.infer<typeof rowSchema>): InvestigationResultSnapshot {
    return investigationResultSnapshotSchema.parse({
      caseId: row.case_id,
      catalogItemId: row.catalog_item_id,
      content: JSON.parse(row.result_json),
      createdAt: row.created_at,
      inputHash: row.input_hash,
      model: row.model_id,
      outputHash: row.output_hash,
      promptHash: row.prompt_hash,
      promptVersion: row.prompt_version,
      ...(row.provenance_json === null ? {} : { provenance: JSON.parse(row.provenance_json) }),
      requestedConcept: JSON.parse(row.requested_concept_json),
      snapshotId: row.snapshot_id,
      source: row.source_detail ?? row.source,
      workspaceId: row.workspace_id,
    })
  }
}
