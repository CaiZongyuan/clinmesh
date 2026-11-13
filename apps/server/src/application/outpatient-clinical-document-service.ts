import { fhirResourceSchema, type FhirResource } from '@clinmesh/contracts/fhir'
import {
  cancelClinicalDocumentSignResponseSchema,
  clinicalDocumentAgentFactSchema,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftContentSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentQualityControlStateSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  confirmClinicalVisitKindRequestSchema,
  confirmClinicalVisitKindResponseSchema,
  encounterCompletionResponseSchema,
  firstVisitDraftResponseSchema,
  revisitDraftResponseSchema,
  type ApiConflict,
  type ClinicalDocumentContent,
  type EncounterCompletionPreview,
  type EncounterCompletionTarget,
} from '@clinmesh/contracts/his'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinicalDocumentQualityControl } from './clinical-document-quality.ts'
import {
  clinicalVisitKindSystem,
  clinicalVisitTypes,
  readClinicalHistoryContext,
} from './clinical-history-context.ts'
import type { ClinicalRequestStatus } from './clinical-request-kernel.ts'
import {
  provenanceAgents,
  type ActorContext,
  type CommandResponse,
  type CommandTransaction,
} from './command-executor.ts'
import type { ConsultationRecordingService } from './consultation-recording-service.ts'
import {
  clinicalSignExpectedVersionsSchema,
  diagnosisStateRowSchema,
  documentBundleEntrySchema,
  documentDraftContentSchema,
  encounterCompletionResourceSchema,
  firstVisitDraftContentSchema,
  localFhirReferences,
  medicationCourseDefaultsSchema,
  practitionerRoleIdRowSchema,
  provenanceReasonSchema,
  revisitDraftContentSchema,
  signedClinicalDocumentRowSchema,
  storedDiagnosisDraftContentSchema,
  xhtmlText,
  xhtmlTextValue,
  type MedicationRuleSelection,
  type OutpatientWorkflowContext,
} from './outpatient-workflow-context.ts'
import { WorkflowError } from './workflow-error.ts'

const clinicalDocumentSectionSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/clinical-document-section'
const clinicalDocumentBundleIdentifierSystem = 'https://caizongyuan.github.io/clinmesh/fhir/identifier/clinical-document-bundle'
const fhirCanonicalBase = 'https://caizongyuan.github.io/clinmesh/fhir'

const clinicalDocumentSections = [
  { code: 'chief-complaint', field: 'chiefComplaint', title: '主诉' },
  { code: 'history-of-present-illness', field: 'historyOfPresentIllness', title: '现病史' },
  { code: 'prior-medical-history', field: 'priorMedicalHistory', title: '既往史' },
  { code: 'menstrual-history', field: 'menstrualHistory', title: '月经史' },
  { code: 'obstetric-history', field: 'obstetricHistory', title: '孕产史' },
  { code: 'family-history', field: 'familyHistory', title: '家族史' },
  { code: 'allergy-history', field: 'allergyHistory', title: '过敏史' },
  { code: 'physical-examination', field: 'physicalExamination', title: '体格检查' },
  { code: 'auxiliary-examination', field: 'auxiliaryExamination', title: '辅助检查' },
  { code: 'assessment', field: 'assessment', title: '评估' },
  { code: 'disposition', field: 'disposition', title: '处置' },
  { code: 'follow-up', field: 'followUp', title: '随访' },
] as const

function structuredClinicalDocumentSections(document: ClinicalDocumentContent) {
  return clinicalDocumentSections.flatMap(section => {
    const value = document[section.field]
    if (value === undefined) return []
    return [{
    code: {
      coding: [{
        code: section.code,
        display: section.title,
        system: clinicalDocumentSectionSystem,
      }],
      text: section.title,
    },
    text: {
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(value)}</div>`,
      status: 'generated',
    },
      title: section.title,
    }]
  })
}

function clinicalDocumentRevisionDefinition(
  revision: { assessment: string; plan: string } | { document: ClinicalDocumentContent },
  reason: string,
) {
  const reasonSection = {
    title: '更正原因',
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(reason)}</div>`,
    },
  }
  if ('document' in revision) {
    return {
      kind: 'structured' as const,
      payload: { document: revision.document },
      sections: [reasonSection, ...structuredClinicalDocumentSections(revision.document)],
      title: '门诊结构化病历修订',
    }
  }
  return {
    kind: 'legacy' as const,
    payload: { assessment: revision.assessment, plan: revision.plan },
    sections: [
      reasonSection,
      {
        title: '评估',
        text: {
          status: 'generated',
          div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revision.assessment)}</div>`,
        },
      },
      {
        title: '计划',
        text: {
          status: 'generated',
          div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revision.plan)}</div>`,
        },
      },
    ],
    title: '门诊病历更正',
  }
}

const structuredCompositionSchema = z.object({
  section: z.array(z.object({
    code: z.object({
      coding: z.array(z.object({
        code: z.string(),
        system: z.string(),
      }).loose()),
    }).loose().optional(),
    entry: z.array(z.object({ reference: z.string().min(1) }).loose()).optional(),
    text: z.object({ div: z.string() }).loose(),
    title: z.string().optional(),
  }).loose()),
}).loose()

const clinicalDocumentIdRowSchema = z.object({
  document_id: z.string().min(1),
}).strict()

const clinicalDocumentRevisionSourceRowSchema = practitionerRoleIdRowSchema.extend({
  bundle_id: z.string().min(1),
  document_id: z.string().min(1),
  encounter_id: z.string().min(1),
  patient_id: z.string().min(1),
}).strict()

function structuredClinicalDocumentFromComposition(resource: FhirResource): ClinicalDocumentContent | undefined {
  const composition = structuredCompositionSchema.safeParse(resource)
  if (!composition.success) return undefined
  const sections = new Map(composition.data.section.flatMap(section => {
    const coding = section.code?.coding.find(candidate => candidate.system === clinicalDocumentSectionSystem)
    const value = xhtmlTextValue(section.text.div)
    return coding === undefined || value === undefined ? [] : [[coding.code, value] as const]
  }))
  const content = Object.fromEntries(clinicalDocumentSections.flatMap(section => {
    const value = sections.get(section.code)
    return value === undefined ? [] : [[section.field, value]]
  }))
  const parsed = clinicalDocumentContentSchema.safeParse(content)
  return parsed.success ? parsed.data : undefined
}

function legacyClinicalDocumentFromComposition(resource: FhirResource) {
  const composition = structuredCompositionSchema.safeParse(resource)
  if (!composition.success) return undefined
  const sections = new Map(composition.data.section.flatMap(section => {
    const value = xhtmlTextValue(section.text.div)
    return section.title === undefined || value === undefined ? [] : [[section.title, value] as const]
  }))
  const parsed = z.object({
    assessment: z.string().trim().min(2).max(4_000),
    plan: z.string().trim().min(2).max(4_000),
  }).strict().safeParse({
    assessment: sections.get('评估'),
    plan: sections.get('计划'),
  })
  return parsed.success ? parsed.data : undefined
}

export interface OutpatientClinicalDocumentHost {
  readonly consultationRecording: ConsultationRecordingService
  readonly qualityControl: ClinicalDocumentQualityControl
  assertMedicationAllergies(
    context: ActorContext,
    patientId: string,
    medications: Array<{ code: string; name_en?: string; name_zh?: string }>,
  ): void
  assertMedicationCatalogRules(medications: MedicationRuleSelection[]): void
  openRequestStatuses(context: ActorContext, caseId: string): ClinicalRequestStatus[]
  pendingInvestigationDraftTarget(
    context: ActorContext,
    caseId: string,
  ): 'laboratory' | 'imaging' | 'pathology' | undefined
  medicationCompletionStatus(
    context: ActorContext,
    caseId: string,
  ): {
    prescriptionConclusionSupported: boolean
    hasDraft: boolean
    hasIssuedPrescription: boolean
    hasNoMedicationConclusion: boolean
  }
}

export class OutpatientClinicalDocumentService {
  readonly #context: OutpatientWorkflowContext
  readonly #host: OutpatientClinicalDocumentHost

  constructor(options: {
    context: OutpatientWorkflowContext
    host: OutpatientClinicalDocumentHost
  }) {
    this.#context = options.context
    this.#host = options.host
  }

  hasSignedRoot(context: ActorContext, caseId: string): boolean {
    return this.#signedClinicalDocumentRoot(context, caseId) !== undefined
  }

