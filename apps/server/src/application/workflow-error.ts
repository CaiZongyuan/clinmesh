import type { ApiConflict } from '@clinmesh/contracts/his'

export class WorkflowError extends Error {
  readonly code: 'INPATIENT_RECORD_ARCHIVED' | 'CATALOG_CONFLICT' | 'DIAGNOSIS_PRIMARY_REQUIRED' | 'DUPLICATE_PATIENT' | 'ENCOUNTER_COMPLETION_BLOCKED' | 'IMAGING_REQUEST_DUPLICATE' | 'IMAGING_REQUEST_NOT_CANCELLABLE' | 'IMAGING_REQUEST_VERSION_CONFLICT' | 'IMAGING_STUDY_UNAVAILABLE' | 'LABORATORY_ADULT_REFERENCE_NOT_APPLICABLE' | 'LABORATORY_GENERATION_UNSUPPORTED' | 'LABORATORY_REQUEST_DUPLICATE' | 'LABORATORY_REQUEST_NOT_CANCELLABLE' | 'LABORATORY_REQUEST_VERSION_CONFLICT' | 'PATHOLOGY_REQUEST_DUPLICATE' | 'PATHOLOGY_REQUEST_NOT_CANCELLABLE' | 'PATHOLOGY_REQUEST_VERSION_CONFLICT' | 'PATHOLOGY_SOURCE_PROCEDURE_UNAVAILABLE' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT'
  readonly conflict: ApiConflict | undefined
  /** 机器可读的拒绝成因；同一 code 下区分可操作文案（如处方开具拦截的具体原因）。 */
  readonly reason: string | undefined
  readonly status: 403 | 409

  constructor(
    code: WorkflowError['code'],
    message: string,
    conflict?: ApiConflict,
    reason?: string,
  ) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.conflict = conflict
    this.reason = reason
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : 409
  }
}
