import type { ClinicalQualityReceipt } from '@clinmesh/contracts/clinical-quality'
import {
  confirmDoctorPreparationResponseSchema,
  type ConfirmDoctorPreparationRequest,
  type DoctorPreparationItemResult,
  type DoctorRecommendationKind,
} from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog, PrescriptionConflictReason } from '@clinmesh/contracts/his'
import type { ReferenceConcept, ReferenceConceptSnapshot } from '@clinmesh/contracts/reference-data'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { assertOutpatientOrderPrerequisites } from './clinical-request-context.ts'
import { CommandReceiptNotFoundError, type ActorContext, type CommandEffect, type CommandExecutor } from './command-executor.ts'
import type { DoctorRecommendationsWorkflowPort } from './outpatient-workflow-context.ts'
import type { ReferenceDataService } from './reference-data-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'

export interface DoctorInvestigationCatalogOfferings {
  laboratory?: ReturnType<DoctorRecommendationsWorkflowPort['caseLaboratoryCatalog']>
  imaging?: ReturnType<DoctorRecommendationsWorkflowPort['imaging']['serviceCatalog']>
  pathology?: ReturnType<DoctorRecommendationsWorkflowPort['pathology']['serviceCatalog']>
}

function resolveDoctorDiagnosisReference(
  catalogItemId: string,
  catalog: { local: ClinicalCatalog['diagnoses']; reference: ReferenceConcept[] },
): ReferenceConceptSnapshot | undefined {
  const reference = catalog.reference.find(item => item.id === catalogItemId)
  if (reference !== undefined) {
    if (reference.status !== 'active' || reference.domain !== 'diagnosis') return undefined
    return {
      id: reference.id,
      code: reference.code,
      display: reference.display,
      system: reference.system,
      version: reference.version,
      sourceLocator: reference.sourceLocator,
    }
  }
  const local = catalog.local.find(item => item.id === catalogItemId)
  if (local === undefined) return undefined
  return local.referenceConcept ?? {
    id: local.id,
    code: local.code,
    display: local.nameZh,
    system: local.system,
    version: String(local.version),
    sourceLocator: 'operational:diagnosis_catalog',
  }
}

/** Deterministic manual batch confirmation & receipt lookup for outpatient doctor orders/diagnoses/prescriptions. */
export class DoctorRecommendationsService {
  constructor(private readonly options: {
    database: ClinMeshDatabase
    workflow: DoctorRecommendationsWorkflowPort
    commands: CommandExecutor
    referenceData: ReferenceDataService
    contextStatus: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
    investigationCatalogs: (context: ActorContext, caseId: string, kind: DoctorRecommendationKind) => Promise<DoctorInvestigationCatalogOfferings>
  }) {}

