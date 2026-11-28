import { z } from 'zod'
import type { GuidelineTopicBundle, GuidelineTopicId } from '@clinmesh/contracts/guideline-topics'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { ActorContext } from './command-executor.ts'
import { buildSynchronousTopicBundle } from './guideline-topic-registry.ts'
import type { InpatientService } from './inpatient-service.ts'

/** Deterministic synchronous guideline topic evidence & objective indicator evaluation (zero LLM). */
export class InpatientGuidelineAdvice {
  constructor(
    readonly owner: InpatientService,
    readonly options: {
      guidelines?: GuidelineCorpus
    } = {},
  ) {}

  #population(context: ActorContext, admissionId: string) {
    const binding = this.owner.readAdmissionBinding(context, admissionId)
    const patient = z.object({ birthDate: z.string().optional() }).parse(this.owner.fhir.read(context, 'Patient', binding.patientId))
    const departedAt = this.owner.discharge.activeDeparture(context, admissionId)?.virtualTime
    const isArchivedCutoff = departedAt !== undefined || binding.status === 'departed' || binding.status === 'cleared'
    return { binding, isArchivedCutoff, patientBirthDate: patient.birthDate, referenceIso: departedAt ?? this.owner.virtualTime(context) }
  }

  readTopics(context: ActorContext, admissionId: string, topicId?: GuidelineTopicId): GuidelineTopicBundle {
    try {
      this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
      const { binding, isArchivedCutoff, patientBirthDate, referenceIso } = this.#population(context, admissionId)
      const scores = this.owner.workflow.clinicalScores.inpatientSnapshot(this.owner, context, admissionId, referenceIso, isArchivedCutoff)
      const bundle = buildSynchronousTopicBundle({
        caseId: admissionId,
        context,
        corpus: this.options.guidelines,
        database: this.owner.database,
        encounterId: admissionId,
        evaluatedAt: this.owner.virtualTime(context),
        fhir: this.owner.fhir,
        inpatient: { actor: context, service: this.owner },
        isArchivedCutoff,
        patientBirthDate,
        patientId: binding.patientId,
        populationReferenceIso: referenceIso,
        referenceCutoffIso: referenceIso,
        scores,
        topicId,
      })
      this.owner.commands.auditRead(
        context,
        'inpatient.guideline-topics.read',
        topicId === undefined ? { admissionId } : { admissionId, topicId },
        'success',
      )
      return bundle
    } catch (error) {
      try {
        this.owner.commands.auditRead(
          context,
          'inpatient.guideline-topics.read',
          topicId === undefined ? { admissionId } : { admissionId, topicId },
          'failed',
        )
      } catch { /* Preserve the original error. */ }
      throw error
    }
  }
}
