import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'

const materializationSchema = z.object({ case_id: z.string(), brief_revision: z.number().int().positive() })

/** 本次就诊只读取已冻结的来源；不随之后新增物化记录重新选择。 */
export function outpatientCaseSource(database: ClinMeshDatabase, context: ActorContext, caseId: string, patientId?: string) {
  return materializationSchema.optional().parse(database.driver.prepare(`
    SELECT m.case_id,m.brief_revision FROM outpatient_case current
    LEFT JOIN outpatient_case_source binding ON binding.workspace_id=current.workspace_id AND binding.epoch=current.epoch AND binding.outpatient_case_id=current.case_id
    JOIN synthetic_case_materialization m ON m.workspace_id=current.workspace_id AND m.epoch=current.epoch AND m.patient_id=current.patient_id
      AND ((binding.source_case_id IS NULL AND m.outpatient_case_id=current.case_id AND m.encounter_id=current.encounter_id) OR m.case_id=binding.source_case_id)
    JOIN synthetic_patient_materialization patient ON patient.workspace_id=m.workspace_id AND patient.epoch=m.epoch
      AND patient.profile_id=m.profile_id AND patient.profile_revision=m.profile_revision AND patient.patient_id=m.patient_id
    JOIN synthetic_case_instance original ON original.workspace_id=m.workspace_id AND original.case_id=m.case_id
      AND original.profile_id=m.profile_id AND original.profile_revision=m.profile_revision AND original.status!='retired'
    WHERE current.workspace_id=? AND current.epoch=? AND current.case_id=? AND (? IS NULL OR current.patient_id=?)
  `).get(context.workspaceId, context.epoch, caseId, patientId ?? null, patientId ?? null))
}

export function uniquePatientCaseSource(database: ClinMeshDatabase, context: ActorContext, patientId: string) {
  const sources = z.array(materializationSchema).parse(database.driver.prepare(`SELECT m.case_id,m.brief_revision
    FROM synthetic_case_materialization m JOIN synthetic_case_instance original ON original.workspace_id=m.workspace_id
      AND original.case_id=m.case_id AND original.profile_id=m.profile_id AND original.profile_revision=m.profile_revision AND original.status!='retired'
    JOIN synthetic_patient_materialization patient ON patient.workspace_id=m.workspace_id AND patient.epoch=m.epoch
      AND patient.profile_id=m.profile_id AND patient.profile_revision=m.profile_revision AND patient.patient_id=m.patient_id
    WHERE m.workspace_id=? AND m.epoch=? AND m.patient_id=? ORDER BY m.case_id`).all(context.workspaceId, context.epoch, patientId))
  return sources.length === 1 ? sources[0] : undefined
}
