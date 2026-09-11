import type { z } from 'zod'
import {
  startSyntheticCaseRequestSchema,
} from '@clinmesh/contracts/scenario'
import type { PatientBriefRepository } from '../infrastructure/sqlite/patient-brief-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { ActorContext } from './command-executor.ts'
import type { WorkflowService } from './workflow-service.ts'

type SyntheticCaseVisitErrorCode =
  | 'BRIEF_NOT_READY'
  | 'CASE_NOT_FOUND'
  | 'PROFILE_NOT_FOUND'
  | 'ROLE_NOT_ALLOWED'

export class SyntheticCaseVisitError extends Error {
  readonly code: SyntheticCaseVisitErrorCode
  readonly status: 403 | 404 | 409

  constructor(code: SyntheticCaseVisitErrorCode, message: string) {
    super(message)
    this.name = 'SyntheticCaseVisitError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (code === 'CASE_NOT_FOUND' || code === 'PROFILE_NOT_FOUND') this.status = 404
    else this.status = 409
  }
}

export class SyntheticCaseVisitService {
  readonly #briefs: PatientBriefRepository
  readonly #cases: SyntheticCaseRepository
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #workflow: WorkflowService

  constructor(input: {
    briefs: PatientBriefRepository
    cases: SyntheticCaseRepository
    profiles: SyntheticPatientProfileRepository
    workflow: WorkflowService
  }) {
    this.#briefs = input.briefs
    this.#cases = input.cases
    this.#profiles = input.profiles
    this.#workflow = input.workflow
  }

  listReadyForRegistration(input: {
    context: ActorContext
    page: number
    pageSize: number
    search?: string
  }) {
    if (input.context.roleCode !== 'registrar') {
      throw new SyntheticCaseVisitError(
        'ROLE_NOT_ALLOWED',
        'Only a registrar can list Synthetic Cases awaiting registration',
      )
    }
    return this.#cases.listForRegistration({
      page: input.page,
      pageSize: input.pageSize,
      ...(input.search === undefined ? {} : { search: input.search }),
      workspaceId: input.context.workspaceId,
    })
  }

  start(input: {
    caseId: string
    context: ActorContext
    idempotencyKey: string
    request: z.infer<typeof startSyntheticCaseRequestSchema>
  }) {
    if (!['administrator', 'registrar'].includes(input.context.roleCode)) {
      throw new SyntheticCaseVisitError(
        'ROLE_NOT_ALLOWED',
        'Only an administrator or registrar can start a Synthetic Case',
      )
    }
    const syntheticCase = this.#cases.get(input.context.workspaceId, input.caseId)
    if (syntheticCase === undefined) {
      throw new SyntheticCaseVisitError('CASE_NOT_FOUND', 'The Synthetic Case was not found')
    }
    const profile = this.#profiles.getRevision(
      input.context.workspaceId,
      syntheticCase.profileId,
      syntheticCase.profileRevision,
    )
    if (profile === undefined) {
      throw new SyntheticCaseVisitError('PROFILE_NOT_FOUND', 'The Synthetic Patient Profile was not found')
    }
    const brief = this.#briefs.getRevision(
      input.context.workspaceId,
      input.caseId,
      input.request.activeBriefRevision,
    )
    if (brief === undefined) {
      throw new SyntheticCaseVisitError('BRIEF_NOT_READY', 'The selected Patient Brief was not found')
    }
    return this.#workflow.startSyntheticCase({
      brief,
      context: input.context,
      departmentId: input.request.departmentId,
      expectedCaseRevision: input.request.expectedCaseRevision,
      idempotencyKey: input.idempotencyKey,
      locationId: input.request.locationId,
      profile,
      syntheticCase,
      visitDate: input.request.visitDate,
      visitTypeId: input.request.visitTypeId,
    })
  }
}
