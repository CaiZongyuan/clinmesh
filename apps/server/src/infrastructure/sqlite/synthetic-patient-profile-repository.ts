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
  compilation_json: z.string().nullable(),
  created_at: z.string().min(1),
  display_name: z.string().min(1),
  identity_json: z.string(),
  mappings_json: z.string(),
  mapping_provenance_json: z.string().nullable(),
  mapping_version: z.string().min(1),
  mrn: z.string().min(1),
  patient_json: z.string(),
  profile_id: z.string().min(1),
  provider_id: z.enum(['builtin', 'synthea']),
  raw_source_json: z.string().nullable(),
  reference_data_json: z.string().nullable(),
  revision: z.number().int().positive(),
  source_format: z.enum(['clinmesh-template', 'fhir-r4-bundle', 'legacy-compiled-profile']),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_patient_id: z.string().min(1),
  updated_at: z.string().min(1),
  workspace_id: z.string().min(1),
}).strict()

const countSchema = z.object({ count: z.number().int().nonnegative() }).strict()

export class SyntheticPatientProfileRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  createBatch(profiles: readonly SyntheticPatientProfile[], actorId: string): void {
    const insert = this.#database.driver.prepare(`
      INSERT INTO synthetic_patient_profile (
        workspace_id, profile_id, batch_id, batch_name, provider_id,
        source_patient_id, revision, display_name, mrn, identity_json, mappings_json,
        patient_json, source_format, source_hash, raw_source_json, compilation_json,
        mapping_version, mapping_provenance_json, reference_data_json,
        created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, profile_id) DO NOTHING
    `)
    for (const profile of profiles) {
      const parsed = syntheticPatientProfileSchema.parse(profile)
      const inserted = insert.run(
        parsed.workspaceId,
        parsed.profileId,
        parsed.source.batchId,
        parsed.source.batchName,
        parsed.source.providerId,
        parsed.source.patientId,
        parsed.revision,
        parsed.identity.displayName,
        parsed.identity.mrn,
        JSON.stringify(parsed.identity),
        JSON.stringify(parsed.mappings),
        JSON.stringify(parsed.patient),
        parsed.source.format,
        parsed.source.hash,
        parsed.source.raw === null ? null : JSON.stringify(parsed.source.raw),
        parsed.source.compilation === null ? null : JSON.stringify(parsed.source.compilation),
        parsed.source.mappingVersion,
        parsed.source.mappingProvenance === undefined
          ? null
          : JSON.stringify(parsed.source.mappingProvenance),
        parsed.source.referenceData === undefined ? null : JSON.stringify(parsed.source.referenceData),
        actorId,
        parsed.createdAt,
        parsed.updatedAt,
      )
      if (inserted.changes === 1) this.#insertRevision(parsed, actorId)
      this.#database.driver.prepare(`
        INSERT INTO synthetic_patient_profile_batch (
          workspace_id, profile_id, batch_id, batch_name, provider_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, profile_id, batch_id) DO NOTHING
      `).run(
        parsed.workspaceId,
        parsed.profileId,
        parsed.source.batchId,
        parsed.source.batchName,
        parsed.source.providerId,
        parsed.createdAt,
      )
    }
  }

  get(workspaceId: string, profileId: string): SyntheticPatientProfile | undefined {
    const result = this.#database.driver.prepare(`
      SELECT workspace_id, profile_id, batch_id, batch_name, provider_id,
        source_patient_id, revision, display_name, mrn, identity_json, mappings_json,
        patient_json, source_format, source_hash, raw_source_json, compilation_json,
        mapping_version, mapping_provenance_json, reference_data_json, created_at, updated_at
      FROM synthetic_patient_profile
      WHERE workspace_id = ? AND profile_id = ?
    `).get(workspaceId, profileId)
    return result === undefined ? undefined : this.#map(rowSchema.parse(result))
  }

  mrnBelongsToOtherProfile(workspaceId: string, mrn: string, profileId: string): boolean {
    return this.#database.driver.prepare(`
      SELECT 1 AS present
      FROM synthetic_patient_profile
      WHERE workspace_id = ? AND mrn = ? AND profile_id != ?
      LIMIT 1
    `).get(workspaceId, mrn, profileId) !== undefined
  }

  list(input: {
    epoch: string
    page: number
    pageSize: number
    search?: string
    workspaceId: string
  }): SyntheticPatientProfileList {
    const search = input.search ?? null
    const searchBindings = [input.workspaceId, search, search, search, search] as const
    const total = countSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_patient_profile
      WHERE workspace_id = ?
        AND (
          ? IS NULL
          OR instr(lower(display_name), lower(?)) > 0
          OR instr(lower(mrn), lower(?)) > 0
          OR instr(lower(batch_name), lower(?)) > 0
        )
    `).get(...searchBindings)).count
    const rows = z.array(rowSchema.extend({ active_visit: z.number().int() })).parse(
      this.#database.driver.prepare(`
        SELECT profile.workspace_id, profile.profile_id, profile.batch_id,
          profile.batch_name, profile.provider_id, profile.source_patient_id,
          profile.revision, profile.display_name, profile.mrn,
          profile.identity_json, profile.mappings_json, profile.patient_json, profile.source_format,
          profile.source_hash, profile.raw_source_json, profile.compilation_json,
          profile.mapping_version, profile.mapping_provenance_json, profile.reference_data_json,
          profile.created_at, profile.updated_at,
          EXISTS (
            SELECT 1
            FROM synthetic_patient_materialization AS materialization
            JOIN outpatient_case AS outpatient
              ON outpatient.workspace_id = materialization.workspace_id
             AND outpatient.epoch = materialization.epoch
             AND outpatient.patient_id = materialization.patient_id
             AND outpatient.status != 'completed'
            WHERE materialization.workspace_id = profile.workspace_id
              AND materialization.epoch = ?
              AND materialization.profile_id = profile.profile_id
          ) AS active_visit
        FROM synthetic_patient_profile AS profile
        WHERE profile.workspace_id = ?
          AND (
            ? IS NULL
            OR instr(lower(profile.display_name), lower(?)) > 0
            OR instr(lower(profile.mrn), lower(?)) > 0
            OR instr(lower(profile.batch_name), lower(?)) > 0
          )
        ORDER BY profile.updated_at DESC, profile.profile_id
        LIMIT ? OFFSET ?
      `).all(
        input.epoch,
        ...searchBindings,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ),
    )
    return syntheticPatientProfileListSchema.parse({
      items: rows.map((row) => {
        const profile = this.#map(row)
        const chronicConditions = profile.patient.fhirHistory.flatMap(resource => (
          resource.resourceType === 'Condition' && resource.clinicalStatus === 'active'
            ? [resource.code.display]
            : []
        ))
        const allergyCount = profile.patient.fhirHistory.filter(resource => (
          resource.resourceType === 'AllergyIntolerance'
        )).length
        const mappingWarningCount = profile.patient.longitudinalHistory.filter(event => (
          event.mappedCode === null
        )).length
        return {
          activeVisit: row.active_visit === 1,
          allergyCount,
          batchId: profile.source.batchId,
          batchName: profile.source.batchName,
          birthDate: profile.patient.birthDate,
          chronicConditions: [...new Set(chronicConditions)],
          createdAt: profile.createdAt,
          gender: profile.patient.gender,
          historyCount: profile.patient.longitudinalHistory.length,
          mappingWarningCount,
          mrn: profile.identity.mrn,
          name: profile.identity.displayName,
          profileId: profile.profileId,
          providerId: profile.source.providerId,
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
        mappings_json = ?, patient_json = ?, mapping_version = ?, mapping_provenance_json = ?,
        reference_data_json = ?, updated_at = ?
      WHERE workspace_id = ? AND profile_id = ? AND revision = ?
    `).run(
      parsed.revision,
      parsed.identity.displayName,
      parsed.identity.mrn,
      JSON.stringify(parsed.identity),
      JSON.stringify(parsed.mappings),
      JSON.stringify(parsed.patient),
      parsed.source.mappingVersion,
      parsed.source.mappingProvenance === undefined
        ? null
        : JSON.stringify(parsed.source.mappingProvenance),
      parsed.source.referenceData === undefined ? null : JSON.stringify(parsed.source.referenceData),
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
        workspace_id, profile_id, revision, identity_json, mappings_json, patient_json, mapping_version,
        mapping_provenance_json, reference_data_json, created_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.workspaceId,
      profile.profileId,
      profile.revision,
      JSON.stringify(profile.identity),
      JSON.stringify(profile.mappings),
      JSON.stringify(profile.patient),
      profile.source.mappingVersion,
      profile.source.mappingProvenance === undefined
        ? null
        : JSON.stringify(profile.source.mappingProvenance),
      profile.source.referenceData === undefined ? null : JSON.stringify(profile.source.referenceData),
      actorId,
      profile.updatedAt,
    )
  }

  #map(row: z.infer<typeof rowSchema>): SyntheticPatientProfile {
    return syntheticPatientProfileSchema.parse({
      createdAt: row.created_at,
      identity: JSON.parse(row.identity_json),
      mappings: JSON.parse(row.mappings_json),
      patient: JSON.parse(row.patient_json),
      profileId: row.profile_id,
      revision: row.revision,
      source: {
        batchId: row.batch_id,
        batchName: row.batch_name,
        compilation: row.compilation_json === null ? null : JSON.parse(row.compilation_json),
        format: row.source_format,
        hash: row.source_hash,
        ...(row.mapping_provenance_json === null
          ? {}
          : { mappingProvenance: JSON.parse(row.mapping_provenance_json) }),
        mappingVersion: row.mapping_version,
        patientId: row.source_patient_id,
        providerId: row.provider_id,
        ...(row.reference_data_json === null
          ? {}
          : { referenceData: JSON.parse(row.reference_data_json) }),
        raw: row.raw_source_json === null ? null : JSON.parse(row.raw_source_json),
      },
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })
  }
}
