import {
  authoredCasePackSummarySchema,
  type authoredCasePackPrepareRequestSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import type { z } from 'zod'
import type { ActorContext, CommandEffect, CommandExecutor } from '../command-executor.ts'
import type { PatientPersonaRepository } from '../../infrastructure/sqlite/patient-persona-repository.ts'
import type { SyntheticCaseRepository } from '../../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import {
  buildAuthoredCaseProfile,
  type CompiledAuthoredCasePack,
} from './authored-case-pack-compiler.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import { compiledCardiorenalAuthoredCasePack } from './cardiorenal-authored-case-pack.ts'

export class AuthoredCasePackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 409,
  ) {
    super(message)
    this.name = 'AuthoredCasePackError'
  }
}

function isCaseReady(status: string | undefined): boolean {
  return status === 'brief-ready' || status === 'started' || status === 'completed'
}

export class AuthoredCasePackService {
  constructor(
    readonly commands: CommandExecutor,
    readonly profiles: SyntheticPatientProfileRepository,
    readonly cases: SyntheticCaseRepository,
    readonly personas: PatientPersonaRepository,
    readonly pack: CompiledAuthoredCasePack = compiledCardiorenalAuthoredCasePack,
    readonly options: {
      prepareOperation?: string
      readAuditOperation?: string
    } = {},
  ) {}

  read(context: ActorContext) {
    const readAuditOperation = this.options.readAuditOperation ?? 'admin.authored-case-pack.read'
    if (context.roleCode !== 'administrator') {
      try { this.commands.auditRead(context, readAuditOperation, {}, 'failed') } catch { /* preserve original error */ }
      throw new AuthoredCasePackError('ROLE_NOT_ALLOWED', '只有管理员可以查看专病病例包准备状态', 403)
    }
    const now = new Date().toISOString()
    const entries = this.pack.cases.map((compiledCase) => {
      const fixedProfile = buildAuthoredCaseProfile({
        compiledCase,
        createdAt: now,
        pack: this.pack,
        workspaceId: context.workspaceId,
      })
      const existingCase = this.cases.getByProfile(context.workspaceId, fixedProfile.profileId) ?? null
      return {
        case: existingCase,
        draftId: compiledCase.definition.id,
        profileId: fixedProfile.profileId,
        recommendedEntry: compiledCase.definition.recommendedEntry,
        sourceHash: compiledCase.source.hash,
        title: compiledCase.definition.title,
        titleEn: compiledCase.definition.titleEn,
      }
    })
    const summary = authoredCasePackSummarySchema.parse({
      cases: entries,
      name: this.pack.name,
      nameEn: this.pack.nameEn,
      packageId: this.pack.id,
      packageVersion: this.pack.version,
      readyCount: entries.filter(item => isCaseReady(item.case?.status)).length,
      totalCount: entries.length,
    })
    this.commands.auditRead(context, readAuditOperation, {}, 'success')
    return summary
  }

