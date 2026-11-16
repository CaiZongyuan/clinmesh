import {
  doctorCaseHistorySchema,
  doctorCompletedHistoryDetailSchema,
  type DoctorCaseHistoryDetail,
  type DoctorCaseHistoryDetailInput,
  type DoctorCaseHistoryInput,
} from '@clinmesh/contracts/agent'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import { inpatientHistoryDetail, inpatientHistoryItems, isInpatientHistoryEntry } from './doctor-inpatient-history.ts'
import { outpatientCaseSource, uniquePatientCaseSource } from './outpatient-case-source.ts'
import {
  billingCaseSchema,
  commandResponseSchema,
  completeHospitalServiceResponseSchema,
  confirmDiagnosisResponseSchema,
  consultationTurnSchema,
  createPatientResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorCompletedCaseDetailSchema,
  doctorCompletedCaseListSchema,
  doctorCompletedCaseTimelineEventSchema,
  doctorQueueItemSchema,
  doctorQueueViewStatusGroups,
  multiChargePaymentPreviewInputSchema,
  multiChargePaymentPreviewResponseSchema,
  multiChargePaymentResponseSchema,
  orderHospitalServiceResponseSchema,
  paymentPreviewResponseSchema,
  paymentRecordedTendersSchema,
  paymentResponseSchema,
  paymentSimulatorRuleSchema,
  paymentTendersSchema,
  registrationResponseSchema,
  registrationStatusSchema,
  serviceCatalogSearchSchema,
  startVisitResponseSchema,
  triageResponseSchema,
  type DiagnosisConfirmation,
  type DiagnosisDraftEntry,
  type DoctorQueueView,
  type PatientSummary,
  type PrescriptionConflictReason,
} from '@clinmesh/contracts/his'
import { getHisOperation } from '@clinmesh/contracts/his-operations'
import {
  patientPersonaRevisionContentSchema,
  scenarioHospitalServiceCatalogItemSchema,
  startSyntheticCaseResultSchema,
  syntheticPatientProfileSchema,
  type PatientPersonaRevision,
  type PatientPersonaRevisionContent,
  type SyntheticCaseInstance,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { allocateRegistrationNumber } from '../infrastructure/sqlite/registration-numbering.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
import { ClinicalDocumentQualityControl } from './clinical-document-quality.ts'
import { readClinicalHistoryContext } from './clinical-history-context.ts'
import { inpatientRequestOwner } from './clinical-request-context.ts'
import { ClinicalRequestKernel } from './clinical-request-kernel.ts'
import {
  CommandExecutor,
  CommandReceiptNotFoundError,
  provenanceAgents,
  type ActorContext,
  type CommandEffect,
  type CommandResponse,
  type CommandTransaction,
} from './command-executor.ts'
import { ConsultationRecordingService } from './consultation-recording-service.ts'
import {
  doctorHistoryEntryAllowed,
  doctorVisibleHistory,
  doctorVisibleHistoryDetail,
  doctorVisibleHistoryDetails,
} from './doctor-case-history.ts'
import { ImagingRequestService } from './imaging-request-service.ts'
import { InsuranceError, InsuranceService, type InsuranceSource, type InsuranceTarget } from './insurance-service.ts'
import { OutpatientClinicalDocumentService } from './outpatient-clinical-document-service.ts'
import { readOutpatientInsuranceSource } from './outpatient-insurance.ts'
import { OutpatientInvestigationBilling } from './outpatient-investigation-billing.ts'
import { OutpatientLaboratoryService } from './outpatient-laboratory-service.ts'
import { OutpatientPrescriptionService } from './outpatient-prescription-service.ts'
import { OutpatientRefunds } from './outpatient-refunds.ts'
import {
  casePresentation,
  confirmedDiagnosisConditionSchema,
  consultationTurnDto,
  consultationTurnRowSchema,
  countRowSchema,
  diagnosisCatalogRowSchema,
  diagnosisStateRowSchema,
  encounterCompletionResourceSchema,
  encounterDiagnosisConditionReference,
  legacyDiagnosisReferenceFromComposition,
  OutpatientWorkflowContext,
  parseStoredFhirResource,
  patientSummary,
  paymentChargeRowSchema,
  paymentPreviewRowSchema,
  signedClinicalDocumentRowSchema,
  storedDiagnosisDraftContentSchema,
  triageRecordContentSchema,
  type CatalogRow,
  type ConsultationTurnDto,
  type DoctorRecommendationsWorkflowPort,
  type InpatientInvestigationsWorkflowPort,
  type InvestigationCapabilityResolver,
} from './outpatient-workflow-context.ts'
import { paymentChannelPlan } from './payment-channel.ts'
import { PaymentCollection } from './payment-collection.ts'
import { PaymentLedger } from './payment-ledger.ts'
import { PathologyRequestService } from './pathology-request-service.ts'
import type { ReferenceDataService } from './reference-data-service.ts'
import { WorkflowError } from './workflow-error.ts'

export { laboratoryServiceCodings } from './outpatient-laboratory-service.ts'
export { WorkflowError } from './workflow-error.ts'

const serviceCatalogConfigSchema = scenarioHospitalServiceCatalogItemSchema.omit({
  active: true,
  code: true,
  id: true,
  name: true,
  organizationId: true,
  priceFen: true,
  status: true,
}).passthrough()

const syntheticCaseReplayRowSchema = z.object({
  brief_content_json: z.string().min(1),
  brief_revision: z.number().int().positive(),
  case_id: z.string().min(1),
  case_revision: z.number().int().positive(),
  demographics_json: z.string().min(1),
  department_id: z.string().min(1),
  identity_json: z.string().min(1),
  location_id: z.string().min(1),
  profile_id: z.string().min(1),
  profile_revision: z.number().int().positive(),
  visit_type_id: z.string().min(1),
}).strict()

const appendConsultationTurnResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  consultationVersion: z.number().int().positive(),
  turn: consultationTurnSchema,
}).strict())

const draftDeletionTraceRowSchema = z.object({
  effect_json: z.string(),
  operation: z.enum([
    'encounter.delete-prescription-draft',
    'imaging-request.delete-draft',
    'laboratory-request.delete-draft',
    'pathology-request.delete-draft',
  ]),
  trace_id: z.string().min(1),
  virtual_timestamp: z.iso.datetime({ offset: true }),
}).strict()

const actionTraceEffectSchema = z.object({
  kind: z.enum(['created', 'updated']),
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]+$/),
  versionId: z.string().regex(/^\d+$/),
}).strict()

const priorConditionSchema = z.object({
  clinicalStatus: z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose().optional(),
  code: z.object({
    coding: z.array(z.object({
      code: z.string().optional(),
      display: z.string().optional(),
    }).loose()).optional(),
    text: z.string().optional(),
  }).loose().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  recordedDate: z.string().optional(),
}).loose()

const completedCaseListRowSchema = z.object({
  case_id: z.string().min(1),
  encounter_json: z.string().min(1),
  patient_json: z.string().min(1),
}).strict()

const completedCaseDetailRowSchema = completedCaseListRowSchema.omit({ case_id: true }).strict()


const completedCaseSelectionSql = `
  FROM outpatient_case
  JOIN outpatient_case_responsibility AS responsibility
    ON responsibility.workspace_id = outpatient_case.workspace_id
   AND responsibility.epoch = outpatient_case.epoch
   AND responsibility.case_id = outpatient_case.case_id
  JOIN fhir_resource AS patient
    ON patient.workspace_id = outpatient_case.workspace_id
   AND patient.epoch = outpatient_case.epoch
   AND patient.resource_type = 'Patient'
   AND patient.resource_id = outpatient_case.patient_id
  JOIN fhir_resource AS encounter
    ON encounter.workspace_id = outpatient_case.workspace_id
   AND encounter.epoch = outpatient_case.epoch
   AND encounter.resource_type = 'Encounter'
   AND encounter.resource_id = outpatient_case.encounter_id
  WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
    AND responsibility.practitioner_role_id = ?
    AND patient.deleted = 0 AND encounter.deleted = 0
    AND json_extract(encounter.content_json, '$.status') = 'completed'
    AND json_extract(encounter.content_json, '$.actualPeriod.end') IS NOT NULL
    AND (? IS NULL OR outpatient_case.patient_id = ?)
    AND (
      ? IS NULL
      OR substr(json_extract(encounter.content_json, '$.actualPeriod.end'), 1, 10) >= ?
    )
    AND (
      ? IS NULL
      OR substr(json_extract(encounter.content_json, '$.actualPeriod.end'), 1, 10) <= ?
    )
    AND (
      ? IS NULL
      OR EXISTS (
        SELECT 1
        FROM diagnosis_confirmation
        JOIN diagnosis_entry
          ON diagnosis_entry.workspace_id = diagnosis_confirmation.workspace_id
         AND diagnosis_entry.epoch = diagnosis_confirmation.epoch
         AND diagnosis_entry.confirmation_id = diagnosis_confirmation.confirmation_id
        WHERE diagnosis_confirmation.workspace_id = outpatient_case.workspace_id
          AND diagnosis_confirmation.epoch = outpatient_case.epoch
          AND diagnosis_confirmation.case_id = outpatient_case.case_id
          AND diagnosis_confirmation.revision_number = (
            SELECT MAX(current_confirmation.revision_number)
            FROM diagnosis_confirmation AS current_confirmation
            WHERE current_confirmation.workspace_id = diagnosis_confirmation.workspace_id
              AND current_confirmation.epoch = diagnosis_confirmation.epoch
              AND current_confirmation.case_id = diagnosis_confirmation.case_id
          )
          AND diagnosis_entry.catalog_item_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM signed_clinical_document AS legacy_document
        JOIN fhir_resource AS legacy_composition
          ON legacy_composition.workspace_id = legacy_document.workspace_id
         AND legacy_composition.epoch = legacy_document.epoch
         AND legacy_composition.resource_type = 'Composition'
         AND legacy_composition.resource_id = legacy_document.composition_id
        JOIN diagnosis_catalog AS legacy_catalog
          ON legacy_catalog.workspace_id = legacy_document.workspace_id
         AND legacy_catalog.epoch = legacy_document.epoch
         AND legacy_catalog.item_id = ?
        JOIN fhir_resource AS legacy_condition
          ON legacy_condition.workspace_id = legacy_document.workspace_id
         AND legacy_condition.epoch = legacy_document.epoch
         AND legacy_condition.resource_type = 'Condition'
         AND legacy_condition.resource_id = substr(
           (
             SELECT json_extract(legacy_entry.value, '$.reference')
             FROM json_each(legacy_composition.content_json, '$.section') AS legacy_section
             JOIN json_each(legacy_section.value, '$.entry') AS legacy_entry
             WHERE json_extract(legacy_section.value, '$.title') = '诊断'
               AND json_extract(legacy_entry.value, '$.reference') LIKE 'Condition/%'
             LIMIT 1
           ),
           length('Condition/') + 1
         )
        WHERE legacy_document.workspace_id = outpatient_case.workspace_id
          AND legacy_document.epoch = outpatient_case.epoch
          AND legacy_document.case_id = outpatient_case.case_id
          AND json_extract(legacy_condition.content_json, '$.code.coding[0].system')
            = legacy_catalog.code_system
          AND json_extract(legacy_condition.content_json, '$.code.coding[0].code')
            = legacy_catalog.code
      )
    )
`