  #authorize(context: ActorContext, caseId: string, inactiveReason?: PrescriptionConflictReason) {
    if (this.options.contextStatus(context) !== 'active') {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The original doctor authorization is no longer active')
    }
    return this.options.workflow.doctorRecommendationCase(context, caseId, inactiveReason)
  }

  #investigationCatalogs(
    context: ActorContext,
    caseId: string,
    kind: 'laboratory' | 'imaging' | 'pathology',
    offerings: DoctorInvestigationCatalogOfferings,
  ): DoctorInvestigationCatalogOfferings {
    if (kind === 'laboratory') {
      const laboratory = this.options.workflow.caseLaboratoryCatalog(context, caseId, { page: 1, pageSize: 50 })
      for (let page = 2; (page - 1) * laboratory.pageSize < laboratory.total; page += 1) {
        laboratory.items.push(...this.options.workflow.caseLaboratoryCatalog(context, caseId, { page, pageSize: laboratory.pageSize }).items)
      }
      return { laboratory }
    }
    if (kind === 'imaging') {
      return {
        imaging: this.options.workflow.imaging.serviceCatalog(
          context,
          new Set(offerings.imaging?.items.filter(item => item.available).map(item => item.service.examCode)),
        ),
      }
    }
    return {
      pathology: this.options.workflow.pathology.serviceCatalog(
        context,
        new Set(offerings.pathology?.items.filter(item => item.available).map(item => item.service.examCode)),
        new Map(offerings.pathology?.items.map(item => [item.service.examCode, item.sourceProcedures])),
      ),
    }
  }

  confirmationReceipt(context: ActorContext, caseId: string, kind: DoctorRecommendationKind, idempotencyKey: string) {
    if (context.roleCode !== 'outpatient-doctor' || this.options.contextStatus(context) !== 'active') {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The original doctor authorization is no longer active')
    }
    const receipt = this.options.commands.readReceipt(context, 'doctor.recommendations.confirm', idempotencyKey)
    const response = confirmDoctorPreparationResponseSchema.safeParse(receipt.response)
    if (receipt.status !== 'completed' || !response.success || response.data.data.caseId !== caseId || response.data.data.kind !== kind) {
      throw new CommandReceiptNotFoundError('The confirmation receipt was not found for this case and category')
    }
    return response.data
  }

  async confirm(
    context: ActorContext,
    caseId: string,
    kind: DoctorRecommendationKind,
    request: ConfirmDoctorPreparationRequest,
    idempotencyKey: string,
  ) {
    const inactiveReason = kind === 'prescription' ? 'PRESCRIPTION_ENCOUNTER_NOT_ACTIVE' : undefined
    this.#authorize(context, caseId, inactiveReason)
    const offerings = kind === 'imaging' || kind === 'pathology'
      ? await this.options.investigationCatalogs(context, caseId, kind) : {}
    return this.options.commands.execute({
      context,
      operation: 'doctor.recommendations.confirm',
      contextRequirement: 'current',
      expectedVersions: request.expectedVersions,
      idempotencyKey,
      input: { caseId, kind, ...request.input },
      dataSchema: confirmDoctorPreparationResponseSchema.shape.data,
      authorize: () => { this.#authorize(context, caseId, inactiveReason) },
    }, transaction => {
      const detail = this.#authorize(context, caseId, inactiveReason)
      const reference = `Encounter/${detail.encounter.id}`
      if (detail.encounter.versionId === undefined || Object.keys(request.expectedVersions).length !== 1
        || request.expectedVersions[reference] !== detail.encounter.versionId) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The current active Encounter version is required')
      }
      const selections = request.input.selections
      if (selections.some(selection => selection.source !== 'manual')) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Background recommendation confirmation is disabled; confirm explicit manual selections instead')
      }
      for (const selection of selections) {
        if (selection.kind !== kind) throw new WorkflowError('WORKFLOW_CONFLICT', 'Select a single recommendation kind')
      }
      const currentCatalogs = kind === 'laboratory' || kind === 'imaging' || kind === 'pathology'
        ? this.#investigationCatalogs(context, caseId, kind, offerings) : {}
      const validateService = (selection: typeof selections[number]) => {
        if (selection.kind === 'laboratory' || selection.kind === 'imaging' || selection.kind === 'pathology') {
          const service = selection.kind === 'laboratory'
            ? currentCatalogs.laboratory?.items.find(item => item.id === selection.catalogItemId)
              ?? this.options.workflow.clinicalCatalog(context).laboratory.find(item => item.id === selection.catalogItemId)
            : selection.kind === 'imaging'
              ? currentCatalogs.imaging?.items.find(item => item.service.id === selection.serviceId)?.service
              : currentCatalogs.pathology?.items.find(item => item.service.id === selection.serviceId)?.service
          if (service === undefined || selection.reviewedService.outpatientBilling === null || canonicalJsonHash(selection.reviewedService) !== canonicalJsonHash({
            id: service.id, version: service.version, outpatientBilling: service.outpatientBilling ?? null,
          })) {
            throw new WorkflowError('CATALOG_CONFLICT', '服务版本或门诊价格已变化，请重新审阅项目和价格后再开具')
          }
        }
      }
      const base = { context, encounterId: detail.encounter.id, expectedVersions: request.expectedVersions, idempotencyKey }
      let draftVersion = request.input.expectedDraftVersion
      const effects: CommandEffect[] = []
      const recordIds: string[] = []
      const results: DoctorPreparationItemResult[] = []
      let clinicalQuality: ClinicalQualityReceipt | undefined
      let encounterVersion = detail.encounter.versionId
      if (kind === 'diagnosis') {
        const entries = selections.flatMap(selection => {
          if (selection.kind !== 'diagnosis') return []
          const referenceConceptRecord = this.options.referenceData.diagnosisById(context, selection.catalogItemId)
          const referenceConcept = resolveDoctorDiagnosisReference(selection.catalogItemId, {
            local: this.options.workflow.clinicalCatalog(context).diagnoses,
            reference: referenceConceptRecord === undefined ? [] : [referenceConceptRecord],
          })
          if (referenceConcept === undefined || (selection.referenceConcept !== undefined
            && canonicalJsonHash(selection.referenceConcept) !== canonicalJsonHash(referenceConcept))) {
            throw new WorkflowError('CATALOG_CONFLICT', 'The selected diagnosis coding snapshot does not match the current verified clinical identity')
          }
          return [{
            catalogItemId: selection.catalogItemId,
            role: selection.role,
            referenceConcept,
            ...(selection.note === undefined ? {} : { note: selection.note }),
          }]
        })
        const saved = this.options.workflow.applySaveDiagnosisDraft(transaction, { ...base, expectedDraftVersion: draftVersion, entries })
        const confirmed = this.options.workflow.applyConfirmDiagnosis(transaction, { ...base, expectedDraftVersion: saved.data.draftVersion })
        draftVersion = confirmed.data.diagnosisVersion
        encounterVersion = confirmed.data.encounterVersion
        recordIds.push(confirmed.data.confirmation.id)
        effects.push(...confirmed.effects)
      } else if (kind === 'prescription') {
        assertOutpatientOrderPrerequisites(this.options.database, context, caseId)
        const items = selections.flatMap(selection => selection.kind !== 'prescription' ? [] : [{
          catalogItemId: selection.catalogItemId,
          doseText: selection.doseText,
          frequencyCode: selection.frequencyCode,
          routeCode: selection.routeCode,
          courseDays: selection.courseDays,
          quantity: selection.quantity,
          ...(selection.instructions === undefined ? {} : { instructions: selection.instructions }),
        }])
        const saved = this.options.workflow.applySavePrescriptionDraft(transaction, { ...base, expectedDraftVersion: draftVersion, items })
        const issued = this.options.workflow.applyIssuePrescription(transaction, {
          ...base,
          expectedDraftVersion: saved.data.draftVersion,
          clinicalOverride: request.input.clinicalOverride,
          operation: 'doctor.recommendations.confirm',
        })
        draftVersion = issued.data.draftVersion
        recordIds.push(issued.data.prescription.id)
        effects.push(...issued.effects)
        clinicalQuality = issued.clinicalQuality
      } else {
        const currentDraft = kind === 'laboratory' ? detail.laboratoryRequests?.draft
          : kind === 'imaging' ? detail.imagingRequests?.draft : detail.pathologyRequests?.draft
        const currentVersion = (kind === 'laboratory' ? detail.laboratoryRequests : kind === 'imaging' ? detail.imagingRequests : detail.pathologyRequests)?.draftVersion ?? 0
        if (currentVersion !== draftVersion) throw new WorkflowError('WORKFLOW_CONFLICT', 'The investigation draft version has changed')
        if (currentDraft !== undefined && request.input.resolveExistingDraft !== true) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'An existing investigation draft needs explicit resolution before confirming prepared items')
        }
        assertOutpatientOrderPrerequisites(this.options.database, context, caseId)
        let resolvedDraft = currentDraft === undefined
        for (const [selectionIndex, selection] of selections.entries()) {
          const previousVersion = draftVersion, previousEffects = effects.length, previousRecords = recordIds.length
          this.options.database.driver.exec('SAVEPOINT doctor_preparation_item')
          try {
            validateService(selection)
            if (!resolvedDraft) {
              const input = { ...base, expectedDraftVersion: draftVersion }
              const deleted = kind === 'laboratory' ? this.options.workflow.applyDeleteLaboratoryRequestDraft(transaction, input)
                : kind === 'imaging' ? this.options.workflow.imaging.applyDeleteDraft(transaction, input)
                  : this.options.workflow.pathology.applyDeleteDraft(transaction, input)
              draftVersion = deleted.data.draftVersion
              effects.push(...deleted.effects)
            }
            if (selection.kind === 'laboratory') {
              const saved = this.options.workflow.applySaveLaboratoryRequestDraft(transaction, {
                ...base, expectedDraftVersion: draftVersion, catalogItemId: selection.catalogItemId, indicationCode: selection.indicationCode,
              })
              const issued = this.options.workflow.applyIssueLaboratoryRequest(transaction, { ...base, expectedDraftVersion: saved.data.draftVersion })
              draftVersion = issued.data.draftVersion
              recordIds.push(issued.data.request.id)
              effects.push(...issued.effects)
            } else if (selection.kind === 'imaging') {
              const saved = this.options.workflow.imaging.applySaveDraft(transaction, {
                ...base, expectedDraftVersion: draftVersion, serviceId: selection.serviceId, indication: selection.indication,
              })
              const issued = this.options.workflow.imaging.applyIssue(transaction, {
                ...base, expectedDraftVersion: saved.data.draftVersion,
                readyExamCodes: new Set(offerings.imaging?.items.filter(item => item.available).map(item => item.service.examCode)),
              })
              draftVersion = issued.data.draftVersion
              recordIds.push(issued.data.request.id)
              effects.push(...issued.effects)
            } else if (selection.kind === 'pathology') {
              const saved = this.options.workflow.pathology.applySaveDraft(transaction, {
                ...base, expectedDraftVersion: draftVersion, serviceId: selection.serviceId,
                sourceProcedureReference: selection.sourceProcedureReference, purpose: selection.purpose,
                sourceProcedures: new Map(offerings.pathology?.items.map(item => [item.service.examCode, item.sourceProcedures])),
              })
              const issued = this.options.workflow.pathology.applyIssue(transaction, {
                ...base, expectedDraftVersion: saved.data.draftVersion,
                readyExamCodes: new Set(offerings.pathology?.items.filter(item => item.available).map(item => item.service.examCode)),
                sourceProcedures: new Map(offerings.pathology?.items.map(item => [item.service.examCode, item.sourceProcedures])),
              })
              draftVersion = issued.data.draftVersion
              recordIds.push(issued.data.request.id)
              effects.push(...issued.effects)
            }
            this.options.database.driver.exec('RELEASE doctor_preparation_item')
            resolvedDraft = true
            results.push({ selectionIndex, status: 'succeeded', recordId: recordIds.at(-1)! })
          } catch (error) {
            this.options.database.driver.exec('ROLLBACK TO doctor_preparation_item')
            this.options.database.driver.exec('RELEASE doctor_preparation_item')
            draftVersion = previousVersion; effects.length = previousEffects; recordIds.length = previousRecords
            if (!(error instanceof WorkflowError) || error.code === 'ROLE_NOT_ALLOWED') throw error
            results.push({
              selectionIndex,
              status: 'failed',
              code: error.code,
              message: error.message,
              ...(error.reason === undefined ? {} : { reason: error.reason }),
            })
          }
        }
      }
      return {
        data: { caseId, kind, draftVersion, encounterVersion, recordIds, ...(results.length === 0 ? {} : { results }) },
        effects,
        ...(clinicalQuality === undefined ? {} : { clinicalQuality }),
      }
    })
  }
}
