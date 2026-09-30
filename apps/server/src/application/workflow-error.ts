import type { ApiConflict } from '@clinmesh/contracts/his'

export class WorkflowError extends Error {
  readonly code: 'CATALOG_CONFLICT' | 'DIAGNOSIS_PRIMARY_REQUIRED' | 'DUPLICATE_PATIENT' | 'ENCOUNTER_COMPLETION_BLOCKED' | 'LABORATORY_ADULT_REFERENCE_NOT_APPLICABLE' | 'LABORATORY_GENERATION_UNSUPPORTED' | 'LABORATORY_REQUEST_DUPLICATE' | 'LABORATORY_REQUEST_NOT_CANCELLABLE' | 'LABORATORY_REQUEST_VERSION_CONFLICT' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT'
  readonly conflict: ApiConflict | undefined
  readonly status: 403 | 409

  constructor(
    code: WorkflowError['code'],
    message: string,
    conflict?: ApiConflict,
  ) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.conflict = conflict
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : 409
  }
}