export class WorkflowService
  implements DoctorRecommendationsWorkflowPort, InpatientInvestigationsWorkflowPort {
  readonly refunds: OutpatientRefunds
  readonly #commands: CommandExecutor
  readonly #context: OutpatientWorkflowContext
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #now: () => Date
  readonly insurance: InsuranceService
  readonly #payments: PaymentLedger
  readonly #collections: PaymentCollection
  readonly #outpatientBilling: OutpatientInvestigationBilling
  readonly #requests: ClinicalRequestKernel

  readonly #prescriptions: OutpatientPrescriptionService
  readonly #laboratory: OutpatientLaboratoryService
  readonly #clinicalDocuments: OutpatientClinicalDocumentService
  /** 放射申请适配器；与检验共用申请内核。 */
  readonly imaging: ImagingRequestService
  /** 病理会诊申请适配器；与检验、放射共用申请内核。 */
  readonly pathology: PathologyRequestService
  readonly consultationRecording: ConsultationRecordingService
  readonly qualityControl: ClinicalDocumentQualityControl

  constructor(
    database: ClinMeshDatabase,
    fhir: FhirRepository,
    commands: CommandExecutor,
    options: {
      consultationRecordingEnabled?: boolean
      qualityModelAvailable?: boolean
      qualityContextStatus?: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
      consultationRecordingContextStatus?: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
      investigation?: InvestigationCapabilityResolver
      now?: () => Date
      referenceData?: ReferenceDataService
      tokenSecret: string
      readInpatientInsuranceSource?: (context: ActorContext, target: InsuranceTarget) => InsuranceSource
      onInpatientInsuranceAllocationChanged?: (context: ActorContext, source: InsuranceSource, transaction: CommandTransaction, effects: CommandEffect[]) => void
      assertInpatientInsuranceChangeAllowed?: (context: ActorContext, source: InsuranceSource, action: 'settle' | 'cancel') => void
    },
  ) {
    this.#commands = commands
    this.#database = database
    this.#fhir = fhir
    this.#now = options.now ?? (() => new Date())
    this.#payments = new PaymentLedger(database)
    this.#collections = new PaymentCollection(database)
    this.#outpatientBilling = new OutpatientInvestigationBilling(database)
    this.#requests = new ClinicalRequestKernel(database)
    this.#context = new OutpatientWorkflowContext({
      commands,
      database,
      fhir,
      ...(options.investigation === undefined ? {} : { investigation: options.investigation }),
      now: this.#now,
      outpatientBilling: this.#outpatientBilling,
      payments: this.#payments,
      ...(options.referenceData === undefined ? {} : { referenceData: options.referenceData }),
      requests: this.#requests,
      tokenSecret: options.tokenSecret,
    })
    this.insurance = new InsuranceService(database, commands, {
      now: this.#now,
      readSource: (context, target) => {
        if (target.kind === 'outpatient') return readOutpatientInsuranceSource(database, context, target)
        if (options.readInpatientInsuranceSource === undefined) throw new InsuranceError('INSURANCE_SOURCE_UNAVAILABLE', '住院医保入口尚未启用')
        return options.readInpatientInsuranceSource(context, target)
      },
      assertChangeAllowed: (context, source, action) => {
        if (source.target.kind === 'inpatient') {
          options.assertInpatientInsuranceChangeAllowed?.(context, source, action)
          return
        }
        for (const charge of source.charges) {
          const row = z.object({ status: z.string(), category: z.string() }).parse(
            database.driver.prepare(
              'SELECT status,category FROM charge_record WHERE workspace_id=? AND epoch=? AND charge_item_id=?',
            ).get(context.workspaceId, context.epoch, charge.reference.slice(11)),
          )
          if (action === 'settle' && row.category === 'medication' && fhir.read(context, 'Encounter', source.encounterId).status !== 'completed') {
            throw new InsuranceError('INSURANCE_FUNDS_CONFLICT', '处方须完诊后再预览或确认医保待遇')
          }
          const balance = this.#payments.balance(context, charge.reference.slice(11))
          if (balance.unresolved > 0 || (action === 'settle' && (row.status === 'paid' || balance.paidFen > 0))) {
            throw new InsuranceError('INSURANCE_FUNDS_CONFLICT', '请先查明原收款或退款结果；已收款费用新增待遇须通过财务更正处理')
          }
        }
      },
      onAllocationChanged: (context, source, transaction, effects) => {
        if (source.target.kind === 'inpatient') {
          options.onInpatientInsuranceAllocationChanged?.(context, source, transaction, effects)
          return
        }
        for (const charge of source.charges) {
          if (charge.coverage.included === false) continue
          const facts = z.object({
            charge_id: z.string(),
            charge_item_id: z.string(),
            current_amount_fen: z.number(),
            charge_version: z.number(),
            category: z.enum(['laboratory', 'medication']),
            case_id: z.string(),
            case_status: paymentPreviewRowSchema.shape.case_status,
            patient_id: z.string(),
            encounter_id: z.string(),
            prescription_id: z.string().nullable(),
            service_request_id: z.string().nullable(),
          }).parse(database.driver.prepare(`
            SELECT c.charge_id,c.charge_item_id,c.total_fen - COALESCE((
              SELECT SUM(adjustment.amount_fen) FROM financial_charge_adjustment adjustment
              WHERE adjustment.workspace_id=c.workspace_id AND adjustment.epoch=c.epoch
                AND adjustment.charge_item_id=c.charge_item_id
            ),0) AS current_amount_fen,c.version AS charge_version,c.category,o.case_id,o.status AS case_status,
              o.patient_id,o.encounter_id,o.prescription_id,o.service_request_id
            FROM charge_record c JOIN outpatient_case o USING(workspace_id,epoch,case_id)
            WHERE c.workspace_id=? AND c.epoch=? AND c.charge_item_id=?
          `).get(context.workspaceId, context.epoch, charge.reference.slice(11)))
          this.#applyPaymentOutcome(transaction, context, facts, 'success', effects)
        }
      },
    })
    this.refunds = new OutpatientRefunds(database, fhir, commands, {
      now: this.#now,
      virtualTime: context => this.#context.virtualTime(context),
      tokenSecret: options.tokenSecret,
      onFundsChanged: context => this.#completeScenarioIfReady(context, this.#context.virtualTime(context)).effects,
    })
    this.qualityControl = new ClinicalDocumentQualityControl({
      database,
      commands,
      modelAvailable: options.qualityModelAvailable === true,
      contextStatus: options.qualityContextStatus ?? (() => 'active'),
      readCase: (context, caseId) => {
        this.#context.assertCaseResponsibility(context, caseId)
        return doctorCaseDetailSchema.parse(this.#doctorCaseSnapshot(context, caseId))
      },
      automaticFacts: (context, caseId) => this.consultationRecording.qualityFacts(context, caseId),
    })
    this.consultationRecording = new ConsultationRecordingService({
      database,
      commands,
      enabled: options.consultationRecordingEnabled === true,
      now: this.#now,
      virtualTime: context => this.#context.virtualTime(context),
      contextStatus: options.consultationRecordingContextStatus ?? (() => 'inactive'),
      prepareReports: (context, transaction, caseId) => this.#prepareRecordingReports(transaction, context, caseId),
      qualityChanged: (context, transaction, caseId) => this.qualityControl.enqueue(context, transaction, caseId),
      trackQualityDraft: (context, caseId, before, after) => this.qualityControl.trackDraft(context, caseId, before, after, false),
      assertAccess: (context, encounterId) => {
        this.#context.assertRole(context, ['outpatient-doctor'])
        const outpatientCase = this.#context.caseByEncounter(context, encounterId)
        this.#context.assertCaseResponsibility(context, outpatientCase.case_id)
        const encounter = this.#fhir.read(context, 'Encounter', encounterId)
        return {
          caseId: outpatientCase.case_id,
          editable: encounter.status === 'in-progress'
            && outpatientCase.status !== 'completed'
            && !this.#clinicalDocuments.hasSignedRoot(context, outpatientCase.case_id),
        }
      },
    })
    const requestHost = {
      assertCaseResponsibility: (context: ActorContext, caseId: string) => this.#context.assertCaseResponsibility(context, caseId),
      assertExpectedVersions: (expectedVersions: Record<string, string>, references: string[]) => (
        this.#context.assertExpectedVersions(expectedVersions, references)
      ),
      caseByEncounter: (context: ActorContext, encounterId: string) => this.#context.caseByEncounter(context, encounterId),
      hasConsultation: (context: ActorContext, caseId: string) => this.#context.hasConsultation(context, caseId),
      reportPublished: (transaction: CommandTransaction, context: ActorContext, caseId: string, reportReference: string) =>
        this.#recordPublishedReport(transaction, context, caseId, reportReference),
      virtualTime: (context: ActorContext) => this.#context.virtualTime(context),
    }
    this.imaging = new ImagingRequestService({ commands, database, fhir, host: requestHost, requests: this.#requests })
    this.pathology = new PathologyRequestService({ commands, database, fhir, host: requestHost, requests: this.#requests })
    this.#prescriptions = new OutpatientPrescriptionService({
      context: this.#context,
      host: {
        completeScenarioIfReady: (context, now) => (
          this.#completeScenarioIfReady(context, now ?? this.#context.virtualTime(context))
        ),
      },
    })
    this.#laboratory = new OutpatientLaboratoryService({
      context: this.#context,
      host: {
        reportPublished: (transaction, context, caseId, reportReference, reportName) => (
          this.#appendReportCardTurn(transaction, context, caseId, { reportName, reportReference })
        ),
      },
    })
    this.#clinicalDocuments = new OutpatientClinicalDocumentService({
      context: this.#context,
      host: {
        consultationRecording: this.consultationRecording,
        qualityControl: this.qualityControl,
        assertMedicationAllergies: (context, patientId, medications) => (
          this.#prescriptions.assertMedicationAllergies(context, patientId, medications)
        ),
        assertMedicationCatalogRules: medications => (
          this.#prescriptions.assertMedicationCatalogRules(medications)
        ),
        openRequestStatuses: (context, caseId) => this.#requests.openRequestStatuses(context, caseId),
        pendingInvestigationDraftTarget: (context, caseId) => {
          if (this.#laboratory.hasDraft(context, caseId)) return 'laboratory'
          if (this.imaging.hasDraft(context, caseId)) return 'imaging'
          if (this.pathology.hasDraft(context, caseId)) return 'pathology'
          return undefined
        },
        medicationCompletionStatus: (context, caseId) => (
          this.#prescriptions.medicationCompletionStatus(context, caseId)
        ),
      },
    })
  }

  commandReceipt(context: ActorContext, operationId: string, idempotencyKey: string) {
    const operation = getHisOperation(operationId)
    try {
      const receipt = this.#commands.readReceipt(context, operation.commandOperation ?? operation.id, idempotencyKey)
      return { ...receipt, operationId }
    } catch (error) {
      if (!(error instanceof CommandReceiptNotFoundError)) throw error
      const accepted = operationId === 'encounter.consultation.ask'
        ? this.#commands.readReceipt(context, 'consultation.doctor-turn.append', `${idempotencyKey}:doctor-turn`)
        : operationId === 'encounter.consultation.reply.retry'
          ? this.#commands.readReceipt(context, 'consultation.reply.accept', idempotencyKey)
          : undefined
      if (accepted === undefined) throw error
      return { ...accepted, idempotencyKey, operationId, status: 'executing' as const }
    }
  }

  registrationCatalog(context: ActorContext) {
    this.#context.assertRole(context, ['administrator', 'registrar'])
    const rows = this.#database.driver.prepare(`
      SELECT item_id, name_zh, name_en, price_fen, version, kind
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND kind IN ('department', 'visit-type') AND active = 1
        AND (
          kind <> 'department'
          OR coalesce(json_extract(config_json, '$.registrationAvailable'), 1) = 1
        )
      ORDER BY kind, item_id
    `).all(context.workspaceId, context.epoch) as Array<CatalogRow & { kind: string }>
    const virtualTime = this.#context.virtualTime(context)
    const locations = this.#fhir.search(
      context,
      'Location',
      new URLSearchParams({ _count: '100' }),
    ).resources.filter(location => this.#isRegistrationLocation(location))
    return {
      departments: rows.filter(row => row.kind === 'department').map(row => ({
        id: row.item_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        version: row.version,
      })),
      locations: locations.map(location => ({
        id: location.id,
        nameEn: Array.isArray(location.alias) && typeof location.alias[0] === 'string'
          ? location.alias[0]
          : String(location.name ?? ''),
        nameZh: String(location.name ?? ''),
        version: Number(location.meta?.versionId ?? '1'),
      })),
      virtualDate: virtualTime.slice(0, 10),
      visitTypes: rows.filter(row => row.kind === 'visit-type').map(row => ({
        id: row.item_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        priceFen: row.price_fen,
        version: row.version,
      })),
    }
  }


  clinicalCatalog(context: ActorContext) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const rows = this.#database.driver.prepare(`
      SELECT item_id, name_zh, name_en, price_fen, version, kind, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND kind IN ('laboratory', 'medication') AND active = 1
      ORDER BY kind, item_id
    `).all(context.workspaceId, context.epoch) as Array<
      CatalogRow & { config_json: string; kind: 'laboratory' | 'medication' }
    >
    const diagnoses = z.array(diagnosisCatalogRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT item_id, code_system, code, name_zh, name_en, version
        FROM diagnosis_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
        ORDER BY item_id
      `).all(context.workspaceId, context.epoch),
    )
    const medicationSlice = this.#prescriptions.catalogSlice(
      context,
      rows.filter(row => row.kind === 'medication'),
    )
    return {
      diagnoses: diagnoses.map(diagnosis => ({
        code: diagnosis.code,
        id: diagnosis.item_id,
        nameEn: diagnosis.name_en,
        nameZh: diagnosis.name_zh,
        system: diagnosis.code_system,
        version: diagnosis.version,
      })),
      laboratory: this.#laboratory.catalogItems(
        context,
        rows.filter(row => row.kind === 'laboratory'),
      ),
      ...medicationSlice,
    }
  }

  serviceCatalog(context: ActorContext, input: {
    page: number
    pageSize: number
    query?: string
  }) {
    this.#context.assertRole(context, ['administrator', 'outpatient-doctor'])
    const query = input.query ?? null
    const bindings = [
      context.workspaceId,
      context.epoch,
      query,
      query,
      query,
      query,
    ]
    const total = z.object({ count: z.number().int().nonnegative() }).parse(
      this.#database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM hospital_service_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
          AND json_type(config_json, '$.imagingService') IS NULL
          AND json_type(config_json, '$.pathologyService') IS NULL
          AND (
            ? IS NULL
            OR instr(lower(code), lower(?)) > 0
            OR instr(lower(name_zh), lower(?)) > 0
            OR instr(lower(name_en), lower(?)) > 0
          )
      `).get(...bindings),
    ).count
    const rows = this.#database.driver.prepare(`
      SELECT service_id, code, name_zh, name_en, version, config_json
      FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND active = 1
        AND json_type(config_json, '$.imagingService') IS NULL
          AND json_type(config_json, '$.pathologyService') IS NULL
        AND (
          ? IS NULL
          OR instr(lower(code), lower(?)) > 0
          OR instr(lower(name_zh), lower(?)) > 0
          OR instr(lower(name_en), lower(?)) > 0
        )
      ORDER BY service_id
      LIMIT ? OFFSET ?
    `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize) as Array<{
      code: string
      config_json: string
      service_id: string
      name_en: string
      name_zh: string
      version: number
    }>
    return serviceCatalogSearchSchema.parse({
      items: rows.map(row => ({
        ...serviceCatalogConfigSchema.strip().parse(JSON.parse(row.config_json) as unknown),
        code: row.code,
        id: row.service_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        version: row.version,
      })),
      page: input.page,
      pageSize: input.pageSize,
      total,
    })
  }

  orderHospitalService(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    serviceId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: orderHospitalServiceResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, serviceId: input.serviceId },
      operation: 'hospital-service.order',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot order a Hospital Service')
      }
      const service = z.object({
        code: z.string(),
        config_json: z.string(),
        name_zh: z.string(),
        service_id: z.string(),
      }).optional().parse(this.#database.driver.prepare(`
        SELECT service_id, code, name_zh, config_json
        FROM hospital_service_catalog
        WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND active = 1
          AND json_type(config_json, '$.imagingService') IS NULL
          AND json_type(config_json, '$.pathologyService') IS NULL
      `).get(input.context.workspaceId, input.context.epoch, input.serviceId))
      if (service === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The Hospital Service is unavailable')
      const config = serviceCatalogConfigSchema.parse(JSON.parse(service.config_json) as unknown)
      if (!config.availableScopes.includes('outpatient')) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The Hospital Service is unavailable for outpatient care')
      }
      const serviceRequestId = uuidv7()
      const taskId = `task-hospital-service-${serviceRequestId}`
      const chargeItemId = `charge-hospital-service-${serviceRequestId}`
      const now = this.#context.virtualTime(input.context)
      const serviceRequest = transaction.fhir.create(input.context, {
        resourceType: 'ServiceRequest',
        id: serviceRequestId,
        status: 'active',
        intent: 'order',
        code: {
          concept: {
            coding: [{
              code: service.code,
              display: service.name_zh,
              system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/hospital-service',
            }, {
              code: config.nationalService.code,
              display: config.nationalService.display,
              system: config.nationalService.system,
              version: config.nationalService.version,
            }],
            text: service.name_zh,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        performer: [{ reference: 'Organization/organization-clinmesh' }],
      })
      const task = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: taskId,
        status: 'requested',
        intent: 'order',
        code: { text: `${service.name_zh}执行` },
        focus: { reference: `ServiceRequest/${serviceRequestId}` },
        for: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        owner: { reference: 'Organization/organization-clinmesh' },
      })
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/sid/charge-definition',
          value: config.chargeDefinition.id,
        }],
        code: { text: service.name_zh },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        account: [{ reference: `Account/${outpatientCase.account_id}` }],
        occurrenceDateTime: now,
        quantity: { value: 1 },
        unitPriceComponent: {
          amount: {
            currency: config.chargeDefinition.currency,
            value: config.chargeDefinition.priceFen / 100,
          },
        },
      })
      return {
        data: {
          chargeDefinitionId: config.chargeDefinition.id,
          chargeItemId,
          hospitalServiceId: service.service_id,
          nationalServiceId: config.nationalService.id,
          serviceRequestId,
          serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
          status: 'requested' as const,
          taskId,
          taskVersion: task.meta?.versionId ?? '1',
          totalFen: config.chargeDefinition.priceFen,
        },
        effects: [serviceRequest, task, chargeItem].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  completeHospitalService(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    serviceRequestId: string
  }) {
    const taskId = `task-hospital-service-${input.serviceRequestId}`
    const chargeItemId = `charge-hospital-service-${input.serviceRequestId}`
    return this.#commands.execute({
      context: input.context,
      dataSchema: completeHospitalServiceResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { serviceRequestId: input.serviceRequestId },
      operation: 'hospital-service.complete',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `ServiceRequest/${input.serviceRequestId}`,
        `Task/${taskId}`,
      ])
      const serviceRequest = transaction.fhir.read(
        input.context,
        'ServiceRequest',
        input.serviceRequestId,
      )
      const task = transaction.fhir.read(input.context, 'Task', taskId)
      const encounterReference = z.object({
        encounter: z.object({ reference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/) }),
      }).passthrough().parse(serviceRequest).encounter.reference
      const outpatientCase = this.#context.caseByEncounter(
        input.context,
        encounterReference.slice('Encounter/'.length),
      )
      this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      if (serviceRequest.status !== 'active' || task.status !== 'requested') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Hospital Service is not awaiting execution')
      }
      const now = this.#context.virtualTime(input.context)
      const completedRequest = transaction.fhir.update(input.context, {
        ...serviceRequest,
        status: 'completed',
      }, serviceRequest.meta?.versionId ?? '1')
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        executionPeriod: { end: now },
      }, task.meta?.versionId ?? '1')
      return {
        data: {
          chargeItemId,
          serviceRequestId: input.serviceRequestId,
          serviceRequestVersion: completedRequest.meta?.versionId ?? '2',
          status: 'completed' as const,
          taskId,
          taskVersion: completedTask.meta?.versionId ?? '2',
        },
        effects: [completedRequest, completedTask].map(resource => ({
          kind: 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '2',
        })),
      }
    })
  }

  registrationQueue(context: ActorContext, pageSize: number, page = 1) {
    this.#context.assertRole(context, ['registrar'])
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ?
    `).get(context.workspaceId, context.epoch) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.encounter_id,
        outpatient_case.status, outpatient_case.initial_task_id,
        outpatient_case.arrived_at, registration.registration_id,
        registration.registration_number, registration.status AS registration_status,
        patient.content_json AS patient_json,
        encounter.version_id AS encounter_version, task.version_id AS task_version
      FROM outpatient_case
      JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.initial_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
      ORDER BY outpatient_case.arrived_at DESC, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(context.workspaceId, context.epoch, pageSize, (page - 1) * pageSize) as Array<{
      arrived_at: string
      case_id: string
      encounter_id: string
      encounter_version: number
      patient_json: string
      registration_id: string
      registration_number: string
      registration_status: string
      status: string
      task_version: number
      initial_task_id: string
    }>
    return {
      items: rows.map(row => ({
        arrivedAt: row.arrived_at,
        caseId: row.case_id,
        encounterId: row.encounter_id,
        encounterVersion: String(row.encounter_version),
        patient: patientSummary(parseStoredFhirResource(row.patient_json)),
        registrationId: row.registration_id,
        registrationNumber: row.registration_number,
        registrationStatus: registrationStatusSchema.parse(row.registration_status),
        status: row.status,
        taskId: row.initial_task_id,
        taskVersion: String(row.task_version),
      })),
      page,
      pageSize,
      total: total.count,
    }
  }

  createPatient(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    patient: {
      birthDate: string
      gender: 'female' | 'male' | 'other' | 'unknown'
      identifier: string
      name: string
    }
  }): CommandResponse<{ patient: PatientSummary }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: createPatientResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: input.patient,
      operation: 'patient.create-synthetic',
    }, transaction => {
      this.#context.assertRole(input.context, ['registrar'])
      const duplicate = this.#database.driver.prepare(`
        SELECT 1 AS present
        FROM fhir_sp_string
        WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
          AND param = 'identifier' AND exact_value = ?
      `).get(input.context.workspaceId, input.context.epoch, input.patient.identifier)
      if (duplicate !== undefined) {
        throw new WorkflowError('DUPLICATE_PATIENT', 'The synthetic patient identifier already exists')
      }
      const patient = transaction.fhir.create(input.context, {
        resourceType: 'Patient',
        id: uuidv7(),
        extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
          valueBoolean: true,
        }],
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/synthetic-patient-id',
          value: input.patient.identifier,
        }],
        name: [{ text: input.patient.name }],
        gender: input.patient.gender,
        birthDate: input.patient.birthDate,
        active: true,
      })
      return {
        data: { patient: patientSummary(patient) },
        effects: [{
          kind: 'created',
          reference: `Patient/${patient.id}`,
          versionId: patient.meta?.versionId ?? '1',
        }],
      }
    })
  }

  searchPatients(input: {
    context: ActorContext
    page: number
    pageSize: number
    query: string
  }): { items: PatientSummary[]; page: number; pageSize: number; total: number } {
    this.#context.assertRole(input.context, ['registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist'])
    const normalized = input.query.normalize('NFKC').toLocaleLowerCase()
    const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    const bindings = [input.context.workspaceId, input.context.epoch, `${escaped}%`, `${escaped}%`]
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM fhir_resource AS resource
      WHERE resource.workspace_id = ? AND resource.epoch = ?
        AND resource.resource_type = 'Patient' AND resource.deleted = 0
        AND (
          EXISTS (
            SELECT 1 FROM fhir_sp_string AS lookup
            WHERE lookup.workspace_id = resource.workspace_id
              AND lookup.epoch = resource.epoch
              AND lookup.resource_type = resource.resource_type
              AND lookup.resource_id = resource.resource_id
              AND lookup.param IN ('name', 'identifier')
              AND lookup.normalized LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM registration
            WHERE registration.workspace_id = resource.workspace_id
              AND registration.epoch = resource.epoch
              AND registration.patient_id = resource.resource_id
              AND LOWER(registration.registration_number) LIKE ? ESCAPE '\\'
          )
        )
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT resource.content_json
      FROM fhir_resource AS resource
      WHERE resource.workspace_id = ? AND resource.epoch = ?
        AND resource.resource_type = 'Patient' AND resource.deleted = 0
        AND (
          EXISTS (
            SELECT 1 FROM fhir_sp_string AS lookup
            WHERE lookup.workspace_id = resource.workspace_id
              AND lookup.epoch = resource.epoch
              AND lookup.resource_type = resource.resource_type
              AND lookup.resource_id = resource.resource_id
              AND lookup.param IN ('name', 'identifier')
              AND lookup.normalized LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM registration
            WHERE registration.workspace_id = resource.workspace_id
              AND registration.epoch = resource.epoch
              AND registration.patient_id = resource.resource_id
              AND LOWER(registration.registration_number) LIKE ? ESCAPE '\\'
          )
        )
      ORDER BY resource.last_updated DESC, resource.resource_id
      LIMIT ? OFFSET ?
    `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize) as Array<{
      content_json: string
    }>
    return {
      items: rows.map(row => patientSummary(parseStoredFhirResource(row.content_json))),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }

  register(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    registration: {
      departmentId: string
      locationId: string
      patientId: string
      visitDate: string
      visitTypeId: string
    }
  }): CommandResponse<{
    accountId: string
    chargeItemId: string
    encounterId: string
    patientId: string
    queueTaskId: string
    registrationId: string
    status: 'awaiting-triage'
    totalFen: number
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: registrationResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: input.registration,
      operation: 'registration.register',
    }, transaction => {
      this.#context.assertRole(input.context, ['registrar'])
      this.#context.assertExpectedVersions(input.expectedVersions, [`Patient/${input.registration.patientId}`])
      return this.#registerPatient(transaction, input.context, input.registration)
    })
  }

  replaySyntheticCases(input: {
    fromContext: ActorContext
    toContext: ActorContext
    transaction: CommandTransaction
  }): void {
    this.#context.assertRole(input.fromContext, ['administrator'])
    const rows = z.array(syntheticCaseReplayRowSchema).parse(this.#database.driver.prepare(`
      SELECT
        materialization.case_id,
        materialization.case_revision,
        materialization.profile_id,
        materialization.profile_revision,
        materialization.brief_revision,
        brief.content_json AS brief_content_json,
        profile.identity_json,
        profile.demographics_json,
        outpatient.department_id,
        outpatient.location_id,
        registration.visit_type_id
      FROM synthetic_case_materialization AS materialization
      JOIN synthetic_patient_profile_revision AS profile
        ON profile.workspace_id = materialization.workspace_id
       AND profile.profile_id = materialization.profile_id
       AND profile.revision = materialization.profile_revision
      JOIN patient_persona_revision AS brief
        ON brief.workspace_id = materialization.workspace_id
       AND brief.case_id = materialization.case_id
       AND brief.revision = materialization.brief_revision
      JOIN outpatient_case AS outpatient
        ON outpatient.workspace_id = materialization.workspace_id
       AND outpatient.epoch = materialization.epoch
       AND outpatient.case_id = materialization.outpatient_case_id
      JOIN registration
        ON registration.workspace_id = materialization.workspace_id
       AND registration.epoch = materialization.epoch
       AND registration.registration_id = materialization.registration_id
      WHERE materialization.workspace_id = ? AND materialization.epoch = ?
      ORDER BY materialization.created_at, materialization.case_id
    `).all(input.fromContext.workspaceId, input.fromContext.epoch))

    for (const row of rows) {
      this.#materializeSyntheticCaseVisit({
        brief: {
          content: patientPersonaRevisionContentSchema.parse(JSON.parse(row.brief_content_json) as unknown),
          revision: row.brief_revision,
        },
        caseId: row.case_id,
        caseRevision: row.case_revision,
        context: input.toContext,
        departmentId: row.department_id,
        locationId: row.location_id,
        profile: {
          demographics: syntheticPatientProfileSchema.shape.demographics.parse(
            JSON.parse(row.demographics_json),
          ),
          identity: syntheticPatientProfileSchema.shape.identity.parse(JSON.parse(row.identity_json)),
          profileId: row.profile_id,
          revision: row.profile_revision,
        },
        transaction: input.transaction,
        visitDate: this.#context.virtualTime(input.toContext).slice(0, 10),
        visitTypeId: row.visit_type_id,
      })
    }
  }

  startSyntheticCase(input: {
    brief: PatientPersonaRevision
    context: ActorContext
    departmentId: string
    expectedCaseRevision: number
    idempotencyKey: string
    locationId: string
    profile: SyntheticPatientProfile
    syntheticCase: SyntheticCaseInstance
    visitDate: string
    visitTypeId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: startSyntheticCaseResultSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        activeBriefRevision: input.brief.revision,
        departmentId: input.departmentId,
        expectedCaseRevision: input.expectedCaseRevision,
        locationId: input.locationId,
        syntheticCaseId: input.syntheticCase.caseId,
        visitDate: input.visitDate,
        visitTypeId: input.visitTypeId,
      },
      operation: 'synthetic-case.start-outpatient-visit',
    }, transaction => this.applyStartSyntheticCase(transaction, input, () => {
      const materialized = this.#materializeSyntheticCaseVisit({
        brief: input.brief,
        caseId: input.syntheticCase.caseId,
        caseRevision: input.expectedCaseRevision,
        context: input.context,
        departmentId: input.departmentId,
        locationId: input.locationId,
        profile: input.profile,
        transaction,
        visitDate: input.visitDate,
        visitTypeId: input.visitTypeId,
      })
      return {
        data: {
          encounterId: materialized.data.encounterId,
          outpatientCaseId: materialized.data.outpatientCaseId,
          patientId: materialized.data.patientId,
          queueTaskId: materialized.data.queueTaskId,
          registrationId: materialized.data.registrationId,
          status: 'awaiting-triage' as const,
          syntheticCaseId: input.syntheticCase.caseId,
        },
        effects: materialized.effects,
      }
    }))
  }

  applyStartSyntheticCase<Data>(transaction: CommandTransaction, input: {
    brief: PatientPersonaRevision
    context: ActorContext
    expectedCaseRevision: number
    profile: SyntheticPatientProfile
    syntheticCase: SyntheticCaseInstance
  }, materialize: (transaction: CommandTransaction) => { data: Data; effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> }) {

      this.#context.assertRole(input.context, ['administrator', 'registrar'])
      const current = z.object({
        active_brief_revision: z.number().int().positive().nullable(),
        profile_id: z.string().min(1),
        profile_revision: z.number().int().positive(),
        revision: z.number().int().positive(),
        status: z.enum(['brief-pending', 'brief-ready', 'started', 'completed', 'retired']),
      }).strict().optional().parse(this.#database.driver.prepare(`
        SELECT profile_id, profile_revision, revision, status, active_brief_revision
        FROM synthetic_case_instance
        WHERE workspace_id = ? AND case_id = ?
      `).get(input.context.workspaceId, input.syntheticCase.caseId))
      if (
        current === undefined
        || current.revision !== input.expectedCaseRevision
        || current.status !== 'brief-ready'
        || current.active_brief_revision !== input.brief.revision
        || current.profile_id !== input.profile.profileId
        || current.profile_revision !== input.profile.revision
      ) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Synthetic Case is not ready to start',
        )
      }
      const consumed = this.#database.driver.prepare(`
        SELECT 1 AS present FROM synthetic_case_materialization
        WHERE workspace_id = ? AND case_id = ?
        LIMIT 1
      `).get(input.context.workspaceId, input.syntheticCase.caseId)
      if (consumed !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Synthetic Case was already started')
      }
      const now = this.#context.virtualTime(input.context)
      const materialized = materialize(transaction)
      const caseUpdate = this.#database.driver.prepare(`
        UPDATE synthetic_case_instance
        SET status = 'started', revision = revision + 1, updated_at = ?
        WHERE workspace_id = ? AND case_id = ? AND revision = ?
          AND status = 'brief-ready' AND active_brief_revision = ?
      `).run(
        now,
        input.context.workspaceId,
        input.syntheticCase.caseId,
        input.expectedCaseRevision,
        input.brief.revision,
      )
      if (caseUpdate.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Synthetic Case changed while starting')
      }
      return { ...materialized, effects: [...materialized.effects, {
        kind: 'updated' as const, reference: `SyntheticCase/${input.syntheticCase.caseId}`, versionId: String(input.expectedCaseRevision + 1),
      }] }
  }

  applyMaterializeSyntheticPatient(input: {
    caseId: string
    context: ActorContext
    profile: Pick<SyntheticPatientProfile, 'demographics' | 'identity' | 'profileId' | 'revision'>
    transaction: CommandTransaction
  }) {
    const patient = input.transaction.fhir.create(input.context, {
      active: true,
      address: [{ text: input.profile.identity.address }],
      birthDate: input.profile.demographics.birthDate,
      extension: [{
        url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
        valueBoolean: true,
      }, {
        url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-profile',
        valueString: input.profile.profileId,
      }, {
        url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-case',
        valueString: input.caseId,
      }],
      gender: input.profile.demographics.gender,
      id: uuidv7(),
      identifier: [{
        system: 'https://caizongyuan.github.io/clinmesh/fhir/synthetic-patient-id',
        value: input.profile.identity.mrn,
      }, {
        system: 'urn:oid:1.2.156.112605.1.1',
        value: input.profile.identity.nationalId,
      }],
      name: [{ text: input.profile.identity.displayName }],
      resourceType: 'Patient',
      telecom: [{ system: 'phone', value: input.profile.identity.phone }, {
        system: 'email', value: input.profile.identity.email,
      }],
    })
    const now = this.#context.virtualTime(input.context)
    this.#database.driver.prepare(`
      INSERT INTO synthetic_patient_materialization (
        workspace_id, epoch, profile_id, patient_id, profile_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      input.profile.profileId,
      patient.id,
      input.profile.revision,
      now,
    )
    return patient
  }

  #materializeSyntheticCaseVisit(input: {
    brief: Pick<PatientPersonaRevision, 'content' | 'revision'>
    caseId: string
    caseRevision: number
    context: ActorContext
    departmentId: string
    locationId: string
    profile: Pick<SyntheticPatientProfile, 'demographics' | 'identity' | 'profileId' | 'revision'>
    transaction: CommandTransaction
    visitDate: string
    visitTypeId: string
  }) {
    const patient = this.applyMaterializeSyntheticPatient(input)
    const now = this.#context.virtualTime(input.context)
    const registered = this.#registerPatient(input.transaction, input.context, {
      materializingSyntheticCase: true,
      departmentId: input.departmentId,
      locationId: input.locationId,
      patientId: patient.id,
      visitDate: input.visitDate,
      visitTypeId: input.visitTypeId,
    })
    this.#appendPersonaOpeningTurn(
      input.context,
      registered.outpatientCaseId,
      { content: input.brief.content, revision: input.brief.revision },
    )
    this.#database.driver.prepare(`
      INSERT INTO synthetic_case_materialization (
        workspace_id, epoch, case_id, case_revision, profile_id,
        profile_revision, brief_revision, patient_id, outpatient_case_id,
        registration_id, encounter_id, queue_task_id, started_by_actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      input.caseId,
      input.caseRevision,
      input.profile.profileId,
      input.profile.revision,
      input.brief.revision,
      patient.id,
      registered.outpatientCaseId,
      registered.data.registrationId,
      registered.data.encounterId,
      registered.data.queueTaskId,
      input.context.actorId,
      now,
    )
    return {
      data: {
        encounterId: registered.data.encounterId,
        outpatientCaseId: registered.outpatientCaseId,
        patientId: patient.id,
        queueTaskId: registered.data.queueTaskId,
        registrationId: registered.data.registrationId,
      },
      effects: [{
        kind: 'created' as const,
        reference: `Patient/${patient.id}`,
        versionId: patient.meta?.versionId ?? '1',
      }, ...registered.effects],
    }
  }

  #registerPatient(
    transaction: CommandTransaction,
    context: ActorContext,
    registration: {
      materializingSyntheticCase?: boolean
      departmentId: string
      locationId: string
      patientId: string
      visitDate: string
      visitTypeId: string
    },
  ) {
    const patient = transaction.fhir.read(context, 'Patient', registration.patientId)
    const department = this.#context.catalogItem(context, registration.departmentId, 'department')
    const location = transaction.fhir.read(context, 'Location', registration.locationId)
    if (!this.#isRegistrationLocation(location)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The selected registration location is unavailable')
    }
    const visitType = this.#context.catalogItem(context, registration.visitTypeId, 'visit-type')
    if (registration.visitDate !== this.#context.virtualTime(context).slice(0, 10)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The visit date is outside the active virtual date')
    }
    if (this.#context.activeCaseByPatient(context, patient.id) !== undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The patient already has an active outpatient case')
    }
    const source = registration.materializingSyntheticCase === true
      ? undefined : uniquePatientCaseSource(this.#database, context, patient.id)
    const caseId = uuidv7()
    const registrationId = uuidv7()
    const encounterId = uuidv7()
    const queueTaskId = uuidv7()
    const accountId = uuidv7()
    const chargeItemId = uuidv7()
    const chargeId = uuidv7()
    const now = this.#context.virtualTime(context)
    const registrationNumber = allocateRegistrationNumber(this.#database, registration.visitDate)
    const encounter = transaction.fhir.create(context, {
      resourceType: 'Encounter',
      id: encounterId,
      identifier: [{
        system: 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter',
        value: registrationNumber,
      }],
      status: 'planned',
      class: [{
        coding: [{ code: 'AMB', display: 'ambulatory', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }],
      }],
      subject: { reference: `Patient/${patient.id}` },
      serviceProvider: { reference: 'Organization/organization-clinmesh' },
      location: [{ location: { reference: `Location/${location.id}` }, status: 'active' }],
      actualPeriod: { start: now },
    })
    const task = transaction.fhir.create(context, {
      resourceType: 'Task',
      id: queueTaskId,
      status: 'requested',
      intent: 'order',
      code: { text: 'Outpatient triage' },
      for: { reference: `Patient/${patient.id}` },
      focus: { reference: `Encounter/${encounterId}` },
      owner: { reference: 'PractitionerRole/practitioner-role-triage-nurse' },
      authoredOn: now,
    })
    const account = transaction.fhir.create(context, {
      resourceType: 'Account',
      id: accountId,
      status: 'active',
      subject: [{ reference: `Patient/${patient.id}` }],
      servicePeriod: { start: now },
    })
    const chargeItem = transaction.fhir.create(context, {
      resourceType: 'ChargeItem',
      id: chargeItemId,
      status: 'billable',
      code: { text: visitType.name_zh },
      subject: { reference: `Patient/${patient.id}` },
      encounter: { reference: `Encounter/${encounterId}` },
      account: [{ reference: `Account/${accountId}` }],
      occurrenceDateTime: now,
      quantity: { value: 1 },
      unitPriceComponent: { amount: { currency: 'CNY', value: visitType.price_fen / 100 } },
    })
    this.#database.driver.prepare(`
      INSERT INTO outpatient_case (
        workspace_id, epoch, case_id, scenario_run_id, patient_id,
        registration_id, encounter_id, account_id, department_id, location_id,
        initial_task_id, status, arrived_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-triage', ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      caseId,
      context.scenarioRunId,
      patient.id,
      registrationId,
      encounterId,
      accountId,
      department.item_id,
      location.id,
      queueTaskId,
      now,
      now,
    )
    this.#database.driver.prepare(`INSERT INTO clinical_request_context(workspace_id,epoch,case_id,outpatient_case_id,patient_id,encounter_id)
      VALUES(?,?,?,?,?,?)`).run(context.workspaceId,context.epoch,caseId,caseId,patient.id,encounterId)
    if (source !== undefined) this.#database.driver.prepare(`INSERT INTO outpatient_case_source
      (workspace_id,epoch,outpatient_case_id,source_case_id) VALUES(?,?,?,?)`).run(context.workspaceId,context.epoch,caseId,source.case_id)
    if (registration.materializingSyntheticCase === true || source !== undefined) this.#createConsultation(context, caseId)
    this.#database.driver.prepare(`
      INSERT INTO registration (
        workspace_id, epoch, registration_id, case_id, registration_number,
        patient_id, encounter_id, visit_type_id, visit_date, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)
    `).run(
      context.workspaceId,
      context.epoch,
      registrationId,
      caseId,
      registrationNumber,
      patient.id,
      encounterId,
      visitType.item_id,
      registration.visitDate,
      now,
    )
    this.#database.driver.prepare(`
      INSERT INTO charge_record (
        workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
        category, source_reference, description_zh, description_en,
        quantity, unit_price_fen, total_fen, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'registration', ?, ?, ?, 1, ?, ?, 'billable', ?)
    `).run(
      context.workspaceId,
      context.epoch,
      chargeId,
      caseId,
      accountId,
      chargeItemId,
      `Registration/${registrationId}`,
      visitType.name_zh,
      visitType.name_en,
      visitType.price_fen,
      visitType.price_fen,
      now,
    )
    return {
      data: {
        accountId,
        chargeItemId,
        encounterId,
        patientId: patient.id,
        queueTaskId,
        registrationId,
        status: 'awaiting-triage' as const,
        totalFen: visitType.price_fen,
      },
      effects: [encounter, task, account, chargeItem].map(resource => ({
        kind: 'created' as const,
        reference: `${resource.resourceType}/${resource.id}`,
        versionId: resource.meta?.versionId ?? '1',
      })),
      outpatientCaseId: caseId,
    }
  }

  triageQueue(
    context: ActorContext,
    pageSize: number,
    status: 'completed' | 'exception' | 'pending' = 'pending',
    page = 1,
  ) {
    this.#context.assertRole(context, ['triage-nurse'])
    if (status === 'exception') return { items: [], page, pageSize, total: 0 }
    const queueCondition = status === 'pending'
      ? "outpatient_case.status = 'awaiting-triage'"
      : `outpatient_case.status != 'awaiting-triage'
        AND EXISTS (
          SELECT 1 FROM triage_record
          WHERE triage_record.workspace_id = outpatient_case.workspace_id
            AND triage_record.epoch = outpatient_case.epoch
            AND triage_record.case_id = outpatient_case.case_id
        )`
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND ${queueCondition}
    `).get(context.workspaceId, context.epoch) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.*, patient.content_json AS patient_json,
        registration.registration_number, registration.visit_type_id,
        triage.vital_json AS triage_vital_json,
        triage.recorded_at AS triage_recorded_at,
        department.name_zh AS department_name_zh,
        department.name_en AS department_name_en,
        visit_type.name_zh AS visit_type_name_zh,
        visit_type.name_en AS visit_type_name_en,
        location.content_json AS location_json,
        encounter.version_id AS encounter_version,
        task.version_id AS task_version
      FROM outpatient_case
      JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
      LEFT JOIN triage_record AS triage
        ON triage.workspace_id = outpatient_case.workspace_id
       AND triage.epoch = outpatient_case.epoch
       AND triage.case_id = outpatient_case.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN outpatient_catalog AS department
        ON department.workspace_id = outpatient_case.workspace_id
       AND department.epoch = outpatient_case.epoch
       AND department.item_id = outpatient_case.department_id
       AND department.kind = 'department'
      JOIN outpatient_catalog AS visit_type
        ON visit_type.workspace_id = registration.workspace_id
       AND visit_type.epoch = registration.epoch
       AND visit_type.item_id = registration.visit_type_id
       AND visit_type.kind = 'visit-type'
      JOIN fhir_resource AS location
        ON location.workspace_id = outpatient_case.workspace_id
       AND location.epoch = outpatient_case.epoch
       AND location.resource_type = 'Location'
       AND location.resource_id = outpatient_case.location_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.initial_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND ${queueCondition}
      ORDER BY outpatient_case.arrived_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(context.workspaceId, context.epoch, pageSize, (page - 1) * pageSize) as Array<{
      arrived_at: string
      case_id: string
      department_id: string
      department_name_en: string
      department_name_zh: string
      encounter_id: string
      encounter_version: number
      location_json: string
      patient_json: string
      registration_number: string
      location_id: string
      status: string
      task_version: number
      initial_task_id: string
      triage_recorded_at: string | null
      triage_vital_json: string | null
      visit_type_id: string
      visit_type_name_en: string
      visit_type_name_zh: string
    }>
    return {
      items: rows.map(row => {
        const location = parseStoredFhirResource(row.location_json)
        const patient = patientSummary(parseStoredFhirResource(row.patient_json))
        const locationNameZh = typeof location.name === 'string' ? location.name : row.location_id
        const locationAliases = Array.isArray(location.alias) ? location.alias : []
        const locationNameEn = locationAliases.find((alias): alias is string => typeof alias === 'string')
          ?? locationNameZh
        const triage = row.triage_vital_json === null || row.triage_recorded_at === null
          ? undefined
          : {
              ...triageRecordContentSchema.parse(JSON.parse(row.triage_vital_json)),
              recordedAt: row.triage_recorded_at,
            }
        return {
          arrivedAt: row.arrived_at,
          caseId: row.case_id,
          department: {
            id: row.department_id,
            nameEn: row.department_name_en,
            nameZh: row.department_name_zh,
          },
          encounterId: row.encounter_id,
          encounterVersion: String(row.encounter_version),
          location: {
            id: row.location_id,
            nameEn: locationNameEn,
            nameZh: locationNameZh,
          },
          patient,
          registrationNumber: row.registration_number,
          riskFlags: this.#context.patientAllergyWarnings(context, patient.id),
          status: row.status,
          taskId: row.initial_task_id,
          taskVersion: String(row.task_version),
          ...(triage === undefined ? {} : { triage }),
          visitType: {
            id: row.visit_type_id,
            nameEn: row.visit_type_name_en,
            nameZh: row.visit_type_name_zh,
          },
        }
      }),
      page,
      pageSize,
      total: total.count,
    }
  }

  recordTriage(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    triage: {
      acuityCode: 'level-1' | 'level-2' | 'level-3' | 'level-4'
      bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
      chiefComplaint: string
      oxygenSaturationPct: number
      pulseBpm: number
      respirationBpm: number
      temperatureC: number
    }
  }): CommandResponse<{
    doctorTaskId: string
    encounterId: string
    encounterVersion: string
    observationId: string
    status: 'awaiting-doctor'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: triageResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.triage },
      operation: 'encounter.record-triage',
    }, transaction => {
      this.#context.assertRole(input.context, ['triage-nurse'])
      const outpatientCase = this.#database.driver.prepare(`
        SELECT case_id, patient_id, encounter_id, initial_task_id, status
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND encounter_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.encounterId) as {
        case_id: string
        encounter_id: string
        patient_id: string
        status: string
        initial_task_id: string
      } | undefined
      if (outpatientCase === undefined || outpatientCase.status !== 'awaiting-triage') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting triage')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${outpatientCase.encounter_id}`,
        `Task/${outpatientCase.initial_task_id}`,
      ])
      const encounter = transaction.fhir.read(input.context, 'Encounter', outpatientCase.encounter_id)
      const triageTask = transaction.fhir.read(input.context, 'Task', outpatientCase.initial_task_id)
      const observationId = uuidv7()
      const doctorTaskId = uuidv7()
      const triageId = uuidv7()
      const now = this.#context.virtualTime(input.context)
      const observation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: observationId,
        status: 'final',
        category: [{
          coding: [{
            code: 'vital-signs',
            display: 'Vital Signs',
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          }],
        }],
        code: { text: 'Outpatient triage vital signs' },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${outpatientCase.encounter_id}` },
        effectiveDateTime: now,
        performer: [{ reference: `Practitioner/${input.context.practitionerId}` }],
        component: [
          { code: { coding: [{ code: '8310-5', system: 'http://loinc.org' }] }, valueQuantity: { code: 'Cel', system: 'http://unitsofmeasure.org', unit: '°C', value: input.triage.temperatureC } },
          { code: { coding: [{ code: '8867-4', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: input.triage.pulseBpm } },
          { code: { coding: [{ code: '9279-1', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: input.triage.respirationBpm } },
          { code: { coding: [{ code: '8480-6', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: input.triage.bloodPressure.systolicMmHg } },
          { code: { coding: [{ code: '8462-4', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: input.triage.bloodPressure.diastolicMmHg } },
          { code: { coding: [{ code: '59408-5', system: 'http://loinc.org' }] }, valueQuantity: { code: '%', system: 'http://unitsofmeasure.org', unit: '%', value: input.triage.oxygenSaturationPct } },
        ],
        note: [{ text: input.triage.chiefComplaint }],
      })
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
      }, encounter.meta?.versionId ?? '1')
      const completedTriageTask = transaction.fhir.update(input.context, {
        ...triageTask,
        status: 'completed',
        executionPeriod: { end: now },
      }, triageTask.meta?.versionId ?? '1')
      const doctorTask = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: doctorTaskId,
        status: 'requested',
        intent: 'order',
        code: { text: 'Outpatient consultation' },
        for: { reference: `Patient/${outpatientCase.patient_id}` },
        focus: { reference: `Encounter/${outpatientCase.encounter_id}` },
        owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
        authoredOn: now,
      })
      this.#database.driver.prepare(`
        INSERT INTO triage_record (
          workspace_id, epoch, triage_id, case_id, encounter_id, version,
          acuity_code, chief_complaint, vital_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        triageId,
        outpatientCase.case_id,
        outpatientCase.encounter_id,
        input.triage.acuityCode,
        input.triage.chiefComplaint,
        JSON.stringify(input.triage),
        now,
      )
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-doctor', doctor_task_id = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-triage'
      `).run(
        doctorTaskId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      this.#database.driver.prepare(`
        UPDATE registration SET status = 'triaged'
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).run(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      return {
        data: {
          doctorTaskId,
          encounterId: outpatientCase.encounter_id,
          encounterVersion: updatedEncounter.meta?.versionId ?? '2',
          observationId,
          status: 'awaiting-doctor' as const,
        },
        effects: [
          { kind: 'created' as const, resource: observation },
          { kind: 'updated' as const, resource: updatedEncounter },
          { kind: 'updated' as const, resource: completedTriageTask },
          { kind: 'created' as const, resource: doctorTask },
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  doctorQueue(context: ActorContext, pageSize: number, page = 1, view?: DoctorQueueView) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const statuses: readonly string[] = view === undefined
      ? [...doctorQueueViewStatusGroups.waiting, ...doctorQueueViewStatusGroups.active]
      : doctorQueueViewStatusGroups[view]
    const placeholders = statuses.map(() => '?').join(', ')
    const bindings = [context.workspaceId, context.epoch, ...statuses]
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status IN (${placeholders})
        AND json_extract(encounter.content_json, '$.status') = 'in-progress'
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.*, patient.content_json AS patient_json,
        registration.registration_number,
        triage.acuity_code, triage.chief_complaint, triage.vital_json,
        encounter.version_id AS encounter_version, task.version_id AS task_version
      FROM outpatient_case
      LEFT JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
      LEFT JOIN triage_record AS triage
        ON triage.workspace_id = outpatient_case.workspace_id
       AND triage.epoch = outpatient_case.epoch
       AND triage.case_id = outpatient_case.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.doctor_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status IN (${placeholders})
        AND json_extract(encounter.content_json, '$.status') = 'in-progress'
      ORDER BY outpatient_case.arrived_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(...bindings, pageSize, (page - 1) * pageSize) as Array<{
      acuity_code: string | null
      case_id: string
      chief_complaint: string | null
      diagnostic_report_id: string | null
      doctor_task_id: string
      encounter_id: string
      encounter_version: number
      patient_json: string
      registration_number: string | null
      status: string
      task_version: number
      vital_json: string | null
    }>
    return {
      items: rows.map(row => {
        const triage = row.vital_json === null
          ? undefined
          : triageRecordContentSchema.parse(JSON.parse(row.vital_json))
        return {
          caseId: row.case_id,
          ...(row.diagnostic_report_id === null ? {} : { diagnosticReportId: row.diagnostic_report_id }),
          encounterId: row.encounter_id,
          encounterVersion: String(row.encounter_version),
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          registrationNumber: doctorQueueItemSchema.shape.registrationNumber.parse(row.registration_number),
          presentation: casePresentation(triage),
          status: row.status,
          taskId: row.doctor_task_id,
          taskVersion: String(row.task_version),
          ...(triage === undefined || row.acuity_code === null || row.chief_complaint === null
            ? {}
            : {
                triage: {
                  acuityCode: row.acuity_code,
                  chiefComplaint: row.chief_complaint,
                  temperatureC: triage.temperatureC,
                },
              }),
        }
      }),
      page,
      pageSize,
      total: total.count,
    }
  }

  doctorCompletedCases(context: ActorContext, filters: {
    completedFrom?: string | undefined
    completedTo?: string | undefined
    diagnosisCatalogItemId?: string | undefined
    page: number
    pageSize: number
    patientId?: string | undefined
  }) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const practitionerRoleId = this.#context.requiredPractitionerRoleId(context)
    const completedFrom = filters.completedFrom ?? null
    const completedTo = filters.completedTo ?? null
    const diagnosisCatalogItemId = filters.diagnosisCatalogItemId ?? null
    const patientId = filters.patientId ?? null
    const bindings = [
      context.workspaceId,
      context.epoch,
      practitionerRoleId,
      patientId,
      patientId,
      completedFrom,
      completedFrom,
      completedTo,
      completedTo,
      diagnosisCatalogItemId,
      diagnosisCatalogItemId,
      diagnosisCatalogItemId,
    ]
    const total = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      ${completedCaseSelectionSql}
    `).get(...bindings))
    const rows = z.array(completedCaseListRowSchema).parse(this.#database.driver.prepare(`
      SELECT outpatient_case.case_id,
        patient.content_json AS patient_json,
        encounter.content_json AS encounter_json
      ${completedCaseSelectionSql}
      ORDER BY json_extract(encounter.content_json, '$.actualPeriod.end') DESC,
        outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(
      ...bindings,
      filters.pageSize,
      (filters.page - 1) * filters.pageSize,
    ))
    return doctorCompletedCaseListSchema.parse({
      items: rows.map((row) => {
        const encounter = encounterCompletionResourceSchema.parse(
          parseStoredFhirResource(row.encounter_json),
        )
        const primaryDiagnosis = this.#completedCaseDiagnosis(context, row.case_id)
          ?.entries.find(entry => entry.role === 'primary')
        if (encounter.status !== 'completed' || encounter.actualPeriod.end === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed Encounter is incomplete')
        }
        return {
          caseId: row.case_id,
          completedAt: encounter.actualPeriod.end,
          encounterId: encounter.id,
          encounterVersion: encounter.meta.versionId,
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          ...(primaryDiagnosis === undefined ? {} : { primaryDiagnosis }),
        }
      }),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.count,
    })
  }

  doctorCaseHistory(context: ActorContext, currentCaseId: string, input: DoctorCaseHistoryInput) {
    const patientId = this.#doctorHistoryPatient(context, currentCaseId)
    if (input.source === 'visible-source') {
      return doctorVisibleHistory(this.#database, context, currentCaseId, patientId, input)
    }
    const outpatient = z.array(z.object({ case_id: z.string(), completed_at: z.string() })).parse(this.#database.driver.prepare(`
      SELECT history.case_id, json_extract(encounter.content_json,'$.actualPeriod.end') AS completed_at
      FROM outpatient_case history JOIN outpatient_case_responsibility responsibility
        ON responsibility.workspace_id=history.workspace_id AND responsibility.epoch=history.epoch
        AND responsibility.case_id=history.case_id AND responsibility.practitioner_role_id=?
      JOIN fhir_resource encounter ON encounter.workspace_id=history.workspace_id AND encounter.epoch=history.epoch
        AND encounter.resource_type='Encounter' AND encounter.resource_id=history.encounter_id AND encounter.deleted=0
      WHERE history.workspace_id=? AND history.epoch=? AND history.patient_id=?
        AND json_extract(encounter.content_json,'$.status')='completed'
        AND json_extract(encounter.content_json,'$.actualPeriod.end') IS NOT NULL
    `).all(context.practitionerRoleId, context.workspaceId, context.epoch, patientId))
    const items = [...outpatient.map(item => ({
      clinicalDate: item.completed_at, entryId: item.case_id, resourceType: 'Encounter', source: input.source,
      title: '本院完诊记录',
    })), ...inpatientHistoryItems(this.#database, context, patientId)]
      .sort((left, right) => Date.parse(right.clinicalDate) - Date.parse(left.clinicalDate) || left.entryId.localeCompare(right.entryId))
    return doctorCaseHistorySchema.parse({
      page: input.page, pageSize: input.pageSize, total: items.length,
      availability: items.length === 0 ? 'no-data' : 'available',
      coverage: 'current-patient-responsible-doctor',
      items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(item => item.resourceType === 'Encounter'
        ? { ...item, title: this.#completedCaseDiagnosis(context, item.entryId)?.entries.find(entry => entry.role === 'primary')?.display ?? item.title }
        : item),
      source: input.source,
    })
  }

  doctorCaseHistoryDetail(context: ActorContext, currentCaseId: string, input: DoctorCaseHistoryDetailInput) {
    const patientId = this.#doctorHistoryPatient(context, currentCaseId)
    if (input.source === 'visible-source') {
      return doctorVisibleHistoryDetail(this.#database, context, currentCaseId, patientId, input.entryId)
    }
    if (isInpatientHistoryEntry(input.entryId)) return doctorCompletedHistoryDetailSchema.parse(
      inpatientHistoryDetail(this.#database, context, patientId, input.entryId),
    )
    if (!doctorHistoryEntryAllowed(this.#database, context, currentCaseId, input)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The authorized history entry was not found')
    }
    return doctorCompletedHistoryDetailSchema.parse({
      entryId: input.entryId,
      record: this.doctorCompletedCaseDetail(context, input.entryId),
      source: input.source,
    })
  }

  doctorRecommendationHistory(context: ActorContext, currentCaseId: string): DoctorCaseHistoryDetail[] {
    const patientId = this.#doctorHistoryPatient(context, currentCaseId)
    const history: DoctorCaseHistoryDetail[] = doctorVisibleHistoryDetails(this.#database, context, currentCaseId, patientId)
    for (let page = 1; ; page += 1) {
      const completed = this.doctorCaseHistory(context, currentCaseId, { source: 'local-completed', page, pageSize: 20 })
      for (const item of completed.items) history.push(this.doctorCaseHistoryDetail(context, currentCaseId, {
        source: 'local-completed', entryId: item.entryId,
      }))
      if (page * completed.pageSize >= completed.total) break
    }
    return history
  }

  #doctorHistoryPatient(context: ActorContext, caseId: string, inactiveReason?: PrescriptionConflictReason): string {
    this.#context.assertRole(context, ['outpatient-doctor'])
    new WorkspaceRepository(this.#database).assertCurrent(context, context.scenarioRunId)
    this.#context.assertCaseResponsibility(context, caseId)
    const row = z.object({
      encounter_status: z.string(),
      patient_id: z.string().min(1),
    }).optional().parse(
      this.#database.driver.prepare(`
        SELECT outpatient_case.patient_id,
          json_extract(encounter.content_json, '$.status') AS encounter_status
        FROM outpatient_case
        JOIN fhir_resource AS patient
          ON patient.workspace_id = outpatient_case.workspace_id
         AND patient.epoch = outpatient_case.epoch AND patient.resource_type = 'Patient'
         AND patient.resource_id = outpatient_case.patient_id AND patient.deleted = 0
        JOIN fhir_resource AS encounter
          ON encounter.workspace_id = outpatient_case.workspace_id
         AND encounter.epoch = outpatient_case.epoch AND encounter.resource_type = 'Encounter'
         AND encounter.resource_id = outpatient_case.encounter_id AND encounter.deleted = 0
        WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
          AND outpatient_case.case_id = ? AND outpatient_case.scenario_run_id = ?
      `).get(context.workspaceId, context.epoch, caseId, context.scenarioRunId),
    )
    if (row === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The current outpatient case was not found')
    }
    if (row.encounter_status !== 'in-progress') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The current outpatient case was not found', undefined, inactiveReason)
    }
    return row.patient_id
  }


  doctorCompletedCaseDetail(context: ActorContext, caseId: string) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const row = completedCaseDetailRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT patient.content_json AS patient_json,
        encounter.content_json AS encounter_json
      FROM outpatient_case
      JOIN outpatient_case_responsibility AS responsibility
        ON responsibility.workspace_id = outpatient_case.workspace_id
       AND responsibility.epoch = outpatient_case.epoch
       AND responsibility.case_id = outpatient_case.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ?
        AND responsibility.practitioner_role_id = ?
        AND patient.deleted = 0 AND encounter.deleted = 0
        AND json_extract(encounter.content_json, '$.status') = 'completed'
        AND json_extract(encounter.content_json, '$.actualPeriod.end') IS NOT NULL
    `).get(
      context.workspaceId,
      context.epoch,
      caseId,
      this.#context.requiredPractitionerRoleId(context),
    ))
    if (row === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed outpatient case was not found')
    }
    const encounter = encounterCompletionResourceSchema.parse(
      parseStoredFhirResource(row.encounter_json),
    )
    if (encounter.status !== 'completed' || encounter.actualPeriod.end === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed Encounter is incomplete')
    }
    const consultation = this.#context.consultationSnapshot(context, caseId)
    const diagnosis = this.#completedCaseDiagnosis(context, caseId)
    const medicationConclusion = this.#prescriptions.completedCaseMedicationConclusion(context, caseId)
    const clinicalDocuments = this.#clinicalDocuments.completedCaseClinicalDocuments(context, caseId)
    const laboratoryRequests = this.#laboratory.completedCaseLaboratoryRequests(context, caseId)
    const facts = doctorCompletedCaseDetailSchema.omit({ timeline: true }).parse({
      caseId,
      clinicalDocuments,
      completedAt: encounter.actualPeriod.end,
      ...(consultation === undefined ? {} : {
        consultation: {
          turns: consultation.turns,
          version: consultation.version,
        },
      }),
      ...(diagnosis === undefined ? {} : { diagnosis }),
      encounter: {
        id: encounter.id,
        status: encounter.status,
        versionId: encounter.meta.versionId,
      },
      imagingRequests: this.imaging.state(context, caseId).requests,
      laboratoryRequests,
      pathologyRequests: this.pathology.state(context, caseId).requests,
      ...(medicationConclusion === undefined ? {} : { medicationConclusion }),
      patient: patientSummary(parseStoredFhirResource(row.patient_json)),
    })
    return doctorCompletedCaseDetailSchema.parse({
      ...facts,
      timeline: this.#completedCaseTimeline(context, {
        ...facts,
        encounterId: encounter.id,
      }),
    })
  }

  caseLaboratoryCatalog(
    context: ActorContext,
    caseId: string,
    input: { page: number; pageSize: number; query?: string },
  ) {
    return this.#laboratory.caseLaboratoryCatalog(context, caseId, input)
  }

  doctorRecommendationCase(context: ActorContext, caseId: string, inactiveReason?: PrescriptionConflictReason) {
    this.#doctorHistoryPatient(context, caseId, inactiveReason)
    return this.#doctorCaseSnapshot(context, caseId)
  }

  doctorRecommendationMedications(context: ActorContext) {
    return this.#prescriptions.doctorRecommendationMedications(context)
  }

  doctorCaseRecordingRevision(context: ActorContext, caseId: string): string {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const found = z.object({ case_id: z.string() }).optional().parse(this.#database.driver.prepare(`
      SELECT case_id FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId))
    if (found === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
    return this.consultationRecording.revision(context, caseId)
  }

  doctorCaseDetail(context: ActorContext, caseId: string) {
    const detail = this.#doctorCaseSnapshot(context, caseId)
    return !this.#context.hasCaseResponsibility(context, caseId) || detail.encounter.status !== 'in-progress'
      ? detail
      : { ...detail, qualityControl: this.qualityControl.read(context, caseId) }
  }

  #doctorCaseSnapshot(context: ActorContext, caseId: string) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const row = this.#database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.status, outpatient_case.diagnostic_report_id,
        outpatient_case.doctor_task_id, registration.registration_number,
        patient.content_json AS patient_json,
        encounter.content_json AS encounter_json,
        task.version_id AS task_version,
        triage.acuity_code, triage.chief_complaint, triage.vital_json
      FROM outpatient_case
      LEFT JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
      LEFT JOIN triage_record AS triage
        ON triage.workspace_id = outpatient_case.workspace_id
       AND triage.epoch = outpatient_case.epoch
       AND triage.case_id = outpatient_case.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.doctor_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ?
    `).get(context.workspaceId, context.epoch, caseId) as {
      acuity_code: string | null
      case_id: string
      chief_complaint: string | null
      diagnostic_report_id: string | null
      doctor_task_id: string
      encounter_json: string
      patient_json: string
      registration_number: string | null
      status: string
      task_version: number
      vital_json: string | null
    } | undefined
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
    const patientResource = parseStoredFhirResource(row.patient_json)
    const encounter = parseStoredFhirResource(row.encounter_json)
    const triage = row.vital_json === null
      ? undefined
      : triageRecordContentSchema.parse(JSON.parse(row.vital_json))
    const report = row.diagnostic_report_id === null
      ? undefined
      : this.#laboratory.lisOrderSummary(context, row.diagnostic_report_id)
    const drafts = this.#clinicalDocuments.clinicalDraftSummary(context, caseId)
    const patient = patientSummary(patientResource)
    const priorFacts: z.infer<typeof doctorCaseDetailSchema>['priorFacts'] = []
    const priorParameters = new URLSearchParams({ _count: '100', patient: `Patient/${patient.id}` })
    for (;;) {
      const page = this.#fhir.search(context, 'Condition', priorParameters)
      priorFacts.push(...page.resources.flatMap(resource => {
        const condition = priorConditionSchema.parse(resource)
        if (condition.encounter?.reference === `Encounter/${encounter.id}`) return []
        const coding = condition.code?.coding?.[0]
        return [{
          clinicalStatus: condition.clinicalStatus?.coding?.[0]?.code ?? '',
          code: coding?.code ?? '',
          display: condition.code?.text ?? coding?.display ?? '',
          id: resource.id,
          ...(condition.recordedDate === undefined ? {} : { recordedDate: condition.recordedDate }),
        }]
      }))
      if (page.nextCursor === undefined) break
      priorParameters.set('_cursor', page.nextCursor)
    }
    const consultation = this.#context.consultationSnapshot(context, row.case_id)
    const { clinicalDocument, signedCount } = this.#clinicalDocuments.clinicalDocumentState(context, row.case_id)
    const laboratoryRequests = this.#laboratory.state(context, row.case_id)
    const diagnosisState = this.#context.diagnosisState(context, row.case_id)
    const diagnosisDraft = diagnosisState?.draft_json === null || diagnosisState?.draft_json === undefined
      ? undefined : storedDiagnosisDraftContentSchema.parse(JSON.parse(diagnosisState.draft_json))
    const diagnosisConfirmation = this.#context.confirmedDiagnoses(context, row.case_id)
    const medicationConclusion = this.#prescriptions.medicationConclusionState(context, row.case_id)
    const consultationRecording = this.consultationRecording.read(context, row.case_id)
    return {
      allergies: this.#context.patientAllergyWarnings(context, patient.id),
      caseId: row.case_id,
      clinicalHistory: {
        ...readClinicalHistoryContext(this.#database, context, row.case_id, patientResource, encounter).requirements,
        classificationEditable: context.agentGrantId === undefined
          && signedCount === 0
          && encounter.status === 'in-progress'
          && this.#context.hasCaseResponsibility(context, row.case_id),
      },
      registrationNumber: doctorCaseDetailSchema.shape.registrationNumber.parse(row.registration_number),
      ...(clinicalDocument === undefined ? {} : { clinicalDocument }),
      ...(consultation === undefined ? {} : { consultation }),
      ...(consultationRecording === undefined ? {} : { consultationRecording }),
      ...(diagnosisState === undefined ? {} : {
        diagnosis: {
          ...(diagnosisConfirmation === undefined ? {} : { confirmation: diagnosisConfirmation }),
          ...(diagnosisDraft === undefined || diagnosisDraft.entries.length === 0
            ? {}
            : { draft: diagnosisDraft }),
          draftVersion: diagnosisState.version,
        },
      }),
      encounter: {
        id: encounter.id,
        status: encounter.status,
        versionId: encounter.meta?.versionId,
      },
      ...(consultation === undefined ? {} : { imagingRequests: this.imaging.state(context, row.case_id) }),
      ...(consultation === undefined ? {} : { pathologyRequests: this.pathology.state(context, row.case_id) }),
      ...(laboratoryRequests === undefined ? {} : { laboratoryRequests }),
      ...(medicationConclusion === undefined ? {} : { medicationConclusion }),
      patient,
      presentation: casePresentation(triage),
      priorFacts,
      ...(report === undefined ? {} : { report }),
      ...(drafts === undefined ? {} : { drafts }),
      status: row.status,
      taskId: row.doctor_task_id,
      taskVersion: String(row.task_version),
      ...(triage === undefined ? {} : { triage }),
    }
  }

  encounterCompletionPreview(context: ActorContext, encounterId: string) {
    return this.#clinicalDocuments.encounterCompletionPreview(context, encounterId)
  }

  completeEncounter(input: Parameters<OutpatientClinicalDocumentService['completeEncounter']>[0]) {
    return this.#clinicalDocuments.completeEncounter(input)
  }

  appendDoctorConsultationTurn(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    expectedConsultationVersion: number
    idempotencyKey: string
    message: string
  }): CommandResponse<{ caseId: string; consultationVersion: number; turn: ConsultationTurnDto }> {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    return this.#commands.execute({
      context: input.context,
      dataSchema: appendConsultationTurnResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedConsultationVersion: input.expectedConsultationVersion,
        message: input.message,
      },
      operation: 'consultation.doctor-turn.append',
    }, transaction => {
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.doctor_task_id === null || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      if (outpatientCase.status !== 'awaiting-doctor') this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      if (this.#context.consultationTurnRows(input.context, outpatientCase.case_id).findLast(row => row.kind === 'text')?.speaker === 'doctor') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Retry the unanswered doctor message before sending another')
      }
      const firstVisitTransition = outpatientCase.status === 'awaiting-doctor'
        ? this.#transitionToFirstVisit(input.context, transaction, {
            caseId: outpatientCase.case_id,
            encounterId: input.encounterId,
            expectedVersions: input.expectedVersions,
            previousStatus: 'awaiting-doctor',
            queueTaskId: outpatientCase.doctor_task_id,
          })
        : undefined
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const turn = this.#insertConsultationTurn(input.context, outpatientCase.case_id, {
        expectedVersion: input.expectedConsultationVersion,
        kind: 'text',
        message: input.message,
        source: 'doctor-typed',
        speaker: 'doctor',
      })
      return {
        data: {
          caseId: outpatientCase.case_id,
          consultationVersion: turn.consultationVersion,
          turn: turn.turn,
        },
        effects: [...(firstVisitTransition?.effects ?? []), {
          kind: 'created' as const,
          reference: `ConsultationTurn/${turn.turn.id}`,
          versionId: '1',
        }, {
          kind: 'updated' as const,
          reference: `Consultation/${outpatientCase.case_id}`,
          versionId: String(turn.consultationVersion),
        }],
      }
    })
  }

  appendPatientConsultationTurn(input: {
    context: ActorContext
    encounterId: string
    doctorSequence: number
    idempotencyKey: string
    message: string
    personaRevision: number
  }): CommandResponse<{ caseId: string; consultationVersion: number; turn: ConsultationTurnDto }> {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    return this.#commands.execute({
      context: input.context,
      dataSchema: appendConsultationTurnResponseSchema.shape.data,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        doctorSequence: input.doctorSequence,
        personaRevision: input.personaRevision,
      },
      operation: 'consultation.patient-turn.append',
    }, transaction => {
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.doctor_task_id === null || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      if (outpatientCase.status !== 'awaiting-doctor') this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      const pending = this.lastUnansweredDoctorTurn(input.context, input.encounterId)
      if (pending?.turn.sequence !== input.doctorSequence) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The doctor message is no longer awaiting a reply')
      }
      const turn = this.#insertConsultationTurn(input.context, outpatientCase.case_id, {
        expectedVersion: pending.consultationVersion,
        kind: 'text',
        message: input.message,
        personaRevision: input.personaRevision,
        source: 'patient-agent',
        speaker: 'patient',
      })
      this.consultationRecording.enqueue(input.context, transaction, {
        caseId: outpatientCase.case_id, encounterId: input.encounterId, turnId: turn.turn.id,
      })
      return {
        data: {
          caseId: outpatientCase.case_id,
          consultationVersion: turn.consultationVersion,
          turn: turn.turn,
        },
        effects: [{
          kind: 'created' as const,
          reference: `ConsultationTurn/${turn.turn.id}`,
          versionId: '1',
        }, {
          kind: 'updated' as const,
          reference: `Consultation/${outpatientCase.case_id}`,
          versionId: String(turn.consultationVersion),
        }],
      }
    })
  }

  patientTurnAfter(
    context: ActorContext,
    encounterId: string,
    doctorSequence: number,
  ): { consultationVersion: number; turn: ConsultationTurnDto } | undefined {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    const state = this.#context.consultationState(context, outpatientCase.case_id)
    if (state === undefined) return undefined
    const row = consultationTurnRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT turn_id, case_id, sequence, speaker, kind, source, actor_id, practitioner_id,
        message_text, persona_revision, report_reference, recorded_at
      FROM consultation_turn
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND sequence > ?
        AND kind = 'text'
      ORDER BY sequence LIMIT 1
    `).get(context.workspaceId, context.epoch, outpatientCase.case_id, doctorSequence))
    if (row === undefined || row.speaker !== 'patient') return undefined
    return {
      consultationVersion: state.version,
      turn: consultationTurnDto(row),
    }
  }

  lastUnansweredDoctorTurn(context: ActorContext, encounterId: string) {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    const state = this.#context.consultationState(context, outpatientCase.case_id)
    if (state === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record is unavailable')
    }
    this.#context.assertCaseResponsibility(context, outpatientCase.case_id)
    const rows = this.#context.consultationTurnRows(context, outpatientCase.case_id)
    const last = rows.findLast(row => row.kind === 'text')
    if (last === undefined || last.speaker !== 'doctor') return undefined
    return {
      caseId: outpatientCase.case_id,
      consultationVersion: state.version,
      turn: consultationTurnDto(last),
    }
  }

  saveDiagnosisDraft(input: {
    context: ActorContext
    encounterId: string
    entries: DiagnosisDraftEntry[]
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof diagnosisDraftResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: diagnosisDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        entries: input.entries,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.save-diagnosis-draft',
    }, transaction => this.applySaveDiagnosisDraft(transaction, input))
  }

  applySaveDiagnosisDraft(_transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    entries: DiagnosisDraftEntry[]
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
    const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
    if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for diagnosis editing')
    }
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    if (new Set(input.entries.map(entry => entry.catalogItemId)).size !== input.entries.length) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The diagnosis draft contains a duplicate catalog item')
    }
    const resolvedEntries = input.entries.map(entry => (
      this.#context.resolvedDiagnosisSelection(input.context, entry)
    ))
    this.#context.assertNoLegacyDiagnosisOwner(input.context, outpatientCase.case_id)
    const current = diagnosisStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, status, draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
    )
    if ((current?.version ?? 0) !== input.expectedDraftVersion) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
    }
    const draft = JSON.stringify(storedDiagnosisDraftContentSchema.parse({ entries: resolvedEntries }))
    const nextVersion = input.expectedDraftVersion + 1
    const updatedAt = this.#context.virtualTime(input.context)
    if (current === undefined) {
      this.#database.driver.prepare(`
        INSERT INTO diagnosis_state (
          workspace_id, epoch, case_id, version, status, draft_json,
          updated_by, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        nextVersion,
        draft,
        input.context.actorId,
        updatedAt,
      )
    } else {
      const update = this.#database.driver.prepare(`
        UPDATE diagnosis_state
        SET version = ?, status = 'draft', draft_json = ?, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND version = ?
      `).run(
        nextVersion,
        draft,
        input.context.actorId,
        updatedAt,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        input.expectedDraftVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
      }
    }
    return {
      data: { draftVersion: nextVersion },
      effects: [{
        kind: current === undefined ? 'created' as const : 'updated' as const,
        reference: `DiagnosisDraft/${outpatientCase.case_id}`,
        versionId: String(nextVersion),
      }],
    }
  }

  confirmDiagnosis(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof confirmDiagnosisResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: confirmDiagnosisResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.confirm-diagnosis',
    }, transaction => this.applyConfirmDiagnosis(transaction, input))
  }

  applyConfirmDiagnosis(transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    if (input.context.practitionerRoleId === undefined) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'A Practitioner Role is required to confirm diagnosis')
    }
    const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
    const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
    if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for diagnosis confirmation')
    }
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    this.#context.assertNoLegacyDiagnosisOwner(input.context, outpatientCase.case_id)
    const state = diagnosisStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, status, draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
    )
    if (
      state?.status !== 'draft'
      || state.draft_json === null
      || state.version !== input.expectedDraftVersion
    ) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
    }
    const draft = storedDiagnosisDraftContentSchema.parse(JSON.parse(state.draft_json))
    if (draft.entries.filter(entry => entry.role === 'primary').length !== 1) {
      throw new WorkflowError(
        'DIAGNOSIS_PRIMARY_REQUIRED',
        'Exactly one primary diagnosis is required',
      )
    }
    const resolvedEntries = draft.entries.map((entry) => {
      const coding = entry.referenceConcept
        ?? this.#context.resolvedDiagnosisSelection(input.context, entry).referenceConcept
      if (coding === undefined) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The diagnosis coding snapshot is unavailable')
      }
      return { ...entry, coding }
    })
    const previousConfirmation = this.#context.confirmedDiagnoses(
      input.context,
      outpatientCase.case_id,
    )
    const revisionNumber = (previousConfirmation?.revisionNumber ?? 0) + 1
    const confirmedAt = this.#context.virtualTime(input.context)
    const supersededConditions = (previousConfirmation?.entries ?? []).map((entry) => {
      const condition = transaction.fhir.read(input.context, 'Condition', entry.conditionId)
      const { clinicalStatus: _clinicalStatus, ...conditionWithoutClinicalStatus } = condition
      return transaction.fhir.update(input.context, {
        ...conditionWithoutClinicalStatus,
        verificationStatus: {
          coding: [{
            code: 'entered-in-error',
            system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          }],
        },
      }, entry.conditionVersion)
    })
    const confirmedEntries = resolvedEntries.map(entry => ({
      condition: transaction.fhir.create(input.context, {
        resourceType: 'Condition',
        id: uuidv7(),
        category: [{
          coding: [{
            code: 'encounter-diagnosis',
            display: 'Encounter Diagnosis',
            system: 'http://terminology.hl7.org/CodeSystem/condition-category',
          }],
        }],
        clinicalStatus: {
          coding: [{
            code: 'active',
            system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          }],
        },
        verificationStatus: {
          coding: [{
            code: 'confirmed',
            system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          }],
        },
        code: {
          coding: [{
            code: entry.coding.code,
            display: entry.coding.display,
            system: entry.coding.system,
          }],
          text: entry.coding.display,
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        recordedDate: confirmedAt,
        recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        ...(entry.note === undefined ? {} : { note: [{ text: entry.note }] }),
      }),
      entry,
    }))
    const supersededConditionReferences = new Set(
      (previousConfirmation?.entries ?? []).map(entry => `Condition/${entry.conditionId}`),
    )
    const currentEncounterDiagnoses = Array.isArray(encounter.diagnosis)
      ? encounter.diagnosis.filter(diagnosis => (
          !supersededConditionReferences.has(
            encounterDiagnosisConditionReference(diagnosis) ?? '',
          )
        ))
      : []
    const updatedEncounter = transaction.fhir.update(input.context, {
      ...encounter,
      diagnosis: [
        ...currentEncounterDiagnoses,
        ...confirmedEntries.map(({ condition, entry }) => ({
          condition: [{ reference: { reference: `Condition/${condition.id}` } }],
          use: [{
            coding: [{
              code: entry.role,
              display: entry.role === 'primary'
                ? 'Primary diagnosis'
                : 'Secondary diagnosis',
              system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/encounter-diagnosis-role',
            }],
          }],
        })),
      ],
    }, encounter.meta?.versionId ?? '1')
    const provenanceId = uuidv7()
    const provenance = transaction.fhir.createImmutable(input.context, {
      resourceType: 'Provenance',
      id: provenanceId,
      target: [
        ...supersededConditions.map(condition => ({ reference: `Condition/${condition.id}` })),
        ...confirmedEntries.map(({ condition }) => ({ reference: `Condition/${condition.id}` })),
        { reference: `Encounter/${input.encounterId}` },
      ],
      recorded: confirmedAt,
      activity: {
        text: previousConfirmation === undefined
          ? 'Encounter diagnosis confirmation'
          : 'Encounter diagnosis revision',
      },
      agent: provenanceAgents(input.context, 'Diagnosis confirmer'),
    })
    const confirmationId = uuidv7()
    this.#database.driver.prepare(`
      INSERT INTO diagnosis_confirmation (
        workspace_id, epoch, confirmation_id, case_id, revision_number,
        supersedes_confirmation_id, provenance_id,
        confirmed_by_actor_id, confirmed_by_practitioner_role_id, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      confirmationId,
      outpatientCase.case_id,
      revisionNumber,
      previousConfirmation?.id ?? null,
      provenanceId,
      input.context.actorId,
      input.context.practitionerRoleId,
      confirmedAt,
    )
    const insertEntry = this.#database.driver.prepare(`
      INSERT INTO diagnosis_entry (
        workspace_id, epoch, confirmation_id, ordinal,
        condition_id, catalog_item_id, coding_snapshot_json, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    confirmedEntries.forEach(({ condition, entry }, index) => {
      insertEntry.run(
        input.context.workspaceId,
        input.context.epoch,
        confirmationId,
        index + 1,
        condition.id,
        entry.catalogItemId,
        JSON.stringify(entry.coding),
        entry.role,
      )
    })
    const diagnosisVersion = state.version + 1
    const update = this.#database.driver.prepare(`
      UPDATE diagnosis_state
      SET version = ?, status = 'confirmed', draft_json = NULL,
        updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND status = 'draft' AND version = ?
    `).run(
      diagnosisVersion,
      input.context.actorId,
      confirmedAt,
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
      state.version,
    )
    if (update.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
    }
    const confirmation: DiagnosisConfirmation = {
      confirmedAt,
      entries: confirmedEntries.map(({ condition, entry }) => ({
        catalogItemId: entry.catalogItemId,
        code: entry.coding.code,
        conditionId: condition.id,
        conditionVersion: condition.meta?.versionId ?? '1',
        display: entry.coding.display,
        ...(entry.note === undefined ? {} : { note: entry.note }),
        role: entry.role,
        system: entry.coding.system,
      })),
      id: confirmationId,
      provenanceId,
      revisionNumber,
      ...(previousConfirmation === undefined
        ? {}
        : { supersedesConfirmationId: previousConfirmation.id }),
    }
    return {
      data: {
        confirmation,
        diagnosisVersion,
        encounterId: input.encounterId,
        encounterVersion: updatedEncounter.meta?.versionId ?? '2',
      },
      effects: [
        ...supersededConditions.map(condition => ({
          kind: 'updated' as const,
          reference: `Condition/${condition.id}`,
          versionId: condition.meta?.versionId ?? '2',
        })),
        ...confirmedEntries.map(({ condition }) => ({
          kind: 'created' as const,
          reference: `Condition/${condition.id}`,
          versionId: condition.meta?.versionId ?? '1',
        })),
        {
          kind: 'updated' as const,
          reference: `Encounter/${input.encounterId}`,
          versionId: updatedEncounter.meta?.versionId ?? '2',
        },
        {
          kind: 'created' as const,
          reference: `Provenance/${provenance.id}`,
          versionId: provenance.meta?.versionId ?? '1',
        },
        {
          kind: 'created' as const,
          reference: `DiagnosisConfirmation/${confirmationId}`,
          versionId: '1',
        },
        {
          kind: 'updated' as const,
          reference: `DiagnosisDraft/${outpatientCase.case_id}`,
          versionId: String(diagnosisVersion),
        },
      ],
    }
  }


  savePrescriptionDraft(input: Parameters<OutpatientPrescriptionService['savePrescriptionDraft']>[0]) {
    return this.#prescriptions.savePrescriptionDraft(input)
  }

  applySavePrescriptionDraft(
    transaction: CommandTransaction,
    input: Parameters<OutpatientPrescriptionService['applySavePrescriptionDraft']>[1],
  ) {
    return this.#prescriptions.applySavePrescriptionDraft(transaction, input)
  }

  deletePrescriptionDraft(input: Parameters<OutpatientPrescriptionService['deletePrescriptionDraft']>[0]) {
    return this.#prescriptions.deletePrescriptionDraft(input)
  }

  issuePrescription(input: Parameters<OutpatientPrescriptionService['issuePrescription']>[0]) {
    return this.#prescriptions.issuePrescription(input)
  }

  applyIssuePrescription(
    transaction: CommandTransaction,
    input: Parameters<OutpatientPrescriptionService['applyIssuePrescription']>[1],
  ) {
    return this.#prescriptions.applyIssuePrescription(transaction, input)
  }

  confirmNoMedication(input: Parameters<OutpatientPrescriptionService['confirmNoMedication']>[0]) {
    return this.#prescriptions.confirmNoMedication(input)
  }

  withdrawPrescription(input: Parameters<OutpatientPrescriptionService['withdrawPrescription']>[0]) {
    return this.#prescriptions.withdrawPrescription(input)
  }

  startFirstVisit(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    encounterVersion: string
    status: 'first-visit'
    taskVersion: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: startVisitResponseSchema.shape.data.extend({ status: z.literal('first-visit') }),
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.start-first-visit',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'awaiting-doctor' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting a first visit')
      }
      const transition = this.#transitionToFirstVisit(input.context, transaction, {
        caseId: outpatientCase.case_id,
        encounterId: input.encounterId,
        expectedVersions: input.expectedVersions,
        previousStatus: 'awaiting-doctor',
        queueTaskId: outpatientCase.doctor_task_id,
      })
      return {
        data: {
          encounterVersion: transition.encounterVersion,
          status: 'first-visit' as const,
          taskVersion: transition.taskVersion,
        },
        effects: transition.effects,
      }
    })
  }

  startRevisit(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    encounterVersion: string
    status: 'revisit-draft'
    taskVersion: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: startVisitResponseSchema.shape.data.extend({ status: z.literal('revisit-draft') }),
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.start-revisit',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'awaiting-revisit' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting revisit')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const task = transaction.fhir.read(input.context, 'Task', outpatientCase.doctor_task_id)
      const now = this.#context.virtualTime(input.context)
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'revisit-draft',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const updatedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'in-progress',
        executionPeriod: { start: now },
        owner: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
      }, task.meta?.versionId ?? '1')
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'revisit-draft', version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-revisit'
      `).run(now, input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      return {
        data: {
          encounterVersion: updatedEncounter.meta?.versionId ?? '6',
          status: 'revisit-draft' as const,
          taskVersion: updatedTask.meta?.versionId ?? '2',
        },
        effects: [updatedEncounter, updatedTask].map(resource => ({
          kind: 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }


  saveRevisitDraft(input: Parameters<OutpatientClinicalDocumentService['saveRevisitDraft']>[0]) {
    return this.#clinicalDocuments.saveRevisitDraft(input)
  }

  previewClinicalSign(input: Parameters<OutpatientClinicalDocumentService['previewClinicalSign']>[0]) {
    return this.#clinicalDocuments.previewClinicalSign(input)
  }

  signAndComplete(input: Parameters<OutpatientClinicalDocumentService['signAndComplete']>[0]) {
    return this.#clinicalDocuments.signAndComplete(input)
  }

  reviseClinicalDocument(input: Parameters<OutpatientClinicalDocumentService['reviseClinicalDocument']>[0]) {
    return this.#clinicalDocuments.reviseClinicalDocument(input)
  }

  saveFirstVisitDraft(input: Parameters<OutpatientClinicalDocumentService['saveFirstVisitDraft']>[0]) {
    return this.#clinicalDocuments.saveFirstVisitDraft(input)
  }

  confirmClinicalVisitKind(input: Parameters<OutpatientClinicalDocumentService['confirmClinicalVisitKind']>[0]) {
    return this.#clinicalDocuments.confirmClinicalVisitKind(input)
  }

  saveClinicalDocumentDraft(input: Parameters<OutpatientClinicalDocumentService['saveClinicalDocumentDraft']>[0]) {
    return this.#clinicalDocuments.saveClinicalDocumentDraft(input)
  }

  cancelStructuredClinicalDocumentSign(
    input: Parameters<OutpatientClinicalDocumentService['cancelStructuredClinicalDocumentSign']>[0],
  ) {
    return this.#clinicalDocuments.cancelStructuredClinicalDocumentSign(input)
  }

  previewStructuredClinicalDocumentSign(
    input: Parameters<OutpatientClinicalDocumentService['previewStructuredClinicalDocumentSign']>[0],
  ) {
    return this.#clinicalDocuments.previewStructuredClinicalDocumentSign(input)
  }

  signStructuredClinicalDocument(
    input: Parameters<OutpatientClinicalDocumentService['signStructuredClinicalDocument']>[0],
  ) {
    return this.#clinicalDocuments.signStructuredClinicalDocument(input)
  }

  saveLaboratoryRequestDraft(
    input: Parameters<OutpatientLaboratoryService['saveLaboratoryRequestDraft']>[0],
  ) {
    return this.#laboratory.saveLaboratoryRequestDraft(input)
  }

  applySaveLaboratoryRequestDraft(
    transaction: CommandTransaction,
    input: Parameters<OutpatientLaboratoryService['applySaveLaboratoryRequestDraft']>[1],
  ) {
    return this.#laboratory.applySaveLaboratoryRequestDraft(transaction, input)
  }

  deleteLaboratoryRequestDraft(
    input: Parameters<OutpatientLaboratoryService['deleteLaboratoryRequestDraft']>[0],
  ) {
    return this.#laboratory.deleteLaboratoryRequestDraft(input)
  }

  applyDeleteLaboratoryRequestDraft(
    transaction: CommandTransaction,
    input: Parameters<OutpatientLaboratoryService['applyDeleteLaboratoryRequestDraft']>[1],
  ) {
    return this.#laboratory.applyDeleteLaboratoryRequestDraft(transaction, input)
  }

  issueLaboratoryRequest(input: Parameters<OutpatientLaboratoryService['issueLaboratoryRequest']>[0]) {
    return this.#laboratory.issueLaboratoryRequest(input)
  }

  applyIssueLaboratoryRequest(
    transaction: CommandTransaction,
    input: Parameters<OutpatientLaboratoryService['applyIssueLaboratoryRequest']>[1],
  ) {
    return this.#laboratory.applyIssueLaboratoryRequest(transaction, input)
  }

  cancelLaboratoryRequest(input: Parameters<OutpatientLaboratoryService['cancelLaboratoryRequest']>[0]) {
    return this.#laboratory.cancelLaboratoryRequest(input)
  }

  acceptLaboratoryRequest(input: Parameters<OutpatientLaboratoryService['acceptLaboratoryRequest']>[0]) {
    return this.#laboratory.acceptLaboratoryRequest(input)
  }

  startLaboratoryRequest(input: Parameters<OutpatientLaboratoryService['startLaboratoryRequest']>[0]) {
    return this.#laboratory.startLaboratoryRequest(input)
  }

  reportLaboratoryRequest(input: Parameters<OutpatientLaboratoryService['reportLaboratoryRequest']>[0]) {
    return this.#laboratory.reportLaboratoryRequest(input)
  }

  failLaboratoryResultGeneration(
    input: Parameters<OutpatientLaboratoryService['failLaboratoryResultGeneration']>[0],
  ) {
    return this.#laboratory.failLaboratoryResultGeneration(input)
  }

  retryLaboratoryResultGeneration(
    input: Parameters<OutpatientLaboratoryService['retryLaboratoryResultGeneration']>[0],
  ) {
    return this.#laboratory.retryLaboratoryResultGeneration(input)
  }

  acknowledgeLaboratoryReport(
    input: Parameters<OutpatientLaboratoryService['acknowledgeLaboratoryReport']>[0],
  ) {
    return this.#laboratory.acknowledgeLaboratoryReport(input)
  }

  correctLaboratoryReport(input: Parameters<OutpatientLaboratoryService['correctLaboratoryReport']>[0]) {
    return this.#laboratory.correctLaboratoryReport(input)
  }

  issueLaboratoryOrder(input: Parameters<OutpatientLaboratoryService['issueLaboratoryOrder']>[0]) {
    return this.#laboratory.issueLaboratoryOrder(input)
  }

  billingCase(input: { context: ActorContext; caseId: string; page: number; pageSize: number }) {
    this.#context.assertRole(input.context, ['cashier'])
    const scope = [input.context.workspaceId, input.context.epoch, input.caseId]
    const row = z.object({ account_id: z.string(), encounter_id: z.string(), patient_json: z.string() }).optional().parse(
      this.#database.driver.prepare(`
        SELECT outpatient_case.account_id, outpatient_case.encounter_id, patient.content_json AS patient_json
        FROM outpatient_case JOIN fhir_resource AS patient
          ON patient.workspace_id = outpatient_case.workspace_id AND patient.epoch = outpatient_case.epoch
          AND patient.resource_type = 'Patient' AND patient.resource_id = outpatient_case.patient_id
        WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ? AND outpatient_case.case_id = ?
      `).get(...scope),
    )
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The billing case is unavailable')
    const ledger = this.#payments
    const charges = z.array(z.object({
      amountFen: z.number(), category: z.enum(['registration', 'laboratory', 'imaging', 'pathology', 'medication']),
      chargeItemId: z.string(), chargeVersion: z.number(), descriptionEn: z.string(), descriptionZh: z.string(), status: z.string(),
      sourceReference: z.string(),
    })).parse(this.#database.driver.prepare(`
      SELECT total_fen AS amountFen, category, charge_item_id AS chargeItemId, version AS chargeVersion,
        description_en AS descriptionEn, description_zh AS descriptionZh, status, source_reference AS sourceReference
      FROM charge_record AS charge
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND NOT (charge.category = 'medication' AND charge.status != 'paid' AND EXISTS (
          SELECT 1 FROM prescription_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = charge.workspace_id AND withdrawal.epoch = charge.epoch
            AND charge.source_reference = 'Prescription/' || withdrawal.prescription_id
        ))
      ORDER BY created_at, charge_id
    `).all(...scope)).map(charge => {
      const { paidFen } = ledger.balance(input.context, charge.chargeItemId)
      const insuranceFen = this.insurance.coverage(input.context, `ChargeItem/${charge.chargeItemId}`)
      const amountFen = charge.amountFen - this.refunds.adjustmentFen(input.context, charge.chargeItemId)
      const investigation = this.#outpatientBilling.readByCharge(input.context, charge.chargeItemId)
      return { ...charge, amountFen, paidFen, insuranceFen, remainingFen: Math.max(0, amountFen - paidFen - insuranceFen),
        ...(investigation === undefined ? {} : { requestId: investigation.requestId, price: investigation.billing.price,
          status: investigation.billing.status === 'cancelled' ? 'cancelled' : charge.status }) }
    })
    const { items: payments, ...paymentsPagination } = ledger.attempts(input.context, input.caseId, input.page, input.pageSize)
    return billingCaseSchema.parse({
      accountId: row.account_id, caseId: input.caseId, encounterId: row.encounter_id,
      patient: patientSummary(parseStoredFhirResource(row.patient_json)), charges,
      payments, paymentsPagination,
      totalFen: charges.reduce((sum, charge) => sum + charge.amountFen, 0),
      paidFen: charges.reduce((sum, charge) => sum + charge.paidFen, 0),
      remainingFen: charges.reduce((sum, charge) => sum + charge.remainingFen, 0),
    })
  }

  billingQueue(input: {
    category: 'laboratory' | 'imaging' | 'pathology' | 'medication'
    context: ActorContext
    page: number
    pageSize: number
    status: 'ambiguous' | 'declined' | 'paid' | 'pending'
  }) {
    this.#context.assertRole(input.context, ['cashier'])
    const statuses = [input.status === 'pending' ? 'billable' : input.status]
    const placeholders = statuses.map(() => '?').join(', ')
    const bindings = [input.context.workspaceId, input.context.epoch, input.category, ...statuses]
    const withdrawnPrescriptionFilter
      = input.category === 'medication' && input.status === 'pending'
        ? `
          AND NOT EXISTS (
            SELECT 1 FROM prescription_withdrawal AS withdrawal
            WHERE withdrawal.workspace_id = charge.workspace_id
              AND withdrawal.epoch = charge.epoch
              AND charge.source_reference = 'Prescription/' || withdrawal.prescription_id
          )
        `
        : ''
    const cancelledInvestigation = `EXISTS (
        SELECT 1 FROM outpatient_investigation_billing billing
        JOIN laboratory_request request USING(workspace_id,epoch,request_id)
        WHERE billing.workspace_id=charge.workspace_id AND billing.epoch=charge.epoch
          AND billing.charge_item_id=charge.charge_item_id AND request.status='cancelled'
      )`
    const refundChargeIds = input.status === 'paid' ? this.#outpatientBilling.pendingCancellationRefundChargeIds(input.context) : []
    const statusFilter = `AND ((charge.status IN (${placeholders}) AND NOT ${cancelledInvestigation})
      ${refundChargeIds.length === 0 ? '' : `OR charge.charge_item_id IN (${refundChargeIds.map(() => '?').join(',')})`})`
    bindings.push(...refundChargeIds)
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM charge_record AS charge
      WHERE charge.workspace_id = ? AND charge.epoch = ? AND charge.category = ?
        ${statusFilter}
        ${withdrawnPrescriptionFilter}
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT charge.*, patient.content_json AS patient_json,
        outpatient_case.encounter_id
      FROM charge_record AS charge
      JOIN outpatient_case
        ON outpatient_case.workspace_id = charge.workspace_id
       AND outpatient_case.epoch = charge.epoch
       AND outpatient_case.case_id = charge.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      WHERE charge.workspace_id = ? AND charge.epoch = ? AND charge.category = ?
        ${statusFilter}
        ${withdrawnPrescriptionFilter}
      ORDER BY charge.created_at, charge.charge_id
      LIMIT ? OFFSET ?
    `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize) as Array<{
      account_id: string
      case_id: string
      category: string
      charge_item_id: string
      description_en: string
      description_zh: string
      encounter_id: string
      patient_json: string
      quantity: number
      source_reference: string
      status: string
      total_fen: number
      unit_price_fen: number
      version: number
    }>
    return {
      items: rows.map(row => {
        const investigation = this.#outpatientBilling.readByCharge(input.context, row.charge_item_id)
        return {
        accountId: row.account_id,
        amountFen: investigation?.billing.status === 'cancelled' ? 0 : row.total_fen,
        caseId: row.case_id,
        category: row.category,
        chargeItemId: row.charge_item_id,
        chargeVersion: row.version,
        descriptionEn: row.description_en,
        descriptionZh: row.description_zh,
        encounterId: row.encounter_id,
        sourceReference: row.source_reference,
        ...(investigation === undefined ? {} : { requestId: investigation.requestId, price: investigation.billing.price }),
        lines: row.category === 'medication'
          ? this.#context.prescriptionChargeLines(input.context, row.source_reference)
          : [{
              descriptionEn: row.description_en,
              descriptionZh: row.description_zh,
              quantity: row.quantity,
              sourceReference: row.source_reference,
              subtotalFen: row.total_fen,
              unitPriceFen: row.unit_price_fen,
            }],
        patient: patientSummary(parseStoredFhirResource(row.patient_json)),
        status: investigation?.billing.status === 'cancelled' ? 'cancelled' : row.status,
      }}),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }


  pharmacyQueue(input: Parameters<OutpatientPrescriptionService['pharmacyQueue']>[0]) {
    return this.#prescriptions.pharmacyQueue(input)
  }

  reviewPrescription(input: Parameters<OutpatientPrescriptionService['reviewPrescription']>[0]) {
    return this.#prescriptions.reviewPrescription(input)
  }

  dispensePrescription(input: Parameters<OutpatientPrescriptionService['dispensePrescription']>[0]) {
    return this.#prescriptions.dispensePrescription(input)
  }

  #completeScenarioIfReady(context: ActorContext, now: string): { status: 'active' | 'completed'; effects: CommandEffect[] } {
    const remaining = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      WHERE workspace_id=? AND epoch=? AND scenario_run_id=? AND status!='completed'
    `).get(context.workspaceId, context.epoch, context.scenarioRunId))
    const inpatientWork = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT EXISTS(SELECT 1 FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND record_status!='archived')
        OR EXISTS(SELECT 1 FROM inpatient_referral WHERE workspace_id=? AND epoch=? AND status='issued') AS count
    `).get(context.workspaceId, context.epoch, context.workspaceId, context.epoch))
    if (remaining.count > 0 || inpatientWork.count > 0 || this.#outpatientBilling.hasPendingCancellationRefunds(context)) {
      return { status: 'active', effects: [] }
    }
    const updated = this.#database.driver.prepare(`
      UPDATE scenario_run SET status='completed',completed_at=?
      WHERE workspace_id=? AND epoch=? AND scenario_run_id=? AND status='active'
    `).run(now, context.workspaceId, context.epoch, context.scenarioRunId)
    return { status: 'completed', effects: updated.changes === 0 ? [] : [{
      kind: 'updated', reference: `ScenarioRun/${context.scenarioRunId}`, versionId: '2',
    }] }
  }

  previewMultiChargePayment(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    input: z.infer<typeof multiChargePaymentPreviewInputSchema>
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: multiChargePaymentPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: input.input,
      operation: 'payment.multi-charge.preview',
    }, () => {
      this.#context.assertRole(input.context, ['cashier'])
      const requested = multiChargePaymentPreviewInputSchema.parse(input.input)
      const references = requested.chargeItemIds.map(id => `ChargeItem/${id}`)
      if (Object.keys(input.expectedVersions).length !== references.length
        || references.some(reference => input.expectedVersions[reference] === undefined)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '必须逐项提供且仅提供所选费用的预期版本')
      }
      const bill = this.billingCase({ context: input.context, caseId: requested.caseId, page: 1, pageSize: 1 })
      const charges = requested.chargeItemIds.map(chargeItemId => {
        const charge = bill.charges.find(item => item.chargeItemId === chargeItemId)
        if (charge === undefined || charge.category === 'registration' || !['billable', 'declined'].includes(charge.status)
          || charge.remainingFen <= 0) throw new WorkflowError('WORKFLOW_CONFLICT', '所选费用不可收款，请刷新完整清单')
        const workflow = this.#readPaymentCharge(input.context, requested.caseId, charge.category, chargeItemId)
        if (workflow === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '原费用已不可用')
        this.#assertCollectionWorkflow(input.context, charge.category, workflow)
        if (this.#payments.balance(input.context, chargeItemId).unresolved > 0) {
          throw new WorkflowError('WORKFLOW_CONFLICT', '请先查询原未知收款或退款，不能再次收款')
        }
        return {
          chargeItemId, chargeVersion: charge.chargeVersion, category: charge.category,
          descriptionZh: charge.descriptionZh, descriptionEn: charge.descriptionEn,
          amountFen: charge.amountFen, paidFen: charge.paidFen, insuranceFen: charge.insuranceFen,
          remainingFen: charge.remainingFen, collectionAmountFen: charge.remainingFen,
        }
      })
      this.#context.assertExpectedVersions(input.expectedVersions, references)
      const remainingFen = charges.reduce((total, charge) => total + charge.remainingFen, 0)
      const tenders = paymentTendersSchema.parse(requested.tenders ?? [{ method: 'cash', amountFen: remainingFen }])
      if (tenders.reduce((total, tender) => total + tender.amountFen, 0) !== remainingFen) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '组合支付合计必须等于全部所选费用的剩余应收')
      }
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#context.hashToken(previewId)}`
      const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString()
      const data = multiChargePaymentPreviewResponseSchema.shape.data.parse({
        amountFen: remainingFen, caseId: bill.caseId, patientId: bill.patient.id, encounterId: bill.encounterId,
        charges, channel: 'synthetic-payment', commitToken,
        expectedOutcome: paymentChannelPlan(this.#database, input.context, requested.simulatorRule).outcome,
        expiresAt, previewId, tenders, remainingFen,
        totalFen: charges.reduce((total, charge) => total + charge.amountFen, 0),
        paidFen: charges.reduce((total, charge) => total + charge.paidFen, 0),
        insuranceFen: charges.reduce((total, charge) => total + charge.insuranceFen, 0),
      })
      this.#database.driver.prepare(`INSERT INTO multi_charge_payment_preview (
        workspace_id,epoch,preview_id,case_id,patient_id,encounter_id,actor_context_json,
        expected_versions_json,snapshot_json,simulator_rule,token_hash,expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.context.workspaceId, input.context.epoch, previewId, bill.caseId, bill.patient.id, bill.encounterId,
        JSON.stringify(input.context), JSON.stringify(input.expectedVersions), JSON.stringify(data),
        requested.simulatorRule, this.#context.hashToken(commitToken), expiresAt,
      )
      return { data, effects: [{ kind: 'created', reference: `MultiChargePaymentPreview/${previewId}`, versionId: '1' }] }
    })
  }

  #readMultiChargePreview(context: ActorContext, previewId: string) {
    const row = z.object({ actor_context_json: z.string(), snapshot_json: z.string(), token_hash: z.string(),
      simulator_rule: paymentSimulatorRuleSchema, expires_at: z.string(), consumed_at: z.string().nullable() }).optional().parse(
      this.#database.driver.prepare('SELECT * FROM multi_charge_payment_preview WHERE workspace_id=? AND epoch=? AND preview_id=?')
        .get(context.workspaceId, context.epoch, previewId))
    return row === undefined ? undefined : { ...row, snapshot: multiChargePaymentPreviewResponseSchema.shape.data.parse(JSON.parse(row.snapshot_json)) }
  }

  #exactPaymentVersions(expectedVersions: Record<string, string>, chargeItemIds: string[]) {
    const references = chargeItemIds.map(id => `ChargeItem/${id}`)
    if (Object.keys(expectedVersions).length !== references.length || references.some(reference => expectedVersions[reference] === undefined)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '必须逐项提供且仅提供原交易全部费用的预期版本')
    }
  }

  #multiPaymentCharges(context: ActorContext, snapshot: z.infer<typeof multiChargePaymentPreviewResponseSchema>['data']) {
    const owner = z.object({ patient_id: z.string(), encounter_id: z.string(), prescription_id: z.string().nullable(),
      service_request_id: z.string().nullable() }).optional().parse(this.#database.driver.prepare(`
      SELECT patient_id,encounter_id,prescription_id,service_request_id FROM outpatient_case
      WHERE workspace_id=? AND epoch=? AND case_id=?`).get(context.workspaceId, context.epoch, snapshot.caseId))
    if (owner === undefined || owner.patient_id !== snapshot.patientId || owner.encounter_id !== snapshot.encounterId) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '原收款就诊归属已变化')
    }
    return snapshot.charges.map(frozen => {
      const charge = this.#readPaymentCharge(context, snapshot.caseId, frozen.category, frozen.chargeItemId)
      if (charge === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '原收款费用已不可用')
      return { ...charge, ...owner, case_id: snapshot.caseId, category: frozen.category,
        charge_version: charge.version, current_amount_fen: charge.total_fen }
    })
  }

  #multiPaymentData(context: ActorContext, paymentId: string, snapshot: z.infer<typeof multiChargePaymentPreviewResponseSchema>['data']) {
    const payment = this.#collections.attempt(context, paymentId)!
    const charges = this.#multiPaymentCharges(context, snapshot)
    return multiChargePaymentResponseSchema.shape.data.parse({ kind: 'multi-charge', paymentId, version: payment.version,
      caseId: snapshot.caseId, patientId: payment.patientId, encounterId: payment.encounterId,
      amountFen: payment.amountFen, outcome: payment.outcome, tenders: this.#collections.tenders(context, paymentId),
      allocations: charges.map((charge, index) => ({ chargeItemId: charge.charge_item_id,
        amountFen: snapshot.charges[index]!.collectionAmountFen, chargeVersion: charge.version,
        remainingFen: this.#remainingPaymentFen(context, charge), status: charge.status })),
    })
  }

  confirmMultiChargePayment(input: { context: ActorContext; expectedVersions: Record<string, string>; idempotencyKey: string; previewId: string; commitToken: string }) {
    return this.#commands.execute({ context: input.context, dataSchema: multiChargePaymentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions, idempotencyKey: input.idempotencyKey,
      input: { previewId: input.previewId, commitToken: input.commitToken }, operation: 'payment.multi-charge.confirm',
    }, transaction => {
      this.#context.assertRole(input.context, ['cashier'])
      const preview = this.#readMultiChargePreview(input.context, input.previewId)
      if (preview === undefined || preview.consumed_at !== null || preview.token_hash !== this.#context.hashToken(input.commitToken)
        || preview.actor_context_json !== JSON.stringify(input.context) || Date.parse(preview.expires_at) <= this.#now().getTime()) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '合并收款预览失效，请重新预览')
      }
      const { snapshot } = preview
      this.#exactPaymentVersions(input.expectedVersions, snapshot.charges.map(charge => charge.chargeItemId))
      const charges = this.#multiPaymentCharges(input.context, snapshot)
      charges.forEach((charge, index) => {
        const frozen = snapshot.charges[index]!
        const balance = this.#payments.balance(input.context, charge.charge_item_id)
        const insuranceFen = this.insurance.coverage(input.context, `ChargeItem/${charge.charge_item_id}`)
        if (!['billable', 'declined'].includes(charge.status) || balance.unresolved > 0
          || input.expectedVersions[`ChargeItem/${charge.charge_item_id}`] !== String(frozen.chargeVersion)
          || charge.version !== frozen.chargeVersion || charge.total_fen !== frozen.amountFen || balance.paidFen !== frozen.paidFen
          || insuranceFen !== frozen.insuranceFen || charge.total_fen - balance.paidFen - insuranceFen !== frozen.collectionAmountFen) {
          throw new WorkflowError('WORKFLOW_CONFLICT', '逐项费用、资金或医保已变化，请重新预览合并收款')
        }
        this.#assertCollectionWorkflow(input.context, charge.category, charge)
      })
      if (snapshot.charges.reduce((sum, item) => sum + item.collectionAmountFen, 0) !== snapshot.amountFen) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '分配金额与整笔收款不一致')
      }
      const now = this.#context.virtualTime(input.context)
      const payment = this.#collections.create(input.context, { owner: { kind: 'outpatient', id: snapshot.caseId },
        purpose: 'outpatient-charge', previewId: input.previewId, amountFen: snapshot.amountFen,
        tenders: snapshot.tenders, simulatorRule: preview.simulator_rule, createdAt: now })
      snapshot.charges.forEach((charge, position) => this.#payments.allocate(input.context, payment.paymentId, snapshot.caseId,
        charge.chargeItemId, charge.collectionAmountFen, position))
      this.#database.driver.prepare('UPDATE multi_charge_payment_preview SET consumed_at=? WHERE workspace_id=? AND epoch=? AND preview_id=?')
        .run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      const effects: CommandEffect[] = [{ kind: 'created', reference: `PaymentTransaction/${payment.paymentId}`, versionId: '1' }]
      for (const charge of charges) this.#applyPaymentOutcome(transaction, input.context, charge, payment.outcome, effects)
      return { data: this.#multiPaymentData(input.context, payment.paymentId, snapshot), effects }
    })
  }

  recoverMultiChargePayment(input: { context: ActorContext; expectedVersions: Record<string, string>; idempotencyKey: string; paymentId: string; expectedPaymentVersion: number }) {
    return this.#commands.execute({ context: input.context, dataSchema: multiChargePaymentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions, idempotencyKey: input.idempotencyKey,
      input: { paymentId: input.paymentId, expectedPaymentVersion: input.expectedPaymentVersion }, operation: 'payment.multi-charge.recover',
    }, transaction => {
      this.#context.assertRole(input.context, ['cashier'])
      const attempt = this.#payments.attempt(input.context, input.paymentId)
      if (attempt === undefined || attempt.allocations.length < 2) throw new WorkflowError('WORKFLOW_CONFLICT', '原合并收款不存在')
      const preview = this.#readMultiChargePreview(input.context, attempt.previewId)
      if (preview === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '原合并收款分配不可用')
      this.#exactPaymentVersions(input.expectedVersions, attempt.allocations.map(item => item.chargeItemId))
      const charges = this.#multiPaymentCharges(input.context, preview.snapshot)
      if (attempt.outcome === 'ambiguous') for (const charge of charges) {
        if (charge.status !== 'ambiguous') throw new WorkflowError('WORKFLOW_CONFLICT', '原合并收款费用已变化')
        this.#assertCollectionWorkflow(input.context, charge.category, charge)
      }
      const recovered = this.#collections.recover(input.context, input.paymentId, input.expectedPaymentVersion, this.#context.virtualTime(input.context))
      const effects: CommandEffect[] = []
      if (recovered.changed) {
        effects.push({ kind: 'created', reference: `PaymentResolution/${input.paymentId}`, versionId: '1' })
        for (const charge of charges) this.#applyPaymentOutcome(transaction, input.context, charge, recovered.payment.outcome, effects)
      }
      return { data: this.#multiPaymentData(input.context, input.paymentId, preview.snapshot), effects }
    })
  }

  #readPaymentCharge(context: ActorContext, caseId: string, category: 'laboratory' | 'imaging' | 'pathology' | 'medication', chargeItemId: string) {
    return paymentChargeRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT charge.charge_id, charge.charge_item_id, charge.total_fen - COALESCE((SELECT SUM(adjustment.amount_fen)
        FROM financial_charge_adjustment adjustment WHERE adjustment.workspace_id=charge.workspace_id AND adjustment.epoch=charge.epoch
          AND adjustment.charge_item_id=charge.charge_item_id),0) AS total_fen,
        charge.version,charge.status,outpatient_case.status AS case_status,outpatient_case.encounter_id,
        prescription.status AS prescription_status,withdrawal.withdrawal_id
      FROM charge_record AS charge JOIN outpatient_case USING(workspace_id,epoch,case_id)
      LEFT JOIN prescription ON prescription.workspace_id=charge.workspace_id AND prescription.epoch=charge.epoch
        AND prescription.prescription_id=outpatient_case.prescription_id
      LEFT JOIN prescription_withdrawal AS withdrawal ON withdrawal.workspace_id=prescription.workspace_id
        AND withdrawal.epoch=prescription.epoch AND withdrawal.prescription_id=prescription.prescription_id
      WHERE charge.workspace_id=? AND charge.epoch=? AND charge.case_id=? AND charge.category=? AND charge.charge_item_id=?
    `).get(context.workspaceId, context.epoch, caseId, category, chargeItemId))
  }

  previewPayment(input: {
    category: 'laboratory' | 'imaging' | 'pathology' | 'medication'
    chargeItemId?: string | undefined
    caseId: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    simulatorRule: z.infer<typeof paymentSimulatorRuleSchema>
    tenders?: z.infer<typeof paymentTendersSchema> | undefined
  }): CommandResponse<{
    allocations: Array<{
      amountFen: number
      chargeItemId: string
    }>
    amountFen: number
    channel: 'synthetic-payment'
    chargeItemId: string
    chargeVersion: number
    commitToken: string
    expectedOutcome: 'ambiguous' | 'declined' | 'success'
    expiresAt: string
    previewId: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: paymentPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        caseId: input.caseId,
        category: input.category,
        ...(input.chargeItemId === undefined ? {} : { chargeItemId: input.chargeItemId }),
        simulatorRule: input.simulatorRule,
        tenders: input.tenders,
      },
      operation: 'payment.preview',
    }, () => {
      this.#context.assertRole(input.context, ['cashier'])
      const targets = Object.keys(input.expectedVersions).filter(reference => reference.startsWith('ChargeItem/'))
      const chargeItemId = input.chargeItemId ?? targets[0]?.slice('ChargeItem/'.length)
      if (targets.length !== 1 || chargeItemId === undefined || targets[0] !== `ChargeItem/${chargeItemId}`) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '必须指定与预期版本一致的原费用')
      }
      const charge = this.#readPaymentCharge(input.context, input.caseId, input.category, chargeItemId)
      if (charge === undefined || !['billable', 'declined'].includes(charge.status)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The charge is not available for payment')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`ChargeItem/${charge.charge_item_id}`])
      this.#assertCollectionWorkflow(input.context, input.category, charge)
      const balance = this.#payments.balance(input.context, charge.charge_item_id)
      if (balance.unresolved > 0) throw new WorkflowError('WORKFLOW_CONFLICT', 'Resolve the original unknown collection or refund before collecting again')
      const remainingFen = charge.total_fen - balance.paidFen - this.insurance.coverage(input.context, `ChargeItem/${charge.charge_item_id}`)
      const tenders = paymentRecordedTendersSchema.parse(input.tenders ?? [{ method: 'cash', amountFen: remainingFen }])
      const amountFen = tenders.reduce((sum, tender) => sum + tender.amountFen, 0)
      if (amountFen > remainingFen) throw new WorkflowError('WORKFLOW_CONFLICT', 'Payment exceeds the remaining receivable')
      const rule = paymentChannelPlan(this.#database, input.context, input.simulatorRule)
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#context.hashToken(previewId)}`
      const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString()
      this.#database.driver.prepare(`
        INSERT INTO payment_preview (
          workspace_id, epoch, preview_id, case_id, category, amount_fen,
          expected_charge_version, simulator_rule, token_hash, expires_at, tenders_json, actor_context_hash, charge_item_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        input.caseId,
        input.category,
        amountFen,
        charge.version,
        input.simulatorRule,
        this.#context.hashToken(commitToken),
        expiresAt,
        JSON.stringify(tenders),
        this.#context.actorContextHash(input.context),
        charge.charge_item_id,
      )
      return {
        data: {
          allocations: [{
            amountFen,
            chargeItemId: charge.charge_item_id,
          }],
          amountFen,
          tenders,
          paidFen: balance.paidFen,
          remainingFen,
          channel: 'synthetic-payment',
          chargeItemId: charge.charge_item_id,
          chargeVersion: charge.version,
          commitToken,
          expectedOutcome: rule.outcome,
          expiresAt,
          previewId,
        },
        effects: [{
          kind: 'created',
          reference: `PaymentPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  #readPaymentPreview(context: ActorContext, previewId: string) {
    return paymentPreviewRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT preview.*, charge.charge_id, charge.charge_item_id,
            charge.status AS charge_status, charge.version AS charge_version,
            charge.total_fen - COALESCE((SELECT SUM(adjustment.amount_fen) FROM financial_charge_adjustment adjustment
              WHERE adjustment.workspace_id=charge.workspace_id AND adjustment.epoch=charge.epoch
                AND adjustment.charge_item_id=charge.charge_item_id),0) AS current_amount_fen,
            outpatient_case.patient_id, outpatient_case.encounter_id,
            outpatient_case.account_id, outpatient_case.service_request_id,
            outpatient_case.prescription_id, outpatient_case.status AS case_status,
            prescription.status AS prescription_status,
            withdrawal.withdrawal_id
          FROM payment_preview AS preview
          JOIN charge_record AS charge
            ON charge.workspace_id = preview.workspace_id
           AND charge.epoch = preview.epoch
           AND charge.case_id = preview.case_id
           AND charge.category = preview.category
           AND charge.charge_item_id = preview.charge_item_id
          JOIN outpatient_case
            ON outpatient_case.workspace_id = preview.workspace_id
           AND outpatient_case.epoch = preview.epoch
           AND outpatient_case.case_id = preview.case_id
          LEFT JOIN prescription
            ON prescription.workspace_id = outpatient_case.workspace_id
           AND prescription.epoch = outpatient_case.epoch
           AND prescription.prescription_id = outpatient_case.prescription_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE preview.workspace_id = ? AND preview.epoch = ? AND preview.preview_id = ?
        `).get(context.workspaceId, context.epoch, previewId),
      )
  }

  confirmPayment(input: {
    commitToken: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    amountFen: number
    outcome: 'ambiguous' | 'declined' | 'success'
    paymentId: string
    remainingFen?: number | undefined
    status: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: paymentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { commitToken: input.commitToken, previewId: input.previewId },
      operation: 'payment.confirm',
    }, transaction => {
      this.#context.assertRole(input.context, ['cashier'])
      const preview = this.#readPaymentPreview(input.context, input.previewId)
      if (preview === undefined || preview.consumed_at !== null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview is unavailable')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`ChargeItem/${preview.charge_item_id}`])
      if (preview.token_hash !== this.#context.hashToken(input.commitToken)
        || preview.actor_context_hash !== this.#context.actorContextHash(input.context)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment commit token is invalid')
      }
      if (Date.parse(preview.expires_at) <= this.#now().getTime()) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview has expired')
      }
      if (!['billable', 'declined'].includes(preview.charge_status)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The charge is no longer payable')
      }
      const ledger = this.#payments
      const balance = ledger.balance(input.context, preview.charge_item_id)
      if (
        preview.charge_version !== preview.expected_charge_version
        || preview.amount_fen > preview.current_amount_fen - balance.paidFen - this.insurance.coverage(input.context, `ChargeItem/${preview.charge_item_id}`)
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview no longer matches the charge')
      }
      this.#assertCollectionWorkflow(input.context, preview.category, preview)
      if (balance.unresolved > 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Resolve the original unknown collection or refund before collecting again')
      }
      const tenders = paymentRecordedTendersSchema.parse(preview.tenders_json === null
        ? [{ method: 'cash', amountFen: preview.amount_fen }] : JSON.parse(preview.tenders_json))
      if (tenders.reduce((sum, tender) => sum + tender.amountFen, 0) !== preview.amount_fen) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Payment methods do not match the reviewed amount')
      }
      const now = this.#context.virtualTime(input.context)
      const payment = this.#collections.create(input.context, {
        owner: { kind: 'outpatient', id: preview.case_id }, purpose: 'outpatient-charge', previewId: input.previewId,
        amountFen: preview.amount_fen, tenders, simulatorRule: paymentSimulatorRuleSchema.parse(preview.simulator_rule), createdAt: now,
      })
      const { paymentId, outcome } = payment
      ledger.allocate(input.context, paymentId, preview.case_id, preview.charge_item_id, preview.amount_fen)
      this.#database.driver.prepare(`
        UPDATE payment_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      const effects: CommandEffect[] = [{
        kind: 'created' as const,
        reference: `PaymentTransaction/${paymentId}`,
        versionId: '1',
      }]
      const status = this.#applyPaymentOutcome(transaction, input.context, preview, outcome, effects)
      return {
        data: {
          amountFen: preview.amount_fen,
          outcome,
          paymentId,
          remainingFen: this.#remainingPaymentFen(input.context, preview),
          status,
        },
        effects,
      }
    })
  }

  recoverPayment(input: {
    context: ActorContext
    expectedPaymentVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    paymentId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: paymentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { paymentId: input.paymentId, expectedPaymentVersion: input.expectedPaymentVersion },
      operation: 'payment.recover',
    }, transaction => {
      this.#context.assertRole(input.context, ['cashier'])
      const attempt = this.#payments.attempt(input.context, input.paymentId)
      if (attempt === undefined || attempt.allocations.length !== 1) throw new WorkflowError('WORKFLOW_CONFLICT', '请使用合并收款恢复入口查询原多费用交易')
      const chargeItemId = attempt.allocations[0]!.chargeItemId
      const preview = this.#readPaymentPreview(input.context, attempt.previewId)
      if (preview === undefined || attempt.version !== input.expectedPaymentVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The original payment version has changed; refresh the bill')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`ChargeItem/${chargeItemId}`])
      if (attempt.outcome === 'ambiguous' && preview.charge_status !== 'ambiguous') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The original receivable is no longer recoverable')
      }
      if (attempt.outcome === 'ambiguous') this.#assertCollectionWorkflow(input.context, preview.category, preview)
      const recovered = this.#collections.recover(input.context, input.paymentId, input.expectedPaymentVersion, this.#context.virtualTime(input.context))
      if (!recovered.changed) {
        return { data: { amountFen: attempt.amountFen, outcome: recovered.payment.outcome, paymentId: input.paymentId,
          remainingFen: this.#remainingPaymentFen(input.context, preview), status: preview.case_status }, effects: [] }
      }
      const effects: CommandEffect[] = [{ kind: 'created', reference: `PaymentResolution/${input.paymentId}`, versionId: '1' }]
      const status = this.#applyPaymentOutcome(transaction, input.context, preview, recovered.payment.outcome, effects)
      return { data: { amountFen: attempt.amountFen, outcome: recovered.payment.outcome, paymentId: input.paymentId,
        remainingFen: this.#remainingPaymentFen(input.context, preview), status }, effects }
    })
  }

  #remainingPaymentFen(context: ActorContext, charge: { charge_item_id: string; current_amount_fen: number }): number {
    return Math.max(0, charge.current_amount_fen - this.#payments.balance(context, charge.charge_item_id).paidFen
      - this.insurance.coverage(context, `ChargeItem/${charge.charge_item_id}`))
  }

  #assertCollectionWorkflow(
    context: ActorContext,
    category: 'laboratory' | 'imaging' | 'pathology' | 'medication',
    charge: Pick<z.infer<typeof paymentChargeRowSchema>, 'charge_item_id' | 'case_status' | 'encounter_id' | 'prescription_status' | 'withdrawal_id'>,
  ): void {
    const investigation = this.#outpatientBilling.readByCharge(context, charge.charge_item_id)
    if (investigation !== undefined) {
      if (investigation.billing.status === 'cancelled') throw new WorkflowError('WORKFLOW_CONFLICT', '原检查已取消，不能再次收款')
      return
    }
    const compensated = this.insurance.hadCompensation(context, `ChargeItem/${charge.charge_item_id}`)
    if ((category === 'laboratory' && charge.case_status !== 'awaiting-lab-payment' && !compensated)
      || (category === 'medication' && (this.#fhir.read(context, 'Encounter', charge.encounter_id).status !== 'completed'
        || (charge.prescription_status !== 'signed' && !compensated) || charge.withdrawal_id !== null))
      || category === 'imaging' || category === 'pathology') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical workflow is not ready for this payment')
    }
  }

  #applyPaymentOutcome(
    transaction: CommandTransaction,
    context: ActorContext,
    charge: Pick<z.infer<typeof paymentPreviewRowSchema>, 'charge_id' | 'charge_item_id' | 'current_amount_fen' | 'charge_version' | 'category' | 'case_id' | 'case_status' | 'patient_id' | 'encounter_id' | 'prescription_id' | 'service_request_id'>,
    outcome: 'ambiguous' | 'declined' | 'success',
    effects: CommandEffect[],
  ): string {
    const balance = this.#payments.balance(context, charge.charge_item_id)
    const fullyPaid = outcome === 'success' && balance.unresolved === 0
      && balance.paidFen + this.insurance.coverage(context, `ChargeItem/${charge.charge_item_id}`) === charge.current_amount_fen
    const chargeItem = transaction.fhir.read(context, 'ChargeItem', charge.charge_item_id)
    const updated = transaction.fhir.update(context, { ...chargeItem, status: fullyPaid ? 'billed' : 'billable' }, chargeItem.meta?.versionId ?? '1')
    effects.push({ kind: 'updated', reference: `ChargeItem/${charge.charge_item_id}`, versionId: updated.meta?.versionId ?? String(charge.charge_version + 1) })
    this.#database.driver.prepare(`
      UPDATE charge_record SET status = ?, version = version + 1
      WHERE workspace_id = ? AND epoch = ? AND charge_id = ?
    `).run(fullyPaid ? 'paid' : outcome === 'success' ? 'billable' : outcome, context.workspaceId, context.epoch, charge.charge_id)
    if (this.#outpatientBilling.enqueueIfPaid(transaction, context, charge.charge_item_id)) return charge.case_status
    if (!fullyPaid) return charge.case_status
    if (charge.category === 'laboratory' && charge.case_status !== 'awaiting-lab-payment') return charge.case_status
    if (charge.category === 'medication' && ['awaiting-dispense', 'completed'].includes(charge.case_status)) return charge.case_status
    const status = charge.category === 'laboratory' ? 'awaiting-lis' : 'awaiting-dispense'
    this.#database.driver.prepare(`
      UPDATE outpatient_case SET status = ?, version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(status, this.#context.virtualTime(context), context.workspaceId, context.epoch, charge.case_id)
    if (charge.category === 'laboratory') {
      transaction.enqueue({ dedupKey: `lis:${charge.service_request_id}`, kind: 'lis.process-order', payload: {
        caseId: charge.case_id, encounterId: charge.encounter_id, patientId: charge.patient_id, serviceRequestId: charge.service_request_id,
      } })
    } else {
      this.#database.driver.prepare(`UPDATE prescription SET status = 'paid', version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
      `).run(context.workspaceId, context.epoch, charge.prescription_id)
      transaction.enqueue({ dedupKey: `pharmacy:${charge.prescription_id}`, kind: 'pharmacy.ready', payload: {
        caseId: charge.case_id, prescriptionId: charge.prescription_id,
      } })
    }
    return status
  }

  processLisOrder(input: Parameters<OutpatientLaboratoryService['processLisOrder']>[0]) {
    return this.#laboratory.processLisOrder(input)
  }

  inpatientLaboratoryRequests(context: ActorContext, admissionId: string) {
    return this.#laboratory.inpatientLaboratoryRequests(context, admissionId)
  }

  #isRegistrationLocation(resource: FhirResource): boolean {
    if (resource.resourceType !== 'Location' || resource.status !== 'active') return false
    if (!Array.isArray(resource.type)) return false
    return resource.type.some(type => {
      if (typeof type !== 'object' || type === null) return false
      const coding = (type as Record<string, unknown>).coding
      return Array.isArray(coding) && coding.some(candidate => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as Record<string, unknown>).code === 'outpatient-registration'
      ))
    })
  }

  #transitionToFirstVisit(
    context: ActorContext,
    transaction: CommandTransaction,
    input: {
      caseId: string
      encounterId: string
      expectedVersions: Record<string, string>
      previousStatus: 'awaiting-doctor' | 'awaiting-triage'
      queueTaskId: string
    },
  ) {
    const encounterReference = `Encounter/${input.encounterId}`
    const taskReference = `Task/${input.queueTaskId}`
    this.#context.assertExpectedVersions(input.expectedVersions, [encounterReference, taskReference])
    const encounter = transaction.fhir.read(context, 'Encounter', input.encounterId)
    const task = transaction.fhir.read(context, 'Task', input.queueTaskId)
    const now = this.#context.virtualTime(context)
    const updatedEncounter = transaction.fhir.update(context, {
      ...encounter,
      status: 'in-progress',
      extension: [
        ...(Array.isArray(encounter.extension) ? encounter.extension : []),
        {
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
          valueCode: 'first-visit',
        },
      ],
    }, encounter.meta?.versionId ?? '1')
    const updatedTask = transaction.fhir.update(context, {
      ...task,
      code: { text: 'Outpatient consultation' },
      status: 'in-progress',
      executionPeriod: { start: now },
      owner: { reference: `PractitionerRole/${context.practitionerRoleId}` },
    }, task.meta?.versionId ?? '1')
    const updateCase = this.#database.driver.prepare(`
      UPDATE outpatient_case
      SET doctor_task_id = ?, status = 'first-visit', version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = ?
    `).run(
      input.queueTaskId,
      now,
      context.workspaceId,
      context.epoch,
      input.caseId,
      input.previousStatus,
    )
    if (updateCase.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case state has changed')
    }
    this.#context.assignCaseResponsibility(context, input.caseId, now)
    this.consultationRecording.bindDoctorContext(context, input.caseId)
    this.#database.driver.prepare(`
      UPDATE registration SET status = 'in-progress'
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(context.workspaceId, context.epoch, input.caseId)
    return {
      effects: [updatedEncounter, updatedTask].map(resource => ({
        kind: 'updated' as const,
        reference: `${resource.resourceType}/${resource.id}`,
        versionId: resource.meta?.versionId ?? '1',
      })),
      encounterVersion: updatedEncounter.meta?.versionId ?? '1',
      taskVersion: updatedTask.meta?.versionId ?? '1',
    }
  }

  #createConsultation(context: ActorContext, caseId: string): void {
    this.#database.driver.prepare(`
      INSERT INTO consultation (workspace_id, epoch, case_id, version)
      VALUES (?, ?, ?, 1)
    `).run(context.workspaceId, context.epoch, caseId)
    this.consultationRecording.create(context, caseId)
  }

  #insertConsultationTurn(
    context: ActorContext,
    caseId: string,
    input: {
      expectedVersion: number
      kind: 'text' | 'report-card'
      message: string
      personaRevision?: number
      reportReference?: string
      source: ConsultationTurnDto['source']
      speaker: ConsultationTurnDto['speaker']
    },
  ): { consultationVersion: number; turn: ConsultationTurnDto } {
    const state = this.#context.consultationState(context, caseId)
    if (state === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record is unavailable')
    }
    if (state.version !== input.expectedVersion) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record version has changed')
    }
    const turnId = uuidv7()
    const recordedAt = this.#context.virtualTime(context)
    const sequence = state.version
    const consultationVersion = state.version + 1
    this.#database.driver.prepare(`
      INSERT INTO consultation_turn (
        workspace_id, epoch, turn_id, case_id, sequence,
        speaker, kind, source, message_text,
        persona_revision, report_reference, actor_id, practitioner_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      turnId,
      caseId,
      sequence,
      input.speaker,
      input.kind,
      input.source,
      input.message,
      input.personaRevision ?? null,
      input.reportReference ?? null,
      context.actorId,
      context.practitionerId ?? null,
      recordedAt,
    )
    const update = this.#database.driver.prepare(`
      UPDATE consultation SET version = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
    `).run(
      consultationVersion,
      context.workspaceId,
      context.epoch,
      caseId,
      state.version,
    )
    if (update.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record version has changed')
    }
    return {
      consultationVersion,
      turn: {
        actorId: context.actorId,
        practitionerId: context.practitionerId ?? null,
        id: turnId,
        kind: input.kind,
        messageText: input.message,
        personaRevision: input.personaRevision ?? null,
        recordedAt,
        reportReference: input.reportReference ?? null,
        sequence,
        source: input.source,
        speaker: input.speaker,
      },
    }
  }

  #appendPersonaOpeningTurn(
    context: ActorContext,
    caseId: string,
    persona: { content: PatientPersonaRevisionContent; revision: number },
  ): void {
    const state = this.#context.consultationState(context, caseId)
    if (state === undefined) return
    const existing = this.#database.driver.prepare(`
      SELECT 1 AS present FROM consultation_turn
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      LIMIT 1
    `).get(context.workspaceId, context.epoch, caseId)
    if (existing !== undefined) return
    this.#insertConsultationTurn(context, caseId, {
      expectedVersion: state.version,
      kind: 'text',
      message: persona.content.openingStatement,
      personaRevision: persona.revision,
      source: 'persona-opening',
      speaker: 'patient',
    })
  }

  #appendReportCardTurn(
    transaction: CommandTransaction,
    context: ActorContext,
    caseId: string,
    input: { reportName: string; reportReference: string },
  ): void {
    if (inpatientRequestOwner(this.#database,context,caseId) !== undefined) return
    this.#recordPublishedReport(transaction, context, caseId, input.reportReference)
    const state = this.#context.consultationState(context, caseId)
    if (state === undefined) return
    this.#insertConsultationTurn(context, caseId, {
      expectedVersion: state.version,
      kind: 'report-card',
      message: input.reportName,
      reportReference: input.reportReference,
      source: 'report-card',
      speaker: 'patient',
    })
  }

  #recordPublishedReport(transaction: CommandTransaction, context: ActorContext, caseId: string, reportReference: string): void {
    if (inpatientRequestOwner(this.#database,context,caseId) !== undefined) return
    const parsed = /^DiagnosticReport\/([A-Za-z0-9.-]+)\/_history\/(\d+)$/u.exec(reportReference)
    if (parsed === null) throw new Error('The published report reference must contain a fixed version')
    const report = z.object({ status: z.enum(['final', 'amended', 'corrected']),
      category: z.array(z.object({ coding: z.array(z.object({ code: z.string().optional() })).optional() })).optional(),
      encounter: z.object({ reference: z.string() }), subject: z.object({ reference: z.string() }),
      conclusion: z.string().optional(), code: z.object({ text: z.string().optional() }).optional(),
      result: z.array(z.object({ reference: z.string() })).optional(), issued: z.string(),
    }).parse(transaction.fhir.vread(context, 'DiagnosticReport', parsed[1]!, parsed[2]!))
    const outpatientCase = z.object({ encounter_id: z.string(), patient_id: z.string() }).parse(
      this.#database.driver.prepare(`SELECT encounter_id, patient_id FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?`).get(context.workspaceId, context.epoch, caseId))
    if (report.encounter.reference !== `Encounter/${outpatientCase.encounter_id}` || report.subject.reference !== `Patient/${outpatientCase.patient_id}`) {
      throw new Error('The published report does not belong to the recording case')
    }
    const observations = (report.result ?? []).map(result => {
      const match = /^Observation\/([A-Za-z0-9.-]+)$/u.exec(result.reference)
      if (match === null) throw new Error('The published report result must reference a local Observation')
      const observation = z.object({ code: z.object({ text: z.string().optional(), coding: z.array(z.object({ display: z.string().optional() })).optional() }),
        valueQuantity: z.object({ value: z.number(), unit: z.string().optional() }).optional(),
        valueString: z.string().optional(), valueCodeableConcept: z.object({ text: z.string().optional(), coding: z.array(z.object({ display: z.string().optional() })).optional() }).optional(),
        valueBoolean: z.boolean().optional(),
      }).parse(transaction.fhir.read(context, 'Observation', match[1]!))
      const name = observation.code.text ?? observation.code.coding?.[0]?.display ?? result.reference
      const value = observation.valueQuantity === undefined ? observation.valueString
        ?? observation.valueCodeableConcept?.text ?? observation.valueCodeableConcept?.coding?.[0]?.display
        ?? observation.valueBoolean?.toString()
        : `${observation.valueQuantity.value}${observation.valueQuantity.unit === undefined ? '' : ` ${observation.valueQuantity.unit}`}`
      if (value === undefined) throw new Error('The published report result has no supported value')
      return `${name}：${value}。`
    })
    const categories = report.category?.flatMap(category => category.coding?.map(coding => coding.code) ?? []) ?? []
    const published = categories.includes('RAD') ? this.imaging.publishedReportText(context, caseId, parsed[1]!)
      : categories.includes('SP') ? this.pathology.publishedReportText(context, caseId, parsed[1]!) : undefined
    const messageText = [report.code?.text, published?.text ?? report.conclusion, ...observations].filter(Boolean).join('\n')
    if (report.conclusion === undefined && observations.length === 0) throw new Error('The published report contains no recordable facts')
    this.consultationRecording.enqueueReport(context, transaction, { caseId, encounterId: outpatientCase.encounter_id,
      messageText, recordedAt: report.issued, reportReference,
      ...(published === undefined ? {} : { reportContentHash: published.reportContentHash }) })
  }

  #prepareRecordingReports(transaction: CommandTransaction, context: ActorContext, caseId: string): void {
    const reports = z.array(z.object({ diagnostic_report_id: z.string() })).parse(this.#database.driver.prepare(`
      SELECT diagnostic_report_id FROM laboratory_request WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND diagnostic_report_id IS NOT NULL
      UNION SELECT diagnostic_report_id FROM outpatient_case WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND diagnostic_report_id IS NOT NULL
    `).all(context.workspaceId, context.epoch, caseId, context.workspaceId, context.epoch, caseId))
    const saved = new Set(this.consultationRecording.read(context, caseId)?.sources?.map(source => source.reportReference))
    for (const report of reports) {
      const resource = transaction.fhir.read(context, 'DiagnosticReport', report.diagnostic_report_id)
      const reference = `DiagnosticReport/${report.diagnostic_report_id}/_history/${resource.meta?.versionId ?? '1'}`
      if (!saved.has(reference)) this.#recordPublishedReport(transaction, context, caseId, reference)
    }
  }

  caseIdByEncounter(context: ActorContext, encounterId: string): string {
    this.#context.assertRole(context, ['outpatient-doctor'])
    return this.#context.caseByEncounter(context, encounterId).case_id
  }

  authorizeConsultation(context: ActorContext, encounterId: string, doctorSequence?: number): string {
    this.#context.assertRole(context, ['outpatient-doctor'])
    new WorkspaceRepository(this.#database).assertActive(context, context.scenarioRunId)
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    if (outpatientCase.status !== 'awaiting-doctor') this.#context.assertCaseResponsibility(context, outpatientCase.case_id)
    if (doctorSequence !== undefined && (this.#fhir.read(context, 'Encounter', encounterId).status !== 'in-progress'
      || this.lastUnansweredDoctorTurn(context, encounterId)?.turn.sequence !== doctorSequence)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The doctor message is no longer awaiting a reply')
    }
    return outpatientCase.case_id
  }

  casePersonaBinding(
    context: ActorContext,
    caseId: string,
  ): {
    content: PatientPersonaRevisionContent
    revision: number
    syntheticCaseId: string
  } | undefined {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const source = outpatientCaseSource(this.#database, context, caseId)
    if (source === undefined) return undefined
    const row = z.object({
      content_json: z.string(),
      revision: z.number().int().positive(),
      synthetic_case_id: z.string().min(1),
    }).optional().parse(this.#database.driver.prepare(`
      SELECT brief.revision, brief.content_json, materialization.case_id AS synthetic_case_id
      FROM synthetic_case_materialization AS materialization
      JOIN patient_persona_revision AS brief
        ON brief.workspace_id = materialization.workspace_id
       AND brief.case_id = materialization.case_id
       AND brief.revision = materialization.brief_revision
      WHERE materialization.workspace_id = ? AND materialization.epoch = ? AND materialization.case_id = ?
    `).get(context.workspaceId, context.epoch, source.case_id))
    if (row === undefined) return undefined
    return {
      content: patientPersonaRevisionContentSchema.parse(JSON.parse(row.content_json) as unknown),
      revision: row.revision,
      syntheticCaseId: row.synthetic_case_id,
    }
  }

  #completedCaseDiagnosis(context: ActorContext, caseId: string) {
    const confirmation = this.#context.confirmedDiagnoses(context, caseId)
    if (confirmation !== undefined) return confirmation
    const rows = z.array(signedClinicalDocumentRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT document_id, composition_id, bundle_id, provenance_id,
          revision_of_document_id, signed_at
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY signed_at DESC, document_id DESC
      `).all(context.workspaceId, context.epoch, caseId),
    )
    for (const row of rows) {
      const conditionReference = legacyDiagnosisReferenceFromComposition(
        this.#fhir.read(context, 'Composition', row.composition_id),
      )
      if (conditionReference === undefined) continue
      const conditionId = conditionReference.slice('Condition/'.length)
      const resource = this.#fhir.read(context, 'Condition', conditionId)
      const condition = confirmedDiagnosisConditionSchema.parse(resource)
      const coding = condition.code.coding[0]
      if (coding === undefined) continue
      const catalog = z.object({ item_id: z.string().min(1) }).strict().optional().parse(
        this.#database.driver.prepare(`
          SELECT item_id FROM diagnosis_catalog
          WHERE workspace_id = ? AND epoch = ? AND code_system = ? AND code = ?
          ORDER BY item_id
          LIMIT 1
        `).get(context.workspaceId, context.epoch, coding.system, coding.code),
      )
      const note = condition.note?.[0]?.text
      return {
        confirmedAt: row.signed_at,
        entries: [{
          ...(catalog === undefined ? {} : { catalogItemId: catalog.item_id }),
          code: coding.code,
          conditionId,
          conditionVersion: resource.meta?.versionId ?? '1',
          display: coding.display,
          ...(note === undefined ? {} : { note }),
          role: 'primary' as const,
          system: coding.system,
        }],
        id: `legacy-${row.document_id}`,
        provenanceId: row.provenance_id,
      }
    }
    return undefined
  }

  #completedCaseTimeline(
    context: ActorContext,
    input: Pick<
      z.infer<typeof doctorCompletedCaseDetailSchema>,
      | 'clinicalDocuments'
      | 'caseId'
      | 'completedAt'
      | 'consultation'
      | 'diagnosis'
      | 'imagingRequests'
      | 'laboratoryRequests'
      | 'medicationConclusion'
      | 'pathologyRequests'
    > & { encounterId: string },
  ) {
    const events: Array<z.input<typeof doctorCompletedCaseTimelineEventSchema>> = [
      ...this.#completedCaseDraftDeletionEvents(context, input.caseId),
    ]
    for (const turn of input.consultation?.turns ?? []) {
      events.push({
        kind: 'consultation-recorded',
        occurredAt: turn.recordedAt,
        reference: `ConsultationTurn/${turn.id}`,
        relatedReferences: [],
      })
    }
    for (const document of input.clinicalDocuments) {
      events.push({
        kind: document.revisionNumber === 1
          ? 'clinical-document-signed'
          : 'clinical-document-revised',
        occurredAt: document.signedAt,
        reference: `Composition/${document.compositionId}`,
        relatedReferences: [
          `Bundle/${document.bundleId}`,
          `ClinicalDocument/${document.documentId}`,
          `Provenance/${document.provenanceId}`,
          ...(document.revisionOfCompositionId === undefined
            ? []
            : [`Composition/${document.revisionOfCompositionId}`]),
        ],
      })
    }
    for (const request of input.laboratoryRequests) {
      const serviceRequest = z.object({
        authoredOn: z.iso.datetime({ offset: true }),
        resourceType: z.literal('ServiceRequest'),
      }).loose().parse(this.#fhir.read(context, 'ServiceRequest', request.serviceRequestId))
      events.push({
        kind: 'laboratory-request-issued',
        occurredAt: serviceRequest.authoredOn,
        reference: `ServiceRequest/${request.serviceRequestId}`,
        relatedReferences: [
          `LaboratoryRequest/${request.id}`,
          ...(request.taskId === undefined ? [] : [`Task/${request.taskId}`]),
        ],
      })
      if (request.status === 'cancelled') {
        const cancellation = z.object({
          cancelled_at: z.iso.datetime({ offset: true }),
        }).strict().parse(this.#database.driver.prepare(`
          SELECT cancelled_at FROM laboratory_request
          WHERE workspace_id = ? AND epoch = ? AND request_id = ?
            AND cancelled_at IS NOT NULL
        `).get(context.workspaceId, context.epoch, request.id))
        events.push({
          kind: 'laboratory-request-cancelled',
          occurredAt: cancellation.cancelled_at,
          reference: `LaboratoryRequest/${request.id}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            ...(request.taskId === undefined ? [] : [`Task/${request.taskId}`]),
          ],
        })
      }
      for (const report of [
        ...request.previousReports,
        ...(request.report === undefined ? [] : [request.report]),
      ]) {
        events.push({
          kind: report.revisionNumber === 1
            ? 'laboratory-report-issued'
            : 'laboratory-report-revised',
          occurredAt: report.issuedAt,
          reference: `DiagnosticReport/${report.diagnosticReportId}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            `Specimen/${report.specimenId}`,
            ...report.results.map(result => `Observation/${result.observationId}`),
            ...(report.revisionOfDiagnosticReportId === undefined
              ? []
              : [`DiagnosticReport/${report.revisionOfDiagnosticReportId}`]),
          ],
        })
        if (report.acknowledgement !== undefined) {
          events.push({
            kind: 'laboratory-report-acknowledged',
            occurredAt: report.acknowledgement.acknowledgedAt,
            reference: `ReportAcknowledgement/${report.acknowledgement.id}`,
            relatedReferences: [`DiagnosticReport/${report.diagnosticReportId}`],
          })
        }
      }
    }
    for (const request of input.imagingRequests) {
      const row = z.object({
        authored_at: z.iso.datetime({ offset: true }),
        cancelled_at: z.iso.datetime({ offset: true }).nullable(),
      }).strict().parse(this.#database.driver.prepare(`
        SELECT authored_at, cancelled_at FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
      `).get(context.workspaceId, context.epoch, request.id))
      const requestReferences = [`ServiceRequest/${request.serviceRequestId}`, `Task/${request.taskId}`]
      events.push({
        kind: 'imaging-request-issued',
        occurredAt: row.authored_at,
        reference: `ServiceRequest/${request.serviceRequestId}`,
        relatedReferences: [`ImagingRequest/${request.id}`, `Task/${request.taskId}`],
      })
      if (row.cancelled_at !== null) {
        events.push({
          kind: 'imaging-request-cancelled',
          occurredAt: row.cancelled_at,
          reference: `ImagingRequest/${request.id}`,
          relatedReferences: requestReferences,
        })
      }
      for (const report of [...request.previousReports, ...(request.report === undefined ? [] : [request.report])]) {
        events.push({
          kind: report.revisionNumber === 1 ? 'imaging-report-issued' : 'imaging-report-revised',
          occurredAt: report.issuedAt,
          reference: `DiagnosticReport/${report.diagnosticReportId}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            `ImagingStudy/${report.studyId}`,
            ...(report.revisionOfDiagnosticReportId === undefined
              ? []
              : [`DiagnosticReport/${report.revisionOfDiagnosticReportId}`]),
          ],
        })
        if (report.acknowledgement !== undefined) {
          events.push({
            kind: 'imaging-report-acknowledged',
            occurredAt: report.acknowledgement.acknowledgedAt,
            reference: `ReportAcknowledgement/${report.acknowledgement.id}`,
            relatedReferences: [`DiagnosticReport/${report.diagnosticReportId}`],
          })
        }
      }
    }
    for (const request of input.pathologyRequests) {
      const row = z.object({
        authored_at: z.iso.datetime({ offset: true }),
        cancelled_at: z.iso.datetime({ offset: true }).nullable(),
      }).strict().parse(this.#database.driver.prepare(`
        SELECT authored_at, cancelled_at FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
      `).get(context.workspaceId, context.epoch, request.id))
      events.push({
        kind: 'pathology-request-issued',
        occurredAt: row.authored_at,
        reference: `ServiceRequest/${request.serviceRequestId}`,
        relatedReferences: [`PathologyRequest/${request.id}`, `Task/${request.taskId}`],
      })
      if (row.cancelled_at !== null) {
        events.push({
          kind: 'pathology-request-cancelled',
          occurredAt: row.cancelled_at,
          reference: `PathologyRequest/${request.id}`,
          relatedReferences: [`ServiceRequest/${request.serviceRequestId}`, `Task/${request.taskId}`],
        })
      }
      for (const report of [...request.previousReports, ...(request.report === undefined ? [] : [request.report])]) {
        events.push({
          kind: report.revisionNumber === 1 ? 'pathology-report-issued' : 'pathology-report-revised',
          occurredAt: report.issuedAt,
          reference: `DiagnosticReport/${report.diagnosticReportId}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            `Specimen/${report.specimen.specimenId}`,
            `ImagingStudy/${report.studyId}`,
            ...(report.revisionOfDiagnosticReportId === undefined
              ? []
              : [`DiagnosticReport/${report.revisionOfDiagnosticReportId}`]),
          ],
        })
        if (report.acknowledgement !== undefined) {
          events.push({
            kind: 'pathology-report-acknowledged',
            occurredAt: report.acknowledgement.acknowledgedAt,
            reference: `ReportAcknowledgement/${report.acknowledgement.id}`,
            relatedReferences: [`DiagnosticReport/${report.diagnosticReportId}`],
          })
        }
      }
    }
    if (input.diagnosis !== undefined) {
      const legacyCondition = input.diagnosis.id.startsWith('legacy-')
        ? input.diagnosis.entries[0]
        : undefined
      events.push({
        kind: 'diagnosis-confirmed',
        occurredAt: input.diagnosis.confirmedAt,
        reference: legacyCondition === undefined
          ? `DiagnosisConfirmation/${input.diagnosis.id}`
          : `Condition/${legacyCondition.conditionId}`,
        relatedReferences: [
          ...(legacyCondition === undefined
            ? input.diagnosis.entries.map(entry => `Condition/${entry.conditionId}`)
            : []),
          `Provenance/${input.diagnosis.provenanceId}`,
        ],
      })
    }
    const prescription = input.medicationConclusion?.prescription
    if (prescription !== undefined) {
      events.push({
        kind: 'prescription-issued',
        occurredAt: prescription.authoredAt,
        reference: `Prescription/${prescription.id}`,
        relatedReferences: prescription.items.map(
          item => `MedicationRequest/${item.medicationRequestId}`,
        ),
      })
      if (prescription.withdrawal !== undefined) {
        events.push({
          kind: 'prescription-withdrawn',
          occurredAt: prescription.withdrawal.withdrawnAt,
          reference: `PrescriptionWithdrawal/${prescription.withdrawal.id}`,
          relatedReferences: [`Prescription/${prescription.id}`],
        })
      }
    }
    const noMedication = input.medicationConclusion?.noMedication
    if (noMedication !== undefined) {
      events.push({
        kind: 'no-medication-confirmed',
        occurredAt: noMedication.authoredAt,
        reference: `NoMedicationConclusion/${noMedication.id}`,
        relatedReferences: [],
      })
    }
    events.push({
      kind: 'encounter-completed',
      occurredAt: input.completedAt,
      reference: `Encounter/${input.encounterId}`,
      relatedReferences: [],
    })
    events.sort((left, right) => (
      left.occurredAt.localeCompare(right.occurredAt)
      || left.reference.localeCompare(right.reference)
      || left.kind.localeCompare(right.kind)
    ))
    return z.array(doctorCompletedCaseTimelineEventSchema).parse(events)
  }

  #completedCaseDraftDeletionEvents(context: ActorContext, caseId: string) {
    const rows = z.array(draftDeletionTraceRowSchema).parse(this.#database.driver.prepare(`
      SELECT trace_id, operation, effect_json, virtual_timestamp
      FROM action_trace
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
        AND outcome = 'success'
        AND operation IN (
          'encounter.delete-prescription-draft',
          'imaging-request.delete-draft',
          'laboratory-request.delete-draft',
          'pathology-request.delete-draft'
        )
      ORDER BY sequence
    `).all(
      context.workspaceId,
      context.epoch,
      context.scenarioRunId,
    ))
    return rows.flatMap(row => {
      const draft = {
        'encounter.delete-prescription-draft': ['PrescriptionDraft', 'prescription-draft-deleted'],
        'imaging-request.delete-draft': ['ImagingRequestDraft', 'imaging-request-draft-deleted'],
        'laboratory-request.delete-draft': ['LaboratoryRequestDraft', 'laboratory-request-draft-deleted'],
        'pathology-request.delete-draft': ['PathologyRequestDraft', 'pathology-request-draft-deleted'],
      } as const
      const [draftResource, kind] = draft[row.operation]
      const draftReference = `${draftResource}/${caseId}`
      const effects = z.array(actionTraceEffectSchema).parse(
        JSON.parse(row.effect_json) as unknown,
      )
      if (!effects.some(effect => effect.reference === draftReference)) return []
      return [{
        kind,
        occurredAt: row.virtual_timestamp,
        reference: `ActionTrace/${row.trace_id}`,
        relatedReferences: [draftReference],
      }]
    })
  }
}