  clinicalDocumentState(context: ActorContext, caseId: string) {
    const clinicalDocumentDraft = this.#context.database.driver.prepare(`
      SELECT version, content_json, updated_at
      FROM clinical_document_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId) as {
      content_json: string
      updated_at: string
      version: number
    } | undefined
    const signed = this.structuredClinicalDocuments(context, caseId)
    return {
      clinicalDocument: clinicalDocumentDraft === undefined && signed.length === 0
        ? undefined
        : {
            ...(clinicalDocumentDraft === undefined ? {} : {
              draft: {
                ...clinicalDocumentDraftContentSchema.parse(JSON.parse(clinicalDocumentDraft.content_json)),
                updatedAt: clinicalDocumentDraft.updated_at,
                version: clinicalDocumentDraft.version,
              },
            }),
            signed,
          },
      signedCount: signed.length,
    }
  }

  clinicalDraftSummary(context: ActorContext, caseId: string) {
    const draftRows = this.#context.database.driver.prepare(`
      SELECT draft_kind, version, content_json FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).all(context.workspaceId, context.epoch, caseId) as Array<{
      content_json: string
      draft_kind: 'document' | 'first-visit' | 'revisit'
      version: number
    }>
    const drafts: Record<string, unknown> = {}
    for (const draft of draftRows) {
      if (draft.draft_kind === 'first-visit') {
        drafts.firstVisit = {
          ...firstVisitDraftContentSchema.parse(JSON.parse(draft.content_json)),
          version: draft.version,
        }
      } else if (draft.draft_kind === 'revisit') {
        const value = revisitDraftContentSchema.parse(JSON.parse(draft.content_json))
        const conditionId = value.conditionId
        drafts.revisit = {
          ...value,
          conditionVersion: this.#context.fhir.read(context, 'Condition', conditionId).meta?.versionId,
          version: draft.version,
        }
      } else {
        drafts.document = {
          ...documentDraftContentSchema.parse(JSON.parse(draft.content_json)),
          version: draft.version,
        }
      }
    }
    const prescription = this.#context.database.driver.prepare(`
      SELECT prescription_id, prescription_number, status, version
      FROM prescription
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId) as {
      prescription_id: string
      prescription_number: string
      status: string
      version: number
    } | undefined
    if (prescription !== undefined) {
      const items = this.#context.database.driver.prepare(`
        SELECT medication_request_id, medication_id, quantity, dose_text, frequency_code
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(context.workspaceId, context.epoch, prescription.prescription_id) as Array<{
        dose_text: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        quantity: number
      }>
      drafts.prescription = {
        id: prescription.prescription_id,
        items: items.map(item => ({
          doseText: item.dose_text,
          frequencyCode: item.frequency_code,
          medicationId: item.medication_id,
          medicationRequestId: item.medication_request_id,
          quantity: item.quantity,
          versionId: this.#context.fhir.read(context, 'MedicationRequest', item.medication_request_id).meta?.versionId,
        })),
        number: prescription.prescription_number,
        status: prescription.status,
        version: prescription.version,
      }
    }
    return Object.keys(drafts).length === 0 ? undefined : drafts
  }

  encounterCompletionPolicy(context: ActorContext, encounterId: string): EncounterCompletionPreview {
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    if (!this.#context.hasConsultation(context, outpatientCase.case_id)) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'Encounter completion is available only for an independent Consultation',
      )
    }
    const encounter = encounterCompletionResourceSchema.parse(
      this.#context.fhir.read(context, 'Encounter', encounterId),
    )
    const diagnosis = this.#context.confirmedDiagnoses(context, outpatientCase.case_id)
    const primaryDiagnosisConfirmed = diagnosis?.entries.some(entry => entry.role === 'primary') === true
    const documents = this.structuredClinicalDocuments(context, outpatientCase.case_id)
    const signedDocument = documents.at(-1)
    const requiredReportsAcknowledged = this.#host
      .openRequestStatuses(context, outpatientCase.case_id)
      .every(status => status === 'acknowledged')
    const medicationStatus = this.#host.medicationCompletionStatus(
      context,
      outpatientCase.case_id,
    )
    const medicationConclusionRecorded = medicationStatus.hasIssuedPrescription
      || medicationStatus.hasNoMedicationConclusion
    const clinicalDocumentDraft = z.object({ present: z.literal(1) }).strict().optional().parse(
      this.#context.database.driver.prepare(`
        SELECT 1 AS present FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    const diagnosisDraft = diagnosisStateRowSchema.pick({ draft_json: true }).optional().parse(
      this.#context.database.driver.prepare(`
        SELECT draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    const investigationDraftTarget = this.#host.pendingInvestigationDraftTarget(
      context,
      outpatientCase.case_id,
    )
    let pendingDraftTarget: EncounterCompletionTarget | undefined
    if (signedDocument === undefined && clinicalDocumentDraft !== undefined) {
      pendingDraftTarget = 'clinical-document'
    } else if (investigationDraftTarget !== undefined) {
      pendingDraftTarget = investigationDraftTarget
    } else if (
      diagnosisDraft?.draft_json !== null
      && diagnosisDraft?.draft_json !== undefined
      && storedDiagnosisDraftContentSchema.parse(JSON.parse(diagnosisDraft.draft_json)).entries.length > 0
    ) {
      pendingDraftTarget = 'diagnosis'
    } else if (medicationStatus.hasDraft) {
      pendingDraftTarget = 'medication-conclusion'
    }
    const noPendingDrafts = pendingDraftTarget === undefined
    const dispositionComplete = (signedDocument?.content.disposition.trim().length ?? 0) >= 2
    const followUpComplete = (signedDocument?.content.followUp.trim().length ?? 0) >= 2
    const items = [
      {
        code: 'primary-diagnosis-confirmed' as const,
        status: primaryDiagnosisConfirmed ? 'complete' as const : 'incomplete' as const,
        statusText: primaryDiagnosisConfirmed ? '已确认主诊断' : '待确认主诊断',
        target: 'diagnosis' as const,
      },
      {
        code: 'clinical-document-signed' as const,
        status: signedDocument === undefined ? 'incomplete' as const : 'complete' as const,
        statusText: signedDocument === undefined ? '待签署结构化病历' : '已签署结构化病历',
        target: 'clinical-document' as const,
      },
      {
        code: 'required-reports-acknowledged' as const,
        status: requiredReportsAcknowledged ? 'complete' as const : 'incomplete' as const,
        statusText: requiredReportsAcknowledged
          ? '必要报告已全部确认已阅'
          : '待确认必要报告已阅',
        target: 'laboratory' as const,
      },
      {
        code: 'medication-conclusion-recorded' as const,
        status: medicationConclusionRecorded ? 'complete' as const : 'incomplete' as const,
        statusText: medicationConclusionRecorded ? '已记录用药结论' : '待记录用药结论',
        target: 'medication-conclusion' as const,
      },
      {
        code: 'no-pending-drafts' as const,
        status: noPendingDrafts ? 'complete' as const : 'incomplete' as const,
        statusText: noPendingDrafts ? '无未处理临床草稿' : '存在未处理临床草稿',
        target: pendingDraftTarget ?? 'clinical-document',
      },
      {
        code: 'disposition-complete' as const,
        status: dispositionComplete ? 'complete' as const : 'incomplete' as const,
        statusText: dispositionComplete ? '已完善处置' : '待完善处置',
        target: 'clinical-document' as const,
      },
      {
        code: 'follow-up-complete' as const,
        status: followUpComplete ? 'complete' as const : 'incomplete' as const,
        statusText: followUpComplete ? '已完善随访安排' : '待完善随访安排',
        target: 'clinical-document' as const,
      },
    ]
    return {
      canComplete: encounter.status === 'in-progress'
        && items.every(item => item.status === 'complete'),
      encounterId,
      encounterVersion: encounter.meta.versionId,
      items,
    }
  }

  encounterCompletionPreview(context: ActorContext, encounterId: string): EncounterCompletionPreview {
    this.#context.assertRole(context, ['outpatient-doctor'])
    return this.encounterCompletionPolicy(context, encounterId)
  }

  completeEncounter(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof encounterCompletionResponseSchema.shape.data>> {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    const expectedReference = `Encounter/${input.encounterId}`
    if (
      Object.keys(input.expectedVersions).length !== 1
      || input.expectedVersions[expectedReference] === undefined
    ) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Expected versions must contain only ${expectedReference}`,
      )
    }
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: encounterCompletionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.complete',
    }, transaction => {
      this.#context.assertExpectedVersions(input.expectedVersions, [expectedReference])
      const policy = this.encounterCompletionPolicy(input.context, input.encounterId)
      if (!policy.canComplete) {
        const missing = policy.items
          .filter(item => item.status === 'incomplete')
          .map(item => item.statusText)
        throw new WorkflowError(
          'ENCOUNTER_COMPLETION_BLOCKED',
          missing.length === 0
            ? '该就诊当前不可完诊'
            : `完诊条件未满足：${missing.join('；')}`,
        )
      }
      const encounter = encounterCompletionResourceSchema.parse(
        transaction.fhir.read(input.context, 'Encounter', input.encounterId),
      )
      const completedAt = this.#context.virtualTime(input.context)
      const completedEncounter = encounterCompletionResourceSchema.parse(
        transaction.fhir.update(input.context, {
          ...encounter,
          status: 'completed',
          actualPeriod: {
            ...encounter.actualPeriod,
            end: completedAt,
          },
        }, encounter.meta.versionId),
      )
      return {
        data: {
          completedAt,
          encounterId: input.encounterId,
          encounterVersion: completedEncounter.meta.versionId,
          status: 'completed' as const,
        },
        effects: [{
          kind: 'updated' as const,
          reference: `Encounter/${input.encounterId}`,
          versionId: completedEncounter.meta.versionId,
        }],
      }
    })
  }

  saveRevisitDraft(input: {
    context: ActorContext
    draft: {
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      expectedVersions: {
        documentDraft: number
        prescription: number
        revisitDraft: number
      }
      medications: Array<{
        catalogItemId: string
        doseText: string
        frequencyCode: string
        quantity: number
      }>
    }
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    conditionId: string
    documentDraftVersion: number
    medicationRequestIds: string[]
    prescriptionId: string
    prescriptionNumber: string
    prescriptionVersion: number
    revisitDraftVersion: number
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: revisitDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.draft },
      operation: 'encounter.save-revisit-draft',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'revisit-draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not in revisit drafting')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#context.assertNoIndependentDiagnosisOwner(input.context, outpatientCase.case_id)
      this.#context.assertNoIndependentPrescriptionOwner(input.context, outpatientCase.case_id)
      const currentDrafts = this.#context.database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftVersions = new Map(currentDrafts.map(draft => [draft.draft_kind, draft.version]))
      const existingPrescription = this.#context.database.driver.prepare(`
        SELECT prescription_id, prescription_number, status, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        prescription_id: string
        prescription_number: string
        status: string
        version: number
      } | undefined
      if (
        (draftVersions.get('revisit') ?? 0) !== input.draft.expectedVersions.revisitDraft
        || (draftVersions.get('document') ?? 0) !== input.draft.expectedVersions.documentDraft
        || (existingPrescription?.version ?? 0) !== input.draft.expectedVersions.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'One or more revisit draft versions are stale')
      }
      if (existingPrescription !== undefined && existingPrescription.status !== 'draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is no longer editable')
      }
      const medicationCatalog = input.draft.medications.map((medication) => {
        const catalog = this.#context.catalogItem(input.context, medication.catalogItemId, 'medication')
        const config = medicationCourseDefaultsSchema.parse(
          JSON.parse(catalog.config_json ?? '{}'),
        )
        return {
          ...medication,
          catalog,
          courseDays: config.defaultCourseDays ?? 1,
          snapshot: JSON.stringify({
            code: catalog.code,
            display: catalog.name_zh,
            id: catalog.item_id,
            sourceLocator: 'operational:outpatient_catalog',
            system: 'urn:clinmesh:operational:medication',
            version: String(catalog.version),
          }),
        }
      })
      this.#host.assertMedicationCatalogRules(medicationCatalog.map(medication => ({
        catalogItemId: medication.catalogItemId,
        configJson: medication.catalog.config_json,
        doseText: medication.doseText,
        frequencyCode: medication.frequencyCode,
      })))
      this.#host.assertMedicationAllergies(
        input.context,
        outpatientCase.patient_id,
        medicationCatalog.map(medication => medication.catalog),
      )
      const revisitContent = currentDrafts.find(draft => draft.draft_kind === 'revisit')
      const existingConditionId = revisitContent === undefined
        ? undefined
        : revisitDraftContentSchema.parse(JSON.parse(revisitContent.content_json)).conditionId
      if (existingPrescription !== undefined && existingConditionId === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The revisit draft dependencies are incomplete')
      }
      const conditionId = existingConditionId ?? uuidv7()
      const prescriptionId = existingPrescription?.prescription_id ?? uuidv7()
      const now = this.#context.virtualTime(input.context)
      const prescriptionCount = (this.#context.database.driver.prepare(`
        SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = ? AND epoch = ?
      `).get(input.context.workspaceId, input.context.epoch) as { count: number }).count + 1
      const prescriptionNumber = existingPrescription?.prescription_number
        ?? `CM-RX-${now.slice(0, 10).replaceAll('-', '')}-${String(prescriptionCount).padStart(4, '0')}`
      let condition: FhirResource
      let conditionEffectKind: 'created' | 'updated'
      if (existingConditionId === undefined) {
        condition = transaction.fhir.create(input.context, {
          resourceType: 'Condition',
          id: conditionId,
          clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
          verificationStatus: { coding: [{ code: 'provisional', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
          code: { coding: [{ code: input.draft.diagnosis.code, display: input.draft.diagnosis.display, system: 'http://hl7.org/fhir/sid/icd-10' }] },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          recordedDate: now,
          recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        })
        conditionEffectKind = 'created'
      } else {
        const currentCondition = transaction.fhir.read(input.context, 'Condition', conditionId)
        if (input.expectedVersions[`Condition/${conditionId}`] !== currentCondition.meta?.versionId) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version is stale')
        }
        condition = transaction.fhir.update(input.context, {
          ...currentCondition,
          code: { coding: [{ code: input.draft.diagnosis.code, display: input.draft.diagnosis.display, system: 'http://hl7.org/fhir/sid/icd-10' }] },
          recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        }, currentCondition.meta?.versionId ?? '1')
        conditionEffectKind = 'updated'
      }
      if (existingPrescription === undefined) {
        this.#context.database.driver.prepare(`
          INSERT INTO prescription (
            workspace_id, epoch, prescription_id, case_id, prescription_number,
            status, version, authored_by, authored_at
          ) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          outpatientCase.case_id,
          prescriptionNumber,
          input.context.actorId,
          now,
        )
      } else {
        const update = this.#context.database.driver.prepare(`
          UPDATE prescription SET version = version + 1
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
            AND status = 'draft' AND version = ?
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          existingPrescription.version,
        )
        if (update.changes !== 1) throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version is stale')
      }
      const existingItems = existingPrescription === undefined ? [] : this.#context.database.driver.prepare(`
        SELECT medication_request_id FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, prescriptionId) as Array<{
        medication_request_id: string
      }>
      const medicationEffects: Array<{
        kind: 'created' | 'updated'
        resource: FhirResource
      }> = []
      const medicationRequests = medicationCatalog.map((medication, index) => {
        const existingItem = existingItems[index]
        const medicationRequestId = existingItem?.medication_request_id ?? uuidv7()
        const requestContent = {
          status: 'draft',
          intent: 'order',
          medication: { reference: { reference: `Medication/${medication.catalogItemId}` } },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          authoredOn: now,
          requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
          dosageInstruction: [{ text: `${medication.doseText} ${medication.frequencyCode}` }],
          dispenseRequest: { quantity: { value: medication.quantity } },
          groupIdentifier: {
            system: 'https://caizongyuan.github.io/clinmesh/fhir/prescription-number',
            value: prescriptionNumber,
          },
        }
        let resource: FhirResource
        if (existingItem === undefined) {
          resource = transaction.fhir.create(input.context, {
            resourceType: 'MedicationRequest',
            id: medicationRequestId,
            ...requestContent,
          })
          this.#context.database.driver.prepare(`
            INSERT INTO prescription_item (
              workspace_id, epoch, prescription_id, medication_request_id,
              medication_id, medication_snapshot_json, quantity, dose_text,
              frequency_code, course_days
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.context.workspaceId,
            input.context.epoch,
            prescriptionId,
            medicationRequestId,
            medication.catalogItemId,
            medication.snapshot,
            medication.quantity,
            medication.doseText,
            medication.frequencyCode,
            medication.courseDays,
          )
          medicationEffects.push({ kind: 'created', resource })
        } else {
          const currentRequest = transaction.fhir.read(input.context, 'MedicationRequest', medicationRequestId)
          if (input.expectedVersions[`MedicationRequest/${medicationRequestId}`] !== currentRequest.meta?.versionId) {
            throw new WorkflowError('WORKFLOW_CONFLICT', 'A medication request draft version is stale')
          }
          resource = transaction.fhir.update(input.context, {
            ...currentRequest,
            ...requestContent,
          }, currentRequest.meta?.versionId ?? '1')
          this.#context.database.driver.prepare(`
            UPDATE prescription_item
            SET medication_id = ?, medication_snapshot_json = ?, quantity = ?,
              dose_text = ?, frequency_code = ?, course_days = ?
            WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
              AND medication_request_id = ?
          `).run(
            medication.catalogItemId,
            medication.snapshot,
            medication.quantity,
            medication.doseText,
            medication.frequencyCode,
            medication.courseDays,
            input.context.workspaceId,
            input.context.epoch,
            prescriptionId,
            medicationRequestId,
          )
          medicationEffects.push({ kind: 'updated', resource })
        }
        return resource
      })
      for (const removedItem of existingItems.slice(medicationCatalog.length)) {
        const currentRequest = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          removedItem.medication_request_id,
        )
        if (
          input.expectedVersions[`MedicationRequest/${removedItem.medication_request_id}`]
          !== currentRequest.meta?.versionId
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'A removed medication request draft version is stale')
        }
        const cancelled = transaction.fhir.update(input.context, {
          ...currentRequest,
          status: 'cancelled',
        }, currentRequest.meta?.versionId ?? '1')
        this.#context.database.driver.prepare(`
          DELETE FROM prescription_item
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
            AND medication_request_id = ?
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          removedItem.medication_request_id,
        )
        medicationEffects.push({ kind: 'updated', resource: cancelled })
      }
      const nextRevisitDraftVersion = input.draft.expectedVersions.revisitDraft + 1
      const nextDocumentDraftVersion = input.draft.expectedVersions.documentDraft + 1
      const saveDraft = this.#context.database.driver.prepare(`
        INSERT INTO clinical_draft (
          workspace_id, epoch, case_id, draft_kind, version,
          content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id, draft_kind) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      const compositionDraft = fhirResourceSchema.parse({
        resourceType: 'Composition',
        id: `draft-composition-${outpatientCase.case_id}`,
        status: 'preliminary',
        type: { text: 'Synthetic outpatient clinical note draft' },
        subject: [{ reference: `Patient/${outpatientCase.patient_id}` }],
        encounter: { reference: `Encounter/${input.encounterId}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊病历草稿',
        section: [
          {
            title: '评估',
            text: {
              status: 'generated',
              div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(input.draft.document.assessment)}</div>`,
            },
          },
          {
            title: '计划',
            text: {
              status: 'generated',
              div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(input.draft.document.plan)}</div>`,
            },
          },
        ],
      })
      saveDraft.run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        'revisit',
        nextRevisitDraftVersion,
        JSON.stringify({ diagnosis: input.draft.diagnosis, conditionId }),
        input.context.actorId,
        now,
      )
      saveDraft.run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        'document',
        nextDocumentDraftVersion,
        JSON.stringify({
          ...input.draft.document,
          composition: compositionDraft,
          diagnosis: input.draft.diagnosis,
          medicationRequestIds: medicationRequests.map(resource => resource.id),
        }),
        input.context.actorId,
        now,
      )
      this.#context.database.driver.prepare(`
        UPDATE outpatient_case
        SET prescription_id = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'revisit-draft'
      `).run(
        prescriptionId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      return {
        data: {
          conditionId,
          documentDraftVersion: nextDocumentDraftVersion,
          medicationRequestIds: medicationRequests.map(resource => resource.id),
          prescriptionId,
          prescriptionNumber,
          prescriptionVersion: (existingPrescription?.version ?? 0) + 1,
          revisitDraftVersion: nextRevisitDraftVersion,
        },
        effects: [
          { kind: conditionEffectKind, resource: condition },
          ...medicationEffects,
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  previewClinicalSign(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersions: {
      documentDraft: number
      prescription: number
      revisitDraft: number
    }
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    commitToken: string
    expiresAt: string
    medicationTotalFen: number
    previewId: string
    summary: {
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      medications: Array<{
        medicationId: string
        medicationRequestId: string
        nameEn: string
        nameZh: string
        quantity: number
        subtotalFen: number
        unitPriceFen: number
      }>
    }
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: clinicalSignPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersions: input.expectedDraftVersions,
      },
      operation: 'encounter.preview-clinical-sign',
    }, () => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'revisit-draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not ready for signing')
      }
      this.#assertNoConsultationForLegacySigning(input.context, outpatientCase.case_id)
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      this.#context.assertExpectedVersions(
        input.expectedVersions,
        this.clinicalExpectedReferences(
          input.context,
          outpatientCase.case_id,
          input.encounterId,
          outpatientCase.doctor_task_id,
        ),
      )
      const drafts = this.#context.database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftMap = new Map(drafts.map(draft => [draft.draft_kind, draft]))
      const prescription = this.#context.database.driver.prepare(`
        SELECT prescription_id, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'draft'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        prescription_id: string
        version: number
      } | undefined
      if (
        draftMap.get('revisit')?.version !== input.expectedDraftVersions.revisitDraft
        || draftMap.get('document')?.version !== input.expectedDraftVersions.documentDraft
        || prescription?.version !== input.expectedDraftVersions.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing dependency versions are stale')
      }
      const medications = this.#context.database.driver.prepare(`
        SELECT item.medication_request_id, item.medication_id, item.quantity,
          item.dose_text, item.frequency_code, catalog.code, catalog.config_json,
          catalog.name_zh, catalog.name_en, catalog.price_fen
        FROM prescription_item AS item
        JOIN outpatient_catalog AS catalog
          ON catalog.workspace_id = item.workspace_id
         AND catalog.epoch = item.epoch
         AND catalog.item_id = item.medication_id
         AND catalog.kind = 'medication'
         AND catalog.active = 1
        WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
      `).all(input.context.workspaceId, input.context.epoch, prescription?.prescription_id) as Array<{
        code: string
        config_json: string
        dose_text: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        name_en: string
        name_zh: string
        price_fen: number
        quantity: number
      }>
      if (medications.length === 0) throw new WorkflowError('CATALOG_CONFLICT', 'The prescription has no active medication')
      this.#host.assertMedicationCatalogRules(medications.map(medication => ({
        catalogItemId: medication.medication_id,
        configJson: medication.config_json,
        doseText: medication.dose_text,
        frequencyCode: medication.frequency_code,
      })))
      this.#host.assertMedicationAllergies(input.context, outpatientCase.patient_id, medications)
      const revisit = revisitDraftContentSchema.parse(draftMap.get('revisit')?.content_json === undefined
        ? undefined
        : JSON.parse(draftMap.get('revisit')?.content_json ?? ''))
      const document = documentDraftContentSchema.parse(draftMap.get('document')?.content_json === undefined
        ? undefined
        : JSON.parse(draftMap.get('document')?.content_json ?? ''))
      const medicationTotalFen = medications.reduce(
        (total, medication) => total + medication.price_fen * medication.quantity,
        0,
      )
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#context.hashToken(`clinical-sign:${previewId}`)}`
      const expiresAt = new Date(Date.parse(this.#context.virtualTime(input.context)) + 5 * 60_000).toISOString()
      const summary = {
        diagnosis: {
          code: revisit.diagnosis.code,
          display: revisit.diagnosis.display,
        },
        document: {
          assessment: document.assessment,
          plan: document.plan,
        },
        medications: medications.map(medication => ({
          medicationId: medication.medication_id,
          medicationRequestId: medication.medication_request_id,
          nameEn: medication.name_en,
          nameZh: medication.name_zh,
          quantity: medication.quantity,
          subtotalFen: medication.price_fen * medication.quantity,
          unitPriceFen: medication.price_fen,
        })),
      }
      this.#context.database.driver.prepare(`
        INSERT INTO clinical_sign_preview (
          workspace_id, epoch, preview_id, case_id, expected_versions_json,
          summary_json, medication_total_fen, token_hash, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        outpatientCase.case_id,
        JSON.stringify(input.expectedDraftVersions),
        JSON.stringify(summary),
        medicationTotalFen,
        this.#context.hashToken(commitToken),
        expiresAt,
      )
      return {
        data: {
          commitToken,
          expiresAt,
          medicationTotalFen,
          previewId,
          summary,
        },
        effects: [{
          kind: 'created',
          reference: `ClinicalSignPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  signAndComplete(input: {
    commitToken: string
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    bundleId: string
    chargeItemId: string
    compositionId: string
    encounterId: string
    encounterVersion: string
    provenanceId: string
    status: 'awaiting-medication-payment'
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: clinicalSignResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        commitToken: input.commitToken,
        encounterId: input.encounterId,
        previewId: input.previewId,
      },
      operation: 'encounter.sign-and-complete',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const preview = this.#context.database.driver.prepare(`
        SELECT preview.*, outpatient_case.encounter_id, outpatient_case.patient_id,
          outpatient_case.account_id, outpatient_case.doctor_task_id,
          outpatient_case.prescription_id, outpatient_case.status AS case_status
        FROM clinical_sign_preview AS preview
        JOIN outpatient_case
          ON outpatient_case.workspace_id = preview.workspace_id
         AND outpatient_case.epoch = preview.epoch
         AND outpatient_case.case_id = preview.case_id
        WHERE preview.workspace_id = ? AND preview.epoch = ? AND preview.preview_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.previewId) as {
        account_id: string
        case_id: string
        case_status: string
        consumed_at: string | null
        doctor_task_id: string | null
        encounter_id: string
        expected_versions_json: string
        expires_at: string
        medication_total_fen: number
        patient_id: string
        prescription_id: string | null
        token_hash: string
      } | undefined
      if (
        preview === undefined
        || preview.consumed_at !== null
        || preview.encounter_id !== input.encounterId
        || preview.case_status !== 'revisit-draft'
        || preview.prescription_id === null
        || preview.doctor_task_id === null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing preview is unavailable')
      }
      this.#assertNoConsultationForLegacySigning(input.context, preview.case_id)
      if (this.#signedClinicalDocumentRoot(input.context, preview.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      this.#context.assertExpectedVersions(
        input.expectedVersions,
        this.clinicalExpectedReferences(
          input.context,
          preview.case_id,
          preview.encounter_id,
          preview.doctor_task_id,
        ),
      )
      if (preview.token_hash !== this.#context.hashToken(input.commitToken)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing token is invalid')
      }
      if (Date.parse(preview.expires_at) < Date.parse(this.#context.virtualTime(input.context))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing preview has expired')
      }
      const expectedDrafts = clinicalSignExpectedVersionsSchema.parse(
        JSON.parse(preview.expected_versions_json),
      )
      const drafts = this.#context.database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, preview.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftMap = new Map(drafts.map(draft => [draft.draft_kind, draft]))
      const prescription = this.#context.database.driver.prepare(`
        SELECT prescription_number, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ? AND status = 'draft'
      `).get(input.context.workspaceId, input.context.epoch, preview.prescription_id) as {
        prescription_number: string
        version: number
      } | undefined
      if (
        draftMap.get('revisit')?.version !== expectedDrafts.revisitDraft
        || draftMap.get('document')?.version !== expectedDrafts.documentDraft
        || prescription?.version !== expectedDrafts.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing dependencies changed after preview')
      }
      const revisitDraft = revisitDraftContentSchema.parse(
        JSON.parse(draftMap.get('revisit')?.content_json ?? '{}'),
      )
      const documentDraft = documentDraftContentSchema.parse(
        JSON.parse(draftMap.get('document')?.content_json ?? '{}'),
      )
      const medicationRows = this.#context.database.driver.prepare(`
        SELECT item.medication_request_id, item.medication_id, item.quantity,
          item.dose_text, item.frequency_code, catalog.name_zh, catalog.name_en,
          catalog.code, catalog.config_json, catalog.price_fen
        FROM prescription_item AS item
        JOIN outpatient_catalog AS catalog
          ON catalog.workspace_id = item.workspace_id
         AND catalog.epoch = item.epoch
         AND catalog.item_id = item.medication_id
         AND catalog.kind = 'medication'
         AND catalog.active = 1
        WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
        ORDER BY item.medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, preview.prescription_id) as Array<{
        dose_text: string
        code: string
        config_json: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        name_en: string
        name_zh: string
        price_fen: number
        quantity: number
      }>
      this.#host.assertMedicationCatalogRules(medicationRows.map(medication => ({
        catalogItemId: medication.medication_id,
        configJson: medication.config_json,
        doseText: medication.dose_text,
        frequencyCode: medication.frequency_code,
      })))
      const medicationTotalFen = medicationRows.reduce(
        (total, medication) => total + medication.price_fen * medication.quantity,
        0,
      )
      if (medicationTotalFen !== preview.medication_total_fen || medicationRows.length === 0) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The medication catalog changed after preview')
      }
      this.#host.assertMedicationAllergies(input.context, preview.patient_id, medicationRows)
      const now = this.#context.virtualTime(input.context)
      const condition = transaction.fhir.read(input.context, 'Condition', revisitDraft.conditionId)
      const signedCondition = transaction.fhir.update(input.context, {
        ...condition,
        verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
      }, condition.meta?.versionId ?? '1')
      const signedMedicationRequests = medicationRows.map(medication => {
        const request = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          medication.medication_request_id,
        )
        return transaction.fhir.update(input.context, {
          ...request,
          status: 'active',
        }, request.meta?.versionId ?? '1')
      })
      this.#context.database.driver.prepare(`
        UPDATE prescription
        SET status = 'signed', version = version + 1, signed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ? AND status = 'draft'
      `).run(now, input.context.workspaceId, input.context.epoch, preview.prescription_id)
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: `Prescription ${prescription?.prescription_number}` },
        subject: { reference: `Patient/${preview.patient_id}` },
        encounter: { reference: `Encounter/${preview.encounter_id}` },
        account: [{ reference: `Account/${preview.account_id}` }],
        occurrenceDateTime: now,
        quantity: { value: medicationRows.reduce((total, medication) => total + medication.quantity, 0) },
        ...(new Set(medicationRows.map(medication => medication.price_fen)).size === 1
          ? {
              unitPriceComponent: {
                amount: { currency: 'CNY', value: (medicationRows[0]?.price_fen ?? 0) / 100 },
              },
            }
          : {}),
        totalPriceComponent: { amount: { currency: 'CNY', value: medicationTotalFen / 100 } },
      })
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'final',
        type: { text: 'Synthetic outpatient clinical note' },
        subject: [{ reference: `Patient/${preview.patient_id}` }],
        encounter: { reference: `Encounter/${preview.encounter_id}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊病历',
        section: [
          { title: '诊断', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revisitDraft.diagnosis.display)}</div>` }, entry: [{ reference: `Condition/${signedCondition.id}` }] },
          { title: '评估', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(documentDraft.assessment)}</div>` } },
          { title: '计划', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(documentDraft.plan)}</div>` }, entry: signedMedicationRequests.map(request => ({ reference: `MedicationRequest/${request.id}` })) },
        ],
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        timestamp: now,
        entry: [composition, signedCondition, ...signedMedicationRequests].map(resource => ({
          fullUrl: `https://caizongyuan.github.io/clinmesh/fhir/${resource.resourceType}/${resource.id}`,
          resource,
        })),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Clinical document signing and Encounter completion' },
        agent: provenanceAgents(input.context, 'Author and signer'),
      })
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const completedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'completed',
        actualPeriod: {
          ...((typeof encounter.actualPeriod === 'object' && encounter.actualPeriod !== null)
            ? encounter.actualPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, encounter.meta?.versionId ?? '1')
      const task = transaction.fhir.read(input.context, 'Task', preview.doctor_task_id)
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, task.meta?.versionId ?? '1')
      this.#context.database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'medication', ?, '门诊药品', 'Outpatient medication',
          ?, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        preview.case_id,
        preview.account_id,
        chargeItemId,
        `Prescription/${preview.prescription_id}`,
        medicationRows.reduce((total, medication) => total + medication.quantity, 0),
        medicationRows.length === 1 ? medicationRows[0]?.price_fen ?? 0 : medicationTotalFen,
        medicationTotalFen,
        now,
      )
      const documentId = uuidv7()
      this.#context.database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, signed_by, signed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        documentId,
        preview.case_id,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
      )
      this.#context.database.driver.prepare(`
        UPDATE clinical_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      this.#context.database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-medication-payment', version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'revisit-draft'
      `).run(now, input.context.workspaceId, input.context.epoch, preview.case_id)
      this.#context.database.driver.prepare(`
        UPDATE registration SET status = 'completed'
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).run(input.context.workspaceId, input.context.epoch, preview.case_id)
      const created = [chargeItem, composition, bundle, provenance]
      const updated = [signedCondition, ...signedMedicationRequests, completedEncounter, completedTask]
      return {
        data: {
          bundleId,
          chargeItemId,
          compositionId,
          encounterId: input.encounterId,
          encounterVersion: completedEncounter.meta?.versionId ?? '7',
          provenanceId,
          status: 'awaiting-medication-payment' as const,
        },
        effects: [
          ...created.map(resource => ({
            kind: 'created' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '1',
          })),
          ...updated.map(resource => ({
            kind: 'updated' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '2',
          })),
        ],
      }
    })
  }

  reviseClinicalDocument(input: {
    compositionId: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reason: string
    revision:
      | { assessment: string; plan: string }
      | { document: ClinicalDocumentContent }
  }): CommandResponse<{
    bundleId: string
    compositionId: string
    compositionVersion: string
    documentId: string
    provenanceId: string
    revisionNumber: number
    revisionOfCompositionId: string
  }> {
    const revision = clinicalDocumentRevisionDefinition(input.revision, input.reason)
    return this.#context.commands.execute({
      authorize: () => {
        this.#context.assertRole(input.context, ['outpatient-doctor'])
        const source = practitionerRoleIdRowSchema.optional().parse(
          this.#context.database.driver.prepare(`
            SELECT responsibility.practitioner_role_id
            FROM signed_clinical_document AS document
            JOIN outpatient_case_responsibility AS responsibility
              ON responsibility.workspace_id = document.workspace_id
             AND responsibility.epoch = document.epoch
             AND responsibility.case_id = document.case_id
            WHERE document.workspace_id = ? AND document.epoch = ?
              AND document.composition_id = ?
          `).get(
            input.context.workspaceId,
            input.context.epoch,
            input.compositionId,
          ),
        )
        if (source === undefined) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The signed clinical document was not found',
            {
              currentStatus: 'missing',
              owner: 'clinical-document',
              resource: `Composition/${input.compositionId}`,
            },
          )
        }
        if (source.practitioner_role_id !== input.context.practitionerRoleId) {
          throw new WorkflowError(
            'ROLE_NOT_ALLOWED',
            'Only the doctor responsible for the outpatient case can revise its Clinical Document',
          )
        }
      },
      context: input.context,
      dataSchema: clinicalDocumentRevisionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        compositionId: input.compositionId,
        reason: input.reason,
        ...revision.payload,
      },
      mapExpectedVersionConflict: error => this.#context.expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.clinicalDocumentConflictStatus(
          input.context,
          input.compositionId,
        ),
        message: 'A Clinical Document resource version has changed',
        owner: 'clinical-document',
        resource: `Composition/${input.compositionId}`,
      }),
      operation: 'clinical-document.revise',
    }, transaction => {
      const source = clinicalDocumentRevisionSourceRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT document.document_id, document.bundle_id, outpatient_case.patient_id,
            outpatient_case.encounter_id, responsibility.practitioner_role_id
          FROM signed_clinical_document AS document
          JOIN outpatient_case
            ON outpatient_case.workspace_id = document.workspace_id
           AND outpatient_case.epoch = document.epoch
           AND outpatient_case.case_id = document.case_id
          JOIN outpatient_case_responsibility AS responsibility
            ON responsibility.workspace_id = outpatient_case.workspace_id
           AND responsibility.epoch = outpatient_case.epoch
           AND responsibility.case_id = outpatient_case.case_id
          WHERE document.workspace_id = ? AND document.epoch = ?
            AND document.composition_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          input.compositionId,
        ),
      )
      if (source === undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The signed clinical document was not found',
          {
            currentStatus: 'missing',
            owner: 'clinical-document',
            resource: `Composition/${input.compositionId}`,
          },
        )
      }
      if (this.#clinicalDocumentHasSuccessor(input.context, source.document_id)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document is superseded; only the latest version can be revised',
          {
            currentStatus: 'superseded',
            owner: 'clinical-document',
            resource: `Composition/${input.compositionId}`,
          },
        )
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Composition/${input.compositionId}`,
        `Encounter/${source.encounter_id}`,
      ])
      const originalComposition = transaction.fhir.read(
        input.context,
        'Composition',
        input.compositionId,
      )
      const originalBundle = transaction.fhir.read(input.context, 'Bundle', source.bundle_id)
      const structuredSource = structuredClinicalDocumentFromComposition(originalComposition)
      if (revision.kind === 'structured' && structuredSource === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The structured Clinical Document was not found')
      }
      if (revision.kind === 'legacy' && structuredSource !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The structured Clinical Document requires structured revision content',
        )
      }
      if ('document' in input.revision) this.#assertClinicalHistoryComplete(input.context, source.encounter_id, input.revision.document)
      const now = this.#context.virtualTime(input.context)
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'amended',
        type: originalComposition.type,
        subject: originalComposition.subject ?? [{ reference: `Patient/${source.patient_id}` }],
        encounter: originalComposition.encounter
          ?? { reference: `Encounter/${source.encounter_id}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: revision.title,
        relatesTo: [{
          type: 'replaces',
          resourceReference: { reference: `Composition/${input.compositionId}` },
        }],
        section: revision.sections,
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        identifier: {
          system: clinicalDocumentBundleIdentifierSystem,
          value: bundleId,
        },
        timestamp: now,
        entry: this.#documentBundleEntries(
          input.context,
          transaction,
          composition,
          originalBundle.entry,
        ),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Clinical document revision' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Clinical document reviser'),
        entity: [{
          role: 'revision',
          what: { reference: `Composition/${input.compositionId}` },
        }],
      })
      const documentId = uuidv7()
      const revisionNumber = this.#clinicalDocumentRevisionNumber(
        input.context,
        source.document_id,
      ) + 1
      this.#context.database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, revision_of_document_id, signed_by, signed_at
        )
        SELECT workspace_id, epoch, ?, case_id, ?, ?, ?, document_id, ?, ?
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND document_id = ?
      `).run(
        documentId,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        source.document_id,
      )
      return {
        data: {
          bundleId,
          compositionId,
          compositionVersion: composition.meta?.versionId ?? '1',
          documentId,
          provenanceId,
          revisionNumber,
          revisionOfCompositionId: input.compositionId,
        },
        effects: [composition, bundle, provenance].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  saveFirstVisitDraft(input: {
    context: ActorContext
    draft: {
      assessment: string
      expectedDraftVersion: number
      historyOfPresentIllness: string
    }
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{ draftVersion: number }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: firstVisitDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.draft },
      operation: 'encounter.save-first-visit-draft',
    }, () => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'first-visit') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not in the first visit')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const current = this.#context.database.driver.prepare(`
        SELECT version FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'first-visit'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
      } | undefined
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.draft.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The first-visit draft version is stale')
      }
      const version = currentVersion + 1
      const now = this.#context.virtualTime(input.context)
      this.#context.database.driver.prepare(`
        INSERT INTO clinical_draft (
          workspace_id, epoch, case_id, draft_kind, version,
          content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, 'first-visit', ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id, draft_kind) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        version,
        JSON.stringify({
          assessment: input.draft.assessment,
          historyOfPresentIllness: input.draft.historyOfPresentIllness,
        }),
        input.context.actorId,
        now,
      )
      return {
        data: { draftVersion: version },
        effects: [{
          kind: current === undefined ? 'created' as const : 'updated' as const,
          reference: `ClinicalDraft/${outpatientCase.case_id}.first-visit`,
          versionId: String(version),
        }],
      }
    })
  }

  confirmClinicalVisitKind(input: {
    context: ActorContext; encounterId: string; request: z.infer<typeof confirmClinicalVisitKindRequestSchema>; idempotencyKey: string
  }) {
    return this.#context.commands.execute({
      context: input.context, operation: 'clinical-document.confirm-visit-kind',
      dataSchema: confirmClinicalVisitKindResponseSchema.shape.data, expectedVersions: input.request.expectedVersions,
      idempotencyKey: input.idempotencyKey, input: { encounterId: input.encounterId, ...input.request.input },
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      if (input.context.agentGrantId !== undefined) throw new WorkflowError('ROLE_NOT_ALLOWED', 'Clinical visit classification requires the responsible doctor')
      const clinicalCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertCaseResponsibility(input.context, clinicalCase.case_id)
      this.#context.assertExpectedVersions(input.request.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || this.#signedClinicalDocumentRoot(input.context, clinicalCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Clinical visit classification can only be confirmed before the first signature')
      }
      const otherTypes = clinicalVisitTypes(encounter).flatMap(type => {
        const coding = type.coding?.filter(item => item.system !== clinicalVisitKindSystem)
        return coding?.length ? [{ ...type, coding }] : type.coding === undefined ? [type] : []
      })
      const updated = transaction.fhir.update(input.context, { ...encounter,
        type: [...otherTypes, { coding: [{ system: clinicalVisitKindSystem, code: input.request.input.visitKind }] }],
      }, input.request.expectedVersions[`Encounter/${input.encounterId}`]!)
      const provenance = transaction.fhir.createImmutable(input.context, { resourceType: 'Provenance', id: uuidv7(),
        target: [{ reference: `Encounter/${input.encounterId}`, extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/provenance-target-version',
          valueString: updated.meta!.versionId,
        }] }],
        recorded: this.#context.virtualTime(input.context), activity: { text: 'Clinical visit classification confirmed' },
        reason: [{ concept: { text: input.request.input.reason } }], agent: provenanceAgents(input.context, 'Clinical visit classification confirmer'),
      })
      this.#context.database.driver.prepare(`UPDATE clinical_document_sign_preview SET consumed_at = ? WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND consumed_at IS NULL`)
        .run(this.#context.now().toISOString(), input.context.workspaceId, input.context.epoch, clinicalCase.case_id)
      this.#host.consultationRecording.resumeAfterSigning(input.context, transaction, clinicalCase.case_id)
      return { data: { caseId: clinicalCase.case_id, encounterId: input.encounterId, encounterVersion: updated.meta!.versionId! }, effects: [
        { kind: 'updated' as const, reference: `Encounter/${input.encounterId}`, versionId: updated.meta!.versionId! },
        { kind: 'created' as const, reference: `Provenance/${provenance.id}`, versionId: '1' },
      ] }
    })
  }

  saveClinicalDocumentDraft(input: {
    context: ActorContext
    document: ClinicalDocumentContent
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    agentGenerated?: boolean
    agentFacts?: z.infer<typeof clinicalDocumentAgentFactSchema>[]
  }): CommandResponse<{ caseId: string; draftVersion: number }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        document: input.document,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        ...(input.agentGenerated === undefined ? {} : { agentGenerated: input.agentGenerated }),
        ...(input.agentFacts === undefined ? {} : { agentFacts: input.agentFacts }),
      },
      operation: 'clinical-document.save-draft',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not editable')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The signed Clinical Document requires a revision')
      }
      const current = this.#context.database.driver.prepare(`
        SELECT version, content_json FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
        content_json: string
      } | undefined
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document draft version has changed',
        )
      }
      const draftVersion = currentVersion + 1
      const now = this.#context.virtualTime(input.context)
      this.#host.consultationRecording.trackDraftSave(input.context, outpatientCase.case_id, input.document)
      const before = current === undefined
        ? { assessment: '', chiefComplaint: '', disposition: '', followUp: '', physicalExamination: '', historyOfPresentIllness: '' }
        : clinicalDocumentDraftContentSchema.parse(JSON.parse(current.content_json))
      this.#host.qualityControl.trackDraft(input.context, outpatientCase.case_id, before, input.document,
        input.agentGenerated === true || input.context.agentGrantId !== undefined, input.agentFacts)
      this.#context.database.driver.prepare(`
        INSERT INTO clinical_document_draft (
          workspace_id, epoch, case_id, version, content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        draftVersion,
        JSON.stringify(input.document),
        input.context.actorId,
        now,
      )
      this.#host.qualityControl.enqueue(input.context, transaction, outpatientCase.case_id)
      return {
        data: { caseId: outpatientCase.case_id, draftVersion },
        effects: [{
          kind: current === undefined ? 'created' : 'updated',
          reference: `ClinicalDocumentDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  #assertNoConsultationForLegacySigning(context: ActorContext, caseId: string): void {
    if (this.#context.consultationState(context, caseId) !== undefined
      || this.#host.consultationRecording.signingProgress(context, caseId).hasRegisteredSources) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'Use structured clinical document signing to review the Consultation')
    }
  }

  cancelStructuredClinicalDocumentSign(input: {
    context: ActorContext; encounterId: string; previewId: string;
    expectedVersions: Record<string, string>; idempotencyKey: string
  }) {
    return this.#context.commands.execute({ context: input.context, operation: 'clinical-document.cancel-sign',
      dataSchema: cancelClinicalDocumentSignResponseSchema.shape.data,
      expectedVersions: input.expectedVersions, idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, previewId: input.previewId },
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const preview = z.object({ case_id: z.string(), consumed_at: z.string().nullable() }).optional().parse(
        this.#context.database.driver.prepare(`SELECT case_id, consumed_at FROM clinical_document_sign_preview
          WHERE workspace_id = ? AND epoch = ? AND preview_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.previewId))
      if (preview?.case_id !== outpatientCase.case_id || preview.consumed_at !== null
        || this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The signing preparation is no longer available')
      }
      this.#context.database.driver.prepare(`UPDATE clinical_document_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ?
      `).run(this.#context.now().toISOString(), input.context.workspaceId, input.context.epoch, input.previewId)
      this.#host.consultationRecording.suspendForSigning(input.context, outpatientCase.case_id)
      this.#host.consultationRecording.resumeAfterSigning(input.context, transaction, outpatientCase.case_id)
      return { data: { previewId: input.previewId }, effects: [{ kind: 'updated' as const,
        reference: `ClinicalDocumentSignPreview/${input.previewId}`, versionId: '2' }] }
    })
  }

  #consultationSignSnapshot(context: ActorContext, caseId: string, encounterId: string) {
    return {
      consultationVersion: this.#context.consultationState(context, caseId)?.version ?? 0,
      sourceCount: this.#host.consultationRecording.signingProgress(context, caseId).sourceCount ?? 0,
      historyContext: this.#clinicalHistoryContext(context, encounterId).fingerprint,
    }
  }

  previewStructuredClinicalDocumentSign(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    qualityControl?: z.infer<typeof clinicalDocumentQualityControlStateSchema> | undefined
    commitToken: string
    document: { content: ClinicalDocumentContent; version: number }
    expiresAt: string
    previewId: string
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentSignPreviewResponseSchema.shape.data.extend({
        consultationReview: z.object({
          consultationVersion: z.number().int().nonnegative(), remainingCount: z.number().int().nonnegative(),
          sourceCount: z.number().int().nonnegative().optional(),
          failedCount: z.number().int().nonnegative(), paused: z.boolean(),
          conflictCount: z.number().int().nonnegative(), unreviewedCount: z.number().int().nonnegative(),
        }).strict().nullable().optional(),
      }).transform(({ consultationReview: _consultationReview, ...data }) => data),
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'clinical-document.preview-sign',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not available for signing')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      const draft = this.#context.database.driver.prepare(`
        SELECT version, content_json FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        content_json: string
        version: number
      } | undefined
      if (draft?.version !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      const document = clinicalDocumentContentSchema.parse(JSON.parse(draft.content_json))
      this.#assertClinicalHistoryComplete(input.context, input.encounterId, document)
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#context.hashToken(`clinical-document-sign:${previewId}`)}`
      const expiresAt = new Date(this.#context.now().getTime() + 5 * 60_000).toISOString()
      const encounterVersion = z.string().parse(
        input.expectedVersions[`Encounter/${input.encounterId}`],
      )
      this.#context.database.driver.prepare(`UPDATE clinical_document_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND consumed_at IS NULL
      `).run(this.#context.now().toISOString(), input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      this.#host.consultationRecording.suspendForSigning(input.context, outpatientCase.case_id)
      this.#context.database.driver.prepare(`
        INSERT INTO clinical_document_sign_preview (
          workspace_id, epoch, preview_id, case_id, draft_version,
          summary_json, token_hash, expires_at, encounter_version, actor_context_hash, consultation_review_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        outpatientCase.case_id,
        draft.version,
        JSON.stringify(document),
        this.#context.hashToken(commitToken),
        expiresAt,
        encounterVersion,
        this.#context.actorContextHash(input.context),
        JSON.stringify(this.#consultationSignSnapshot(input.context, outpatientCase.case_id, input.encounterId)),
      )
      return {
        data: {
          qualityControl: this.#host.qualityControl.read(input.context, outpatientCase.case_id),
          commitToken,
          document: { content: document, version: draft.version },
          expiresAt,
          previewId,
        },
        effects: [{
          kind: 'created',
          reference: `ClinicalDocumentSignPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  signStructuredClinicalDocument(input: {
    commitToken: string
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    bundleId: string
    compositionId: string
    compositionVersion: string
    documentId: string
    provenanceId: string
    revisionNumber: 1
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentSignResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        commitToken: input.commitToken,
        encounterId: input.encounterId,
        previewId: input.previewId,
      },
      operation: 'clinical-document.sign',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not available for signing')
      }
      const preview = this.#context.database.driver.prepare(`
        SELECT case_id, draft_version, summary_json, token_hash, expires_at, consumed_at,
          encounter_version, actor_context_hash, consultation_review_json
        FROM clinical_document_sign_preview
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.previewId) as {
        actor_context_hash: string
        consultation_review_json: string | null
        case_id: string
        consumed_at: string | null
        draft_version: number
        encounter_version: string
        expires_at: string
        summary_json: string
        token_hash: string
      } | undefined
      if (
        preview === undefined
        || preview.case_id !== outpatientCase.case_id
        || preview.consumed_at !== null
        || preview.token_hash !== this.#context.hashToken(input.commitToken)
        || Date.parse(preview.expires_at) <= this.#context.now().getTime()
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document signing preview is unavailable')
      }
      if (
        preview.encounter_version !== input.expectedVersions[`Encounter/${input.encounterId}`]
        || preview.actor_context_hash !== this.#context.actorContextHash(input.context)
      ) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document signing preview context has changed',
        )
      }
      const draft = this.#context.database.driver.prepare(`
        SELECT version, content_json FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        content_json: string
        version: number
      } | undefined
      if (draft?.version !== preview.draft_version) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      const document = clinicalDocumentContentSchema.parse(JSON.parse(draft.content_json))
      const previewDocument = clinicalDocumentContentSchema.parse(JSON.parse(preview.summary_json))
      this.#assertClinicalHistoryComplete(input.context, input.encounterId, document)
      const preparedSnapshot = preview.consultation_review_json === null ? null : z.object({
        consultationVersion: z.number().int().nonnegative(),
        sourceCount: z.number().int().nonnegative().default(0),
        historyContext: z.string().optional(),
      }).parse(JSON.parse(preview.consultation_review_json))
      if (JSON.stringify(preparedSnapshot) !== JSON.stringify(this.#consultationSignSnapshot(input.context, outpatientCase.case_id, input.encounterId))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Consultation or source snapshot changed; cancel preparation and create a fresh preview')
      }
      if (JSON.stringify(previewDocument) !== JSON.stringify(document)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      const now = this.#context.virtualTime(input.context)
      this.#host.consultationRecording.suspendForSigning(input.context, outpatientCase.case_id)
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'final',
        type: { text: 'Synthetic outpatient structured clinical document' },
        subject: [{ reference: `Patient/${outpatientCase.patient_id}` }],
        encounter: { reference: `Encounter/${input.encounterId}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊结构化病历',
        section: structuredClinicalDocumentSections(document),
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        identifier: {
          system: clinicalDocumentBundleIdentifierSystem,
          value: bundleId,
        },
        timestamp: now,
        entry: this.#documentBundleEntries(input.context, transaction, composition),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Structured Clinical Document signing' },
        agent: provenanceAgents(input.context, 'Author and signer'),
      })
      const documentId = uuidv7()
      this.#context.database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, signed_by, signed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        documentId,
        outpatientCase.case_id,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
      )
      this.#context.database.driver.prepare(`
        UPDATE clinical_document_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      return {
        data: {
          bundleId,
          compositionId,
          compositionVersion: composition.meta?.versionId ?? '1',
          documentId,
          provenanceId,
          revisionNumber: 1,
        },
        effects: [composition, bundle, provenance].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  clinicalExpectedReferences(
    context: ActorContext,
    caseId: string,
    encounterId: string,
    taskId: string | null,
  ): string[] {
    const revisit = this.#context.database.driver.prepare(`
      SELECT content_json FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'revisit'
    `).get(context.workspaceId, context.epoch, caseId) as { content_json: string } | undefined
    const conditionId = revisit === undefined
      ? undefined
      : revisitDraftContentSchema.parse(JSON.parse(revisit.content_json)).conditionId
    const medicationRequestIds = (this.#context.database.driver.prepare(`
      SELECT item.medication_request_id
      FROM prescription_item AS item
      JOIN prescription
        ON prescription.workspace_id = item.workspace_id
       AND prescription.epoch = item.epoch
       AND prescription.prescription_id = item.prescription_id
      WHERE item.workspace_id = ? AND item.epoch = ? AND prescription.case_id = ?
      ORDER BY item.medication_request_id
    `).all(context.workspaceId, context.epoch, caseId) as Array<{
      medication_request_id: string
    }>).map(row => row.medication_request_id)
    return [
      `Encounter/${encounterId}`,
      ...(taskId === null ? [] : [`Task/${taskId}`]),
      ...(typeof conditionId === 'string' ? [`Condition/${conditionId}`] : []),
      ...medicationRequestIds.map(id => `MedicationRequest/${id}`),
    ]
  }

  #documentBundleEntries(
    context: ActorContext,
    transaction: CommandTransaction,
    composition: FhirResource,
    sourceEntries: unknown = [],
  ) {
    const parsedSourceEntries = z.array(documentBundleEntrySchema).safeParse(sourceEntries)
    const sourceResources = new Map((parsedSourceEntries.success ? parsedSourceEntries.data : []).map(entry => [
      `${entry.resource.resourceType}/${entry.resource.id}`,
      entry.resource,
    ]))
    const resources = [composition]
    const visited = new Set([`${composition.resourceType}/${composition.id}`])
    const pendingReferences = localFhirReferences(composition)
    for (let index = 0; index < pendingReferences.length; index += 1) {
      const reference = pendingReferences[index]
      if (reference === undefined || visited.has(reference)) continue
      const [resourceType, resourceId] = reference.split('/')
      if (resourceType === undefined || resourceId === undefined) continue
      const resource = sourceResources.get(reference)
        ?? transaction.fhir.read(context, resourceType, resourceId)
      visited.add(reference)
      resources.push(resource)
      pendingReferences.push(...localFhirReferences(resource))
    }
    return resources.map(resource => ({
      fullUrl: `${fhirCanonicalBase}/${resource.resourceType}/${resource.id}`,
      resource,
    }))
  }

  #signedClinicalDocumentRoot(context: ActorContext, caseId: string) {
    return this.#context.database.driver.prepare(`
      SELECT document_id FROM signed_clinical_document
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND revision_of_document_id IS NULL
    `).get(context.workspaceId, context.epoch, caseId) as { document_id: string } | undefined
  }

  #clinicalDocumentRevisionNumber(context: ActorContext, documentId: string): number {
    const row = this.#context.database.driver.prepare(`
      WITH RECURSIVE document_chain (document_id, revision_of_document_id) AS (
        SELECT document_id, revision_of_document_id
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND document_id = ?
        UNION ALL
        SELECT parent.document_id, parent.revision_of_document_id
        FROM signed_clinical_document AS parent
        JOIN document_chain AS child
          ON child.revision_of_document_id = parent.document_id
        WHERE parent.workspace_id = ? AND parent.epoch = ?
      )
      SELECT COUNT(*) AS count FROM document_chain
    `).get(
      context.workspaceId,
      context.epoch,
      documentId,
      context.workspaceId,
      context.epoch,
    ) as { count: number }
    return row.count
  }

  #clinicalHistoryContext(context: ActorContext, encounterId: string) {
    const clinicalCase = this.#context.caseByEncounter(context, encounterId)
    return readClinicalHistoryContext(this.#context.database, context, clinicalCase.case_id,
      this.#context.fhir.read(context, 'Patient', clinicalCase.patient_id), this.#context.fhir.read(context, 'Encounter', encounterId))
  }

  #assertClinicalHistoryComplete(context: ActorContext, encounterId: string, document: ClinicalDocumentContent) {
    if (this.#clinicalHistoryContext(context, encounterId).requirements.requiredFields.some(field => !(document[field] ?? '').trim())) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '本次专科初诊签署病历前须填写月经史和孕产史。', undefined, 'CLINICAL_HISTORY_REQUIRED')
    }
  }

  structuredClinicalDocuments(context: ActorContext, caseId: string) {
    return this.clinicalDocuments(
      context,
      caseId,
      structuredClinicalDocumentFromComposition,
    )
  }

  completedCaseClinicalDocuments(context: ActorContext, caseId: string) {
    return this.clinicalDocuments(
      context,
      caseId,
      resource => structuredClinicalDocumentFromComposition(resource)
        ?? legacyClinicalDocumentFromComposition(resource),
    ).map(document => ({
      ...document,
      correctionSupported: clinicalDocumentContentSchema.safeParse(document.content).success,
    }))
  }

  clinicalDocuments<Content>(
    context: ActorContext,
    caseId: string,
    contentFromComposition: (resource: FhirResource) => Content | undefined,
  ) {
    const rows = z.array(signedClinicalDocumentRowSchema).parse(
      this.#context.database.driver.prepare(`
        SELECT document_id, composition_id, bundle_id, provenance_id,
          revision_of_document_id, signed_at
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY signed_at, document_id
      `).all(context.workspaceId, context.epoch, caseId),
    )
    const documentsById = new Map<string, { compositionId: string; revisionNumber: number }>()
    return rows.flatMap(row => {
      const composition = this.#context.fhir.read(context, 'Composition', row.composition_id)
      const content = contentFromComposition(composition)
      if (content === undefined) return []
      const provenance = provenanceReasonSchema.parse(
        this.#context.fhir.read(context, 'Provenance', row.provenance_id),
      )
      const revisionReason = provenance.reason?.[0]?.concept.text
      const parent = row.revision_of_document_id === null
        ? undefined
        : documentsById.get(row.revision_of_document_id)
      const revisionNumber = (parent?.revisionNumber ?? 0) + 1
      documentsById.set(row.document_id, {
        compositionId: row.composition_id,
        revisionNumber,
      })
      return [{
        bundleId: row.bundle_id,
        compositionId: row.composition_id,
        compositionVersion: composition.meta?.versionId ?? '1',
        content,
        documentId: row.document_id,
        provenanceId: row.provenance_id,
        revisionNumber,
        ...(parent === undefined ? {} : { revisionOfCompositionId: parent.compositionId }),
        ...(revisionReason === undefined ? {} : { revisionReason }),
        signedAt: row.signed_at,
      }]
    })
  }

  clinicalDocumentConflictStatus(
    context: ActorContext,
    compositionId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const source = clinicalDocumentIdRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT document_id FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND composition_id = ?
      `).get(context.workspaceId, context.epoch, compositionId),
    )
    if (source === undefined) return 'missing'
    return this.#clinicalDocumentHasSuccessor(context, source.document_id)
      ? 'superseded'
      : 'signed'
  }

  #clinicalDocumentHasSuccessor(context: ActorContext, documentId: string): boolean {
    const successor = clinicalDocumentIdRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT document_id FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND revision_of_document_id = ?
      `).get(context.workspaceId, context.epoch, documentId),
    )
    return successor !== undefined
  }
}
