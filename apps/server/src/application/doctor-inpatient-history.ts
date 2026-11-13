import { z } from 'zod'
import { doctorInpatientHistoryRecordSchema } from '@clinmesh/contracts/agent'
import { inpatientProcedureItemSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import { WorkflowError } from './workflow-error.ts'

const prefix = 'inpatient:'
const admissionSchema = z.object({ admission_id: z.string(), admitted_at: z.string(), encounter_json: z.string() })
const conceptSchema = z.object({ code: z.string().optional(), display: z.string().optional(), text: z.string().optional(), coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() })).optional() })
const conceptLabel = (value: z.infer<typeof conceptSchema>) => value.text ?? value.display ?? value.coding?.[0]?.display ?? value.code ?? value.coding?.[0]?.code ?? '未记录名称'

function inpatientHistoryAdmissions(database: ClinMeshDatabase, context: ActorContext, patientId: string) {
  return z.array(admissionSchema).parse(database.driver.prepare(`
    SELECT admission.admission_id, COALESCE(admission.admitted_at, admission.registered_at) AS admitted_at, encounter.content_json AS encounter_json
    FROM inpatient_admission admission JOIN fhir_resource encounter
      ON encounter.workspace_id=admission.workspace_id AND encounter.epoch=admission.epoch
      AND encounter.resource_type='Encounter' AND encounter.resource_id=admission.admission_id AND encounter.deleted=0
    WHERE admission.workspace_id=? AND admission.epoch=? AND admission.patient_id=?
      AND admission.status IN ('departed','cleared')
      AND json_extract(encounter.content_json,'$.status') IN ('discharged','completed')
      AND json_extract(encounter.content_json,'$.subject.reference')=?
      AND json_extract(encounter.content_json,'$.actualPeriod.end') IS NOT NULL
  `).all(context.workspaceId, context.epoch, patientId, `Patient/${patientId}`)).map(row => ({
    admissionId: row.admission_id, admittedAt: row.admitted_at,
    dischargedAt: z.object({ actualPeriod: z.object({ end: z.string() }) }).parse(JSON.parse(row.encounter_json)).actualPeriod.end,
  }))
}

export function inpatientHistoryItems(database: ClinMeshDatabase, context: ActorContext, patientId: string) {
  return inpatientHistoryAdmissions(database, context, patientId).map(row => ({
    entryId: `${prefix}${row.admissionId}`, clinicalDate: row.dischargedAt, source: 'local-completed' as const,
    resourceType: 'InpatientEncounter', title: '本院住院诊疗摘要',
  }))
}

