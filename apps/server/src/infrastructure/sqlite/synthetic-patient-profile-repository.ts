import {
  syntheticPatientProfileListSchema,
  syntheticPatientProfileSchema,
  type SyntheticPatientProfile,
  type SyntheticPatientProfileList,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'

const rowSchema = z.object({
  batch_id: z.string().min(1),
  batch_name: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  demographics_json: z.string(),
  display_name: z.string().min(1),
  generation_json: z.string(),
  identity_json: z.string(),
  localization_provenance_json: z.string().nullable(),
  mrn: z.string().min(1),
  profile_id: z.string().min(1),
  raw_source_json: z.string(),
  revision: z.number().int().positive(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_patient_id: z.string().min(1),
  updated_at: z.iso.datetime({ offset: true }),
  workspace_id: z.string().min(1),
}).strict()

const selectProfile = `
  SELECT workspace_id, profile_id, batch_id, batch_name, source_patient_id,
    revision, display_name, mrn, identity_json, demographics_json,
    source_hash, raw_source_json, generation_json,
    localization_provenance_json, created_at, updated_at
  FROM synthetic_patient_profile
`

export class SyntheticPatientProfileRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  createBatch(profiles: readonly SyntheticPatientProfile[], actorId: string): void {
    const insert = this.#database.driver.prepare(`
      INSERT INTO synthetic_patient_profile (
        workspace_id, profile_id, batch_id, batch_name, source_patient_id,
        revision, display_name, mrn, identity_json, demographics_json,
        source_hash, raw_source_json, generation_json,
        localization_provenance_json, created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, profile_id) DO NOTHING
    `)
    for (const value of profiles) {
      const profile = syntheticPatientProfileSchema.parse(value)
      const result = insert.run(
        profile.workspaceId,
        profile.profileId,
        profile.source.batchId,
        profile.source.batchName,
        profile.source.patientId,
        profile.revision,
        profile.identity.displayName,
        profile.identity.mrn,
        JSON.stringify(profile.identity),
        JSON.stringify(profile.demographics),
        profile.source.hash,
        JSON.stringify(profile.source.raw),
        JSON.stringify(profile.source.generation),
        profile.source.localization === undefined
          ? null
          : JSON.stringify(profile.source.localization),
        actorId,
        profile.createdAt,
        profile.updatedAt,
      )
      if (result.changes === 1) this.#insertRevision(profile, actorId)
      this.#database.driver.prepare(`
        INSERT INTO synthetic_patient_profile_batch (
          workspace_id, profile_id, batch_id, batch_name, provider_id, created_at
        ) VALUES (?, ?, ?, ?, 'synthea', ?)
        ON CONFLICT (workspace_id, profile_id, batch_id) DO NOTHING
      `).run(
        profile.workspaceId,
        profile.profileId,
        profile.source.batchId,
        profile.source.batchName,
        profile.createdAt,
      )
    }
  }

  get(workspaceId: string, profileId: string): SyntheticPatientProfile | undefined {
    const row = this.#database.driver.prepare(`${selectProfile}
      WHERE workspace_id = ? AND profile_id = ?
    `).get(workspaceId, profileId)
    return row === undefined ? undefined : this.#map(rowSchema.parse(row))
  }

  getRevision(
    workspaceId: string,
    profileId: string,
    revision: number,
  ): SyntheticPatientProfile | undefined {
    const current = this.get(workspaceId, profileId)
    if (current === undefined) return undefined
    const row = z.object({
      created_at: z.iso.datetime({ offset: true }),
      demographics_json: z.string(),
      identity_json: z.string(),
    }).strict().optional().parse(this.#database.driver.prepare(`
      SELECT identity_json, demographics_json, created_at
      FROM synthetic_patient_profile_revision
      WHERE workspace_id = ? AND profile_id = ? AND revision = ?
    `).get(workspaceId, profileId, revision))
    if (row === undefined) return undefined
    return syntheticPatientProfileSchema.parse({
      ...current,
      demographics: JSON.parse(row.demographics_json),
      identity: JSON.parse(row.identity_json),
      revision,
      updatedAt: row.created_at,
    })
  }

  mrnBelongsToOtherProfile(workspaceId: string, mrn: string, profileId: string): boolean {
    return this.#database.driver.prepare(`
      SELECT 1 AS present FROM synthetic_patient_profile
      WHERE workspace_id = ? AND mrn = ? AND profile_id != ? LIMIT 1
    `).get(workspaceId, mrn, profileId) !== undefined
  }

  list(input: {
    epoch: string
    page: number
    pageSize: number
    search?: string
    workspaceId: string
  }): SyntheticPatientProfileList {
    const query = input.search ?? null
    const bindings = [input.workspaceId, query, query, query, query] as const
    const total = z.object({ count: z.number().int().nonnegative() }).strict().parse(
      this.#database.driver.prepare(`
        SELECT COUNT(*) AS count FROM synthetic_patient_profile
        WHERE workspace_id = ? AND (
          ? IS NULL OR instr(lower(display_name), lower(?)) > 0
          OR instr(lower(mrn), lower(?)) > 0
          OR instr(lower(batch_name), lower(?)) > 0
        )
      `).get(...bindings),
    ).count
    const rows = z.array(rowSchema.extend({
      active_visit: z.number().int(),
      history_count: z.number().int().nonnegative(),
    })).parse(
      this.#database.driver.prepare(`
        SELECT profile.workspace_id, profile.profile_id, profile.batch_id,
          profile.batch_name, profile.source_patient_id, profile.revision,
          profile.display_name, profile.mrn, profile.identity_json,
          profile.demographics_json, profile.source_hash, profile.raw_source_json,
          profile.generation_json, profile.localization_provenance_json,
          profile.created_at, profile.updated_at,
          COALESCE((
            SELECT visible_history_count
            FROM synthetic_case_instance AS synthetic_case
            WHERE synthetic_case.workspace_id = profile.workspace_id
              AND synthetic_case.profile_id = profile.profile_id
              AND synthetic_case.profile_revision = profile.revision
          ), 0) AS history_count,
          EXISTS (
            SELECT 1
            FROM synthetic_case_materialization AS materialization
            JOIN outpatient_case AS outpatient
              ON outpatient.workspace_id = materialization.workspace_id
             AND outpatient.epoch = materialization.epoch
             AND outpatient.case_id = materialization.outpatient_case_id
            WHERE materialization.workspace_id = profile.workspace_id
              AND materialization.epoch = ?
              AND materialization.profile_id = profile.profile_id
              AND outpatient.status != 'completed'
          ) AS active_visit
        FROM synthetic_patient_profile AS profile
        WHERE profile.workspace_id = ? AND (
          ? IS NULL OR instr(lower(profile.display_name), lower(?)) > 0
          OR instr(lower(profile.mrn), lower(?)) > 0
          OR instr(lower(profile.batch_name), lower(?)) > 0
        )
        ORDER BY profile.updated_at DESC, profile.profile_id
        LIMIT ? OFFSET ?
      `).all(
        input.epoch,
        ...bindings,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ),
    )
    return syntheticPatientProfileListSchema.parse({
      items: rows.map((row) => {
        const profile = this.#map(row)
        return {
          activeVisit: row.active_visit === 1,
          batchId: profile.source.batchId,
          batchName: profile.source.batchName,
          birthDate: profile.demographics.birthDate,
          createdAt: profile.createdAt,
          gender: profile.demographics.gender,
          historyCount: row.history_count,
          mrn: profile.identity.mrn,
          name: profile.identity.displayName,
          profileId: profile.profileId,
          providerId: 'synthea',
          revision: profile.revision,
          updatedAt: profile.updatedAt,
        }
      }),
      page: input.page,
      pageSize: input.pageSize,
      total,
    })
  }

  update(profile: SyntheticPatientProfile, expectedRevision: number, actorId: string): boolean {
    const parsed = syntheticPatientProfileSchema.parse(profile)
    const result = this.#database.driver.prepare(`
      UPDATE synthetic_patient_profile
      SET revision = ?, display_name = ?, mrn = ?, identity_json = ?,
        demographics_json = ?, updated_at = ?
      WHERE workspace_id = ? AND profile_id = ? AND revision = ?
    `).run(
      parsed.revision,
      parsed.identity.displayName,
      parsed.identity.mrn,
      JSON.stringify(parsed.identity),
      JSON.stringify(parsed.demographics),
      parsed.updatedAt,
      parsed.workspaceId,
      parsed.profileId,
      expectedRevision,
    )
    if (result.changes !== 1) return false
    this.#insertRevision(parsed, actorId)
    return true
  }

  #insertRevision(profile: SyntheticPatientProfile, actorId: string): void {
    this.#database.driver.prepare(`
      INSERT INTO synthetic_patient_profile_revision (
        workspace_id, profile_id, revision, identity_json,
        demographics_json, created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.workspaceId,
      profile.profileId,
      profile.revision,
      JSON.stringify(profile.identity),
      JSON.stringify(profile.demographics),
      actorId,
      profile.updatedAt,
    )
  }

  #map(row: z.infer<typeof rowSchema>): SyntheticPatientProfile {
    return syntheticPatientProfileSchema.parse({
      createdAt: row.created_at,
      demographics: JSON.parse(row.demographics_json),
      identity: JSON.parse(row.identity_json),
      profileId: row.profile_id,
      revision: row.revision,
      source: {
        batchId: row.batch_id,
        batchName: row.batch_name,
        format: 'fhir-r4-bundle',
        generation: JSON.parse(row.generation_json),
        hash: row.source_hash,
        ...(row.localization_provenance_json === null
          ? {}
          : { localization: JSON.parse(row.localization_provenance_json) }),
        patientId: row.source_patient_id,
        providerId: 'synthea',
        raw: JSON.parse(row.raw_source_json),
      },
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })
  }
}
