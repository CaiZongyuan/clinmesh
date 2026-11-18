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
import { outpatientCaseSource } from './outpatient-case-source.ts'
import { inpatientHistoryItems, isInpatientHistoryEntry } from './doctor-inpatient-history.ts'

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
  if (isInpatientHistoryEntry(input.entryId)) return inpatientHistoryItems(database, context, current.patient_id)
    .some(item => item.entryId === input.entryId)
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
  return outpatientCaseSource(database, context, currentCaseId, patientId)?.case_id
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

export function doctorVisibleHistoryDetails(database: ClinMeshDatabase, context: ActorContext, currentCaseId: string,
  patientId: string) {
  const caseId = materializedCase(database, context, currentCaseId, patientId)
  if (caseId === undefined) return []
  const rows = z.array(z.object({
    clinical_date: z.string(), resource_type: z.string(), title: z.string(),
    source_reference: z.string(), resource_json: z.string(),
  })).parse(database.driver.prepare(`
    SELECT history.clinical_date, history.resource_type, history.title,
      history.source_reference, resource.resource_json
    FROM synthetic_case_visible_history AS history
    LEFT JOIN synthetic_case_visible_resource AS resource
      ON resource.workspace_id = history.workspace_id AND resource.case_id = history.case_id
     AND resource.source_reference = history.source_reference
    WHERE history.workspace_id = ? AND history.case_id = ?
    ORDER BY history.sequence
  `).all(context.workspaceId, caseId))
  return rows.map(row => doctorVisibleHistoryDetailSchema.parse({
    clinical: JSON.parse(row.resource_json), clinicalDate: row.clinical_date,
    entryId: row.source_reference, missingFieldMeaning: 'not-recorded',
    resourceType: row.resource_type, source: 'visible-source', title: row.title,
  }))
}