export function inpatientHistoryDetail(database: ClinMeshDatabase, context: ActorContext, patientId: string, entryId: string) {
  const admission = inpatientHistoryAdmissions(database, context, patientId).find(row => `${prefix}${row.admissionId}` === entryId)
  if (admission === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The authorized history entry was not found')
  const bindings = [context.workspaceId, context.epoch, admission.admissionId]
  const diagnoses = z.array(z.object({ coding_json: z.string(), role: z.enum(['primary','secondary']), note: z.string().nullable() }))
    .parse(database.driver.prepare(`SELECT coding_json,role,note FROM inpatient_diagnosis_entry WHERE workspace_id=? AND epoch=? AND admission_id=?
      AND revision=(SELECT MAX(revision) FROM inpatient_diagnosis_confirmation WHERE workspace_id=? AND epoch=? AND admission_id=?) ORDER BY ordinal`).all(...bindings,...bindings))
    .map(row => { const code = conceptSchema.parse(JSON.parse(row.coding_json)); return { code: code.code ?? code.coding?.[0]?.code ?? '', display: conceptLabel(code), role: row.role, ...(row.note === null ? {} : { note: row.note }) } })
  const procedures = z.array(z.object({ actual_procedure_json: z.string(), performed_at: z.string(), report_conclusion: z.string().nullable() }))
    .parse(database.driver.prepare(`SELECT execution.actual_procedure_json,execution.performed_at,
        json_extract(report.content_json,'$.conclusion') AS report_conclusion FROM inpatient_surgery_execution execution
      LEFT JOIN inpatient_angiography_report angiography ON angiography.workspace_id=execution.workspace_id AND angiography.epoch=execution.epoch
        AND angiography.admission_id=execution.admission_id AND angiography.procedure_id=execution.execution_id
      LEFT JOIN fhir_resource report ON report.workspace_id=angiography.workspace_id AND report.epoch=angiography.epoch
        AND report.resource_type='DiagnosticReport' AND report.resource_id=angiography.report_id AND report.deleted=0
        AND json_extract(report.content_json,'$.encounter.reference')='Encounter/' || execution.admission_id
        AND json_extract(report.content_json,'$.subject.reference')=?
        AND json_extract(report.content_json,'$.status') IN ('final','partial','amended','corrected')
      WHERE execution.workspace_id=? AND execution.epoch=? AND execution.admission_id=? AND execution.status='completed' ORDER BY execution.performed_at,execution.execution_id`).all(`Patient/${patientId}`,...bindings))
    .map(row => { const { coding: code } = inpatientProcedureItemSchema.parse(JSON.parse(row.actual_procedure_json));
      return { code: code.code ?? '', display: conceptLabel(code), performedAt: row.performed_at,
        ...(row.report_conclusion === null ? {} : { conclusion: row.report_conclusion }) } })
  const medications = z.array(z.object({ display: z.string(), dose_text: z.string(), frequency_code: z.string(), state: z.string() }))
    .parse(database.driver.prepare(`SELECT display,dose_text,frequency_code,state FROM inpatient_order WHERE workspace_id=? AND epoch=? AND admission_id=?
      AND kind='medication' AND state IN ('signed','verified','stop-requested','stopped','completed') ORDER BY signed_at,order_id`).all(...bindings))
    .map(row => ({ display: row.display, doseText: row.dose_text, frequencyCode: row.frequency_code, state: row.state }))
  const reports = z.array(z.object({ content_json: z.string() })).parse(database.driver.prepare(`SELECT content_json FROM fhir_resource
    WHERE workspace_id=? AND epoch=? AND resource_type='DiagnosticReport' AND deleted=0
      AND json_extract(content_json,'$.encounter.reference')=? AND json_extract(content_json,'$.subject.reference')=?
      AND json_extract(content_json,'$.status') IN ('final','amended','corrected') ORDER BY resource_id`)
    .all(context.workspaceId, context.epoch, `Encounter/${admission.admissionId}`, `Patient/${patientId}`)).map(row => {
      const report = z.object({ code: conceptSchema, issued: z.string().optional(), conclusion: z.string().optional(), result: z.array(z.object({ reference: z.string() })).optional() }).parse(JSON.parse(row.content_json))
      const findings = (report.result ?? []).flatMap(result => {
        if (!result.reference.startsWith('Observation/')) return []
        const observationRow = z.object({ content_json: z.string() }).optional().parse(database.driver.prepare(`SELECT content_json FROM fhir_resource
          WHERE workspace_id=? AND epoch=? AND resource_type='Observation' AND resource_id=? AND deleted=0
          AND json_extract(content_json,'$.encounter.reference')=? AND json_extract(content_json,'$.subject.reference')=?
          AND json_extract(content_json,'$.status') IN ('final','amended','corrected')`).get(context.workspaceId, context.epoch, result.reference.slice(12), `Encounter/${admission.admissionId}`, `Patient/${patientId}`))
        if (observationRow === undefined) return []
        const observation = z.object({ code: conceptSchema, valueQuantity: z.object({ value: z.number(), unit: z.string().optional() }).optional(), valueCodeableConcept: conceptSchema.optional(), valueString: z.string().optional() }).parse(JSON.parse(observationRow.content_json))
        const value = observation.valueQuantity === undefined ? observation.valueCodeableConcept === undefined ? observation.valueString : conceptLabel(observation.valueCodeableConcept) : `${observation.valueQuantity.value} ${observation.valueQuantity.unit ?? ''}`.trim()
        return value === undefined ? [] : [`${conceptLabel(observation.code)}：${value}`]
      })
      return { title: conceptLabel(report.code), ...(report.issued === undefined ? {} : { issuedAt: report.issued }), conclusion: report.conclusion ?? '', findings }
    })
  return { source: 'local-completed' as const, entryId, clinicalDate: admission.dischargedAt, title: '本院住院诊疗摘要',
    record: doctorInpatientHistoryRecordSchema.parse({ kind: 'inpatient', ...admission, diagnoses, procedures, medications, reports }) }
}

export const isInpatientHistoryEntry = (entryId: string) => entryId.startsWith(prefix)
