import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkflowError } from './workflow-error.ts'
/** 只守真实写点，允许门诊case及所有只读入口；旧receipt在Command授权前已返回。 */
export function assertInpatientRecordWritable(database: ClinMeshDatabase, context: RepositoryContext, admissionId: string) {
  const row = z.object({ record_status: z.string() }).optional().parse(database.driver.prepare('SELECT record_status FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, admissionId))
  if (row?.record_status === 'archived')
    throw new WorkflowError('INPATIENT_RECORD_ARCHIVED', '病案已归档，只读可查')
}
