import {
  doctorCaseHistorySchema,
  doctorVisibleHistoryDetailSchema,
  visibleSourceClinicalSchema,
} from '@clinmesh/contracts/agent'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { ActorContext } from './command-executor.ts'
import { WorkflowError } from './workflow-error.ts'

export function doctorHistoryEntryAllowed(database: ClinMeshDatabase, context: ActorContext, currentCaseId: string,
  input: { source: 'local-completed' | 'visible-source'; entryId: string }): boolean {
  const current = z.object({ patient_id: z.string().min(1) }).optional().parse(database.driver.prepare(`
    SELECT outpatient_case.patient_id FROM outpatient_case
    JOIN outpatient_case_responsibility AS responsibility
      ON responsibility.workspace_id = outpatient_case.workspace_id AND responsibility.epoch = outpatient_case.epoch
     AND responsibility.case_id = outpatient_case.case_id AND responsibility.practitioner_role_id = ?
    WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
      AND outpatient_case.case_id = ? AND outpatient_case.scenario_run_id = ?
  `).get(context.practitionerRoleId, context.workspaceId, context.epoch, currentCaseId, context.scenarioRunId))
  if (current === undefined) return false
  if (input.source === 'visible-source') {
    const caseId = materializedCase(database, context, currentCaseId, current.patient_id)
    return caseId !== undefined && database.driver.prepare(`
      SELECT 1 FROM synthetic_case_visible_history
      WHERE workspace_id = ? AND case_id = ? AND source_reference = ?
    `).get(context.workspaceId, caseId, input.entryId) !== undefined
  }
  return database.driver.prepare(`
    SELECT 1 FROM outpatient_case AS history
    JOIN outpatient_case_responsibility AS responsibility
      ON responsibility.workspace_id = history.workspace_id AND responsibility.epoch = history.epoch
     AND responsibility.case_id = history.case_id AND responsibility.practitioner_role_id = ?
    JOIN fhir_resource AS encounter
      ON encounter.workspace_id = history.workspace_id AND encounter.epoch = history.epoch
     AND encounter.resource_type = 'Encounter' AND encounter.resource_id = history.encounter_id AND encounter.deleted = 0
    WHERE history.workspace_id = ? AND history.epoch = ? AND history.case_id = ?
      AND history.patient_id = ? AND json_extract(encounter.content_json, '$.status') = 'completed'
      AND json_extract(encounter.content_json, '$.actualPeriod.end') IS NOT NULL
  `).get(context.practitionerRoleId, context.workspaceId, context.epoch, input.entryId, current.patient_id) !== undefined
}

function materializedCase(database: ClinMeshDatabase, context: ActorContext, currentCaseId: string, patientId: string) {
  return z.object({ case_id: z.string().min(1) }).optional().parse(database.driver.prepare(`
    SELECT materialization.case_id FROM synthetic_case_materialization AS materialization
    JOIN synthetic_patient_materialization AS patient
      ON patient.workspace_id = materialization.workspace_id AND patient.epoch = materialization.epoch
     AND patient.profile_id = materialization.profile_id AND patient.profile_revision = materialization.profile_revision
     AND patient.patient_id = materialization.patient_id
    JOIN synthetic_case_instance AS source
      ON source.workspace_id = materialization.workspace_id AND source.case_id = materialization.case_id
     AND source.profile_id = materialization.profile_id AND source.profile_revision = materialization.profile_revision
     AND source.status != 'retired'
    JOIN outpatient_case AS current
      ON current.workspace_id = materialization.workspace_id AND current.epoch = materialization.epoch
     AND current.case_id = materialization.outpatient_case_id AND current.encounter_id = materialization.encounter_id
     AND current.patient_id = materialization.patient_id
    WHERE materialization.workspace_id = ? AND materialization.epoch = ?
      AND materialization.outpatient_case_id = ? AND materialization.patient_id = ?
  `).get(context.workspaceId, context.epoch, currentCaseId, patientId))?.case_id
}

export function doctorVisibleHistory(database: ClinMeshDatabase, context: ActorContext, currentCaseId: string, patientId: string,
  input: { page: number; pageSize: number }) {
  const caseId = materializedCase(database, context, currentCaseId, patientId)
  const history = caseId === undefined
    ? { items: [], page: input.page, pageSize: input.pageSize, total: 0 }
    : new SyntheticCaseRepository(database).listVisibleHistory({ ...input, caseId, workspaceId: context.workspaceId })
  return doctorCaseHistorySchema.parse({
    ...history,
    availability: caseId === undefined ? 'no-materialization' : history.total === 0 ? 'no-data' : 'available',
    coverage: 'materialized-visible-history',
    items: history.items.map(item => ({
      clinicalDate: item.clinicalDate, entryId: item.sourceReference,
      resourceType: item.resourceType, source: 'visible-source', title: item.title,
    })),
    source: 'visible-source',
  })
}

export function doctorVisibleHistoryDetail(database: ClinMeshDatabase, context: ActorContext, currentCaseId: string,
  patientId: string, entryId: string) {
  const caseId = materializedCase(database, context, currentCaseId, patientId)
  const item = caseId === undefined ? undefined : z.object({
    clinical_date: z.string(), resource_type: z.string(), title: z.string(),
  }).optional().parse(database.driver.prepare(`
    SELECT clinical_date, resource_type, title FROM synthetic_case_visible_history
    WHERE workspace_id = ? AND case_id = ? AND source_reference = ?
  `).get(context.workspaceId, caseId, entryId))
  if (caseId === undefined || item === undefined) {
    throw new WorkflowError('WORKFLOW_CONFLICT', 'The authorized history entry was not found')
  }
  const detail = new SyntheticCaseRepository(database).getVisibleResource(context.workspaceId, caseId, entryId)
  if (detail === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The authorized history entry was not found')
  return doctorVisibleHistoryDetailSchema.parse({
    clinical: visibleSourceClinicalSchema.parse(detail.resource),
    clinicalDate: item.clinical_date, entryId, missingFieldMeaning: 'not-recorded',
    resourceType: item.resource_type, source: 'visible-source', title: item.title,
  })
}