  prepare(
    context: ActorContext,
    input: z.infer<typeof authoredCasePackPrepareRequestSchema>['input'],
    idempotencyKey: string,
  ) {
    return this.commands.execute({
      authorize: () => {
        if (context.roleCode !== 'administrator') {
          throw new AuthoredCasePackError('ROLE_NOT_ALLOWED', '只有管理员可以准备专病病例包', 403)
        }
        if (input.expectedEpoch !== context.epoch) {
          throw new AuthoredCasePackError('AUTHORED_CASE_PACK_EPOCH_CONFLICT', '专病病例包准备意图所属数据世代已变化', 409)
        }
      },
      context,
      dataSchema: authoredCasePackSummarySchema,
      expectedVersions: {},
      idempotencyKey,
      idempotencyScope: 'workspace',
      input,
      operation: this.options.prepareOperation ?? 'synthetic-case.authored-pack.prepare',
    }, () => {
      const now = new Date().toISOString()
      const effects: CommandEffect[] = []
      const entries = this.pack.cases.map((compiledCase) => {
        const fixedProfile = buildAuthoredCaseProfile({
          compiledCase,
          createdAt: now,
          pack: this.pack,
          workspaceId: context.workspaceId,
        })
        let syntheticCase = this.cases.getByProfile(context.workspaceId, fixedProfile.profileId)
        const created = syntheticCase === undefined
        if (syntheticCase === undefined) {
          const restored = this.profiles.createBatch([fixedProfile], context.actorId)
          let profile = this.profiles.get(context.workspaceId, fixedProfile.profileId)!
          const retired = this.cases.getByProfileRevision(context.workspaceId, profile.profileId, profile.revision)
          if (retired !== undefined) {
            profile = { ...profile, revision: profile.revision + 1, updatedAt: now }
            if (!this.profiles.update(profile, profile.revision - 1, context.actorId)) {
              throw new AuthoredCasePackError('AUTHORED_CASE_PACK_REVISION_CONFLICT', '专病病例档案修订已变化', 409)
            }
          }
          syntheticCase = this.cases.createFromProfile({
            actorId: context.actorId,
            compiled: compiledCase.compiled,
            profile,
          })
          effects.push({
            kind: restored.length === 0 && retired === undefined ? 'created' : 'updated',
            reference: `SyntheticPatientProfile/${profile.profileId}`,
            versionId: String(profile.revision),
          })
        }
        const needsSelection = syntheticCase.activeBriefRevision === null && syntheticCase.status === 'brief-pending'
        const pendingJob = syntheticCase.status === 'started' || syntheticCase.status === 'completed'
          ? undefined
          : this.personas.getPendingJob(context.workspaceId, syntheticCase.caseId)
        if (pendingJob !== undefined && (pendingJob.status === 'running' || !needsSelection)) {
          throw new AuthoredCasePackError(
            'AUTHORED_CASE_PACK_PERSONA_RUNNING',
            '患者档案有未完成的生成任务，请等待原任务结束后重新准备',
            409,
          )
        }
        if (needsSelection) {
          const stopped = this.personas.failQueuedForCase({
            caseId: syntheticCase.caseId,
            error: { code: 'PERSONA_JOB_SUPERSEDED', message: '专病病例包准备已替代尚未开始的患者档案生成任务' },
            now,
            workspaceId: context.workspaceId,
          })
          effects.push(...stopped.map(job => ({
            kind: 'updated' as const,
            reference: `PatientPersonaJob/${job.jobId}`,
            versionId: 'failed',
          })))
          let persona = this.personas.listRevisions(context.workspaceId, syntheticCase.caseId)!.items[0]
          if (persona === undefined) {
            persona = this.personas.createRevision({
              caseId: syntheticCase.caseId,
              content: compiledCase.persona.content,
              createdAt: now,
              inputHash: canonicalJsonHash({
                authoring: fixedProfile.source.authoring,
                sourceHash: compiledCase.source.hash,
              }),
              model: 'clinmesh-authored-template',
              outputHash: canonicalJsonHash(compiledCase.persona.content),
              promptHash: compiledCase.persona.promptHash,
              promptVersion: compiledCase.persona.version,
              workspaceId: context.workspaceId,
            })
            effects.push({
              kind: 'created',
              reference: `PatientPersona/${syntheticCase.caseId}/${persona.revision}`,
              versionId: String(persona.revision),
            })
          }
          const selected = this.personas.selectRevision({
            caseId: syntheticCase.caseId,
            expectedCaseRevision: syntheticCase.revision,
            now,
            personaRevision: persona.revision,
            workspaceId: context.workspaceId,
          })
          if (selected === undefined) {
            throw new AuthoredCasePackError('AUTHORED_CASE_PACK_REVISION_CONFLICT', '专病病例档案修订已变化', 409)
          }
          syntheticCase = selected
          effects.push({
            kind: created ? 'created' : 'updated',
            reference: `SyntheticCase/${syntheticCase.caseId}`,
            versionId: String(syntheticCase.revision),
          })
        }
        return {
          case: syntheticCase,
          draftId: compiledCase.definition.id,
          profileId: fixedProfile.profileId,
          recommendedEntry: compiledCase.definition.recommendedEntry,
          sourceHash: compiledCase.source.hash,
          title: compiledCase.definition.title,
          titleEn: compiledCase.definition.titleEn,
        }
      })
      return {
        data: {
          cases: entries,
          name: this.pack.name,
          nameEn: this.pack.nameEn,
          packageId: this.pack.id,
          packageVersion: this.pack.version,
          readyCount: entries.filter(item => isCaseReady(item.case.status)).length,
          totalCount: entries.length,
        },
        effects,
      }
    })
  }
}
