import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { startSyntheticInpatientCaseRequestSchema, startSyntheticInpatientCaseResultSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import {
  startSyntheticCaseRequestSchema,
  isLegacyPatientPersonaContent,
  syntheticPatientProfileSchema,
} from '@clinmesh/contracts/scenario'
import type { PatientPersonaRepository } from '../infrastructure/sqlite/patient-persona-repository.ts'
import type { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
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
  readonly #briefs: PatientPersonaRepository
  readonly #cases: SyntheticCaseRepository
  readonly #profiles: SyntheticPatientProfileRepository
  readonly #workflow: WorkflowService
  readonly #inpatient: InpatientService

  constructor(input: {
    briefs: PatientPersonaRepository
    cases: SyntheticCaseRepository
    profiles: SyntheticPatientProfileRepository
    workflow: WorkflowService
    inpatient: InpatientService
  }) {
    this.#briefs = input.briefs
    this.#cases = input.cases
    this.#profiles = input.profiles
    this.#workflow = input.workflow
    this.#inpatient = input.inpatient
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
    const { brief, profile, syntheticCase } = this.#assets(input)
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
  #assets(input: { caseId: string; context: ActorContext; request: { activeBriefRevision: number } }) {
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
      throw new SyntheticCaseVisitError('BRIEF_NOT_READY', 'The selected Patient Persona was not found')
    }
    if (syntheticCase.status !== 'started' && isLegacyPatientPersonaContent(brief.content)) {
      throw new SyntheticCaseVisitError('BRIEF_NOT_READY', 'Regenerate and select a Patient Persona before starting this legacy case')
    }
    return { brief, profile, syntheticCase }
  }

  startInpatient(input: {
    caseId: string; context: ActorContext; idempotencyKey: string
    request: z.infer<typeof startSyntheticInpatientCaseRequestSchema>
  }) {
    this.#inpatient.assertRole(input.context, ['registrar'])
    const { brief, profile, syntheticCase } = this.#assets(input)
    return this.#inpatient.commands.execute({ context: input.context, idempotencyKey: input.idempotencyKey,
      input: { caseId: input.caseId, ...input.request }, operation: 'synthetic-case.start-inpatient-visit',
      expectedVersions: {}, dataSchema: startSyntheticInpatientCaseResultSchema,
      authorize: () => {
        this.#inpatient.assertRole(input.context, ['registrar'])
        if (input.request.expectedEpoch !== input.context.epoch) throw new InpatientError('INPATIENT_EPOCH_CONFLICT', '入院意图所属数据世代已变化')
      },
    }, transaction => this.#workflow.applyStartSyntheticCase(transaction, { brief, profile, syntheticCase, context: input.context,
      expectedCaseRevision: input.request.expectedCaseRevision }, () => this.applyMaterializeInpatient({
        transaction, context: input.context, caseId: syntheticCase.caseId, caseRevision: input.request.expectedCaseRevision,
        profile, briefRevision: brief.revision, wardId: input.request.wardId,
      })))
  }

  replayInpatientCases(input: { fromContext: ActorContext; toContext: ActorContext; transaction: CommandTransaction }) {
    const rows = z.array(z.object({
      case_id: z.string(), case_revision: z.number().int().positive(), profile_id: z.string(),
      profile_revision: z.number().int().positive(), brief_revision: z.number().int().positive(),
      identity_json: z.string(), demographics_json: z.string(),
    })).parse(this.#inpatient.database.driver.prepare(`SELECT m.case_id,m.case_revision,m.profile_id,m.profile_revision,
      m.brief_revision,p.identity_json,p.demographics_json FROM synthetic_case_materialization m
      JOIN synthetic_patient_profile_revision p ON p.workspace_id=m.workspace_id AND p.profile_id=m.profile_id AND p.revision=m.profile_revision
      WHERE m.workspace_id=? AND m.epoch=? AND m.visit_kind='inpatient' ORDER BY m.created_at,m.case_id`)
      .all(input.fromContext.workspaceId,input.fromContext.epoch))
    for (const row of rows) this.applyMaterializeInpatient({
      transaction: input.transaction, context: input.toContext, caseId: row.case_id, caseRevision: row.case_revision,
      briefRevision: row.brief_revision, wardId: 'ward-general', profile: {
        profileId: row.profile_id, revision: row.profile_revision,
        identity: syntheticPatientProfileSchema.shape.identity.parse(JSON.parse(row.identity_json)),
        demographics: syntheticPatientProfileSchema.shape.demographics.parse(JSON.parse(row.demographics_json)),
      },
    })
  }

  applyMaterializeInpatient(input: {
    transaction: CommandTransaction; context: ActorContext; caseId: string; caseRevision: number
    profile: Parameters<WorkflowService['applyMaterializeSyntheticPatient']>[0]['profile']
    briefRevision: number; wardId: string
  }) {
    const patient = this.#workflow.applyMaterializeSyntheticPatient(input)
    const admissionId = uuidv7(), context = input.context
    this.#inpatient.database.driver.prepare(`INSERT INTO synthetic_case_materialization
      (visit_kind,workspace_id,epoch,case_id,case_revision,profile_id,profile_revision,brief_revision,patient_id,encounter_id,started_by_actor_id,created_at)
      VALUES('inpatient',?,?,?,?,?,?,?,?,?,?,?)`).run(context.workspaceId,context.epoch,input.caseId,input.caseRevision,
        input.profile.profileId,input.profile.revision,input.briefRevision,patient.id,admissionId,context.actorId,this.#inpatient.virtualTime(context))
    const registered = this.#inpatient.applyRegister(input.transaction, context, {
      expectedEpoch: context.epoch, patientId: patient.id, patientVersion: patient.meta!.versionId!,
      admissionRoute: 'direct', wardId: input.wardId, depositFen: 0,
    }, admissionId)
    return { data: { syntheticCaseId: input.caseId, patientId: patient.id, admissionId, encounterId: admissionId, status: 'registered' as const },
      effects: [{ kind: 'created' as const, reference: `Patient/${patient.id}`, versionId: patient.meta!.versionId! }, ...registered.effects],
    }
  }

}
