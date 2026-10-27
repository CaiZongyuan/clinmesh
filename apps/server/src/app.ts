import { inpatientPciSelectionConfirmInputSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgAgentConfirmInputSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgFollowupStartInputSchema, inpatientDrgFollowupStopInputSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { insuranceTargetSchema, insurancePreviewInputSchema, insuranceConfirmInputSchema, insuranceCancelInputSchema } from '@clinmesh/contracts/insurance'
import { InsuranceError } from './application/insurance-service.ts'
import { inpatientRecordSubmitInputSchema, inpatientRecordReviewInputSchema, inpatientRecordArchiveInputSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientFinancialAdjustmentInputSchema, inpatientFinancialRefundPreviewInputSchema, inpatientFinancialRefundConfirmInputSchema, inpatientFinancialRefundRecoverInputSchema, inpatientFinancialPaymentPreviewInputSchema, inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialInsurancePreviewInputSchema, inpatientFinancialInsuranceConfirmInputSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientDischargeInputSchema, inpatientSettleInputSchema, inpatientDepartInputSchema,
  inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientSurgeryRequestInputSchema, inpatientSurgeryActionInputSchema, inpatientSurgeryExecuteInputSchema, inpatientSurgeryStartInputSchema, inpatientSurgeryRecordMaterialInputSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryCompleteInputSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientTransferRequestInputSchema,inpatientTransferActionInputSchema,inpatientTransferReceiveInputSchema } from '@clinmesh/contracts/inpatient-transfer'
import { inpatientInvestigationAcknowledgeInputSchema,inpatientInvestigationIssueInputSchema,inpatientInvestigationActionInputSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientChargeReverseInputSchema, inpatientExecutionActionInputSchema, inpatientDispenseInputSchema, inpatientOrderIssueInputSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientDiagnosisConfirmInputSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationInputSchema, inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgPayerReviewCreateInputSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import { inpatientPciDataPrepareRequestSchema, pciCaseSourcePrepareRequestSchema, startSyntheticInpatientCaseRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { InpatientError, type InpatientService } from './application/inpatient-service.ts'
import { inpatientRegistrationInputSchema, inpatientBedInputSchema, inpatientSwapInputSchema, advanceVirtualTimeInputSchema, inpatientReferralInputSchema } from '@clinmesh/contracts/inpatient'
import { randomUUID } from 'node:crypto'
import { chargeAdjustmentInputSchema, refundConfirmInputSchema, refundPreviewInputSchema, refundRecoverInputSchema } from '@clinmesh/contracts/refunds'
import { installHostModelUsageRoutes } from './model-usage-host-routes.ts'
import { modelUsageFilterSchema, modelUsageControlUpdateSchema, modelUsageReconcileSchema, modelUsageRepriceSchema, modelUsageRetentionUpdateSchema } from '@clinmesh/contracts/model-usage'
import { ModelUsagePolicyError } from './application/model-usage-control.ts'
import type { ModelUsageService } from './application/model-usage-service.ts'
import { extname } from 'node:path'
import type { HealthResponse } from '@clinmesh/contracts/health'
import { syntheticCaseRegistrationListInputSchema } from '@clinmesh/contracts/his-operations'
import {
  createAgentCapabilityGrantInputSchema,
  createAgentClientInputSchema,
} from '@clinmesh/contracts/agent'
import {
  resetScenarioRequestSchema,
  paymentTendersSchema,
  paymentSimulatorRuleSchema,
  doctorQueueViewSchema,
  acknowledgeImagingReportRequestSchema,
  acknowledgePathologyReportRequestSchema,
  acknowledgeLaboratoryReportRequestSchema,
  cancelImagingRequestRequestSchema,
  cancelPathologyRequestRequestSchema,
  correctImagingReportRequestSchema,
  correctPathologyReportRequestSchema,
  deleteImagingRequestDraftRequestSchema,
  deletePathologyRequestDraftRequestSchema,
  issueImagingRequestRequestSchema,
  issuePathologyRequestRequestSchema,
  retryImagingRequestRequestSchema,
  retryPathologyRequestRequestSchema,
  saveImagingRequestDraftRequestSchema,
  savePathologyRequestDraftRequestSchema,
  cancelLaboratoryRequestRequestSchema,
  completeHospitalServiceRequestSchema,
  completeEncounterRequestSchema,
  confirmDiagnosisRequestSchema,
  confirmNoMedicationRequestSchema,
  correctLaboratoryReportRequestSchema,
  deleteLaboratoryRequestDraftRequestSchema,
  deletePrescriptionDraftRequestSchema,
  issueLaboratoryRequestRequestSchema,
  issuePrescriptionRequestSchema,
  laboratoryServiceCandidateSearchInputSchema,
  laboratoryServicePublicationJobSchema,
  publishLaboratoryServicesRequestSchema,
  orderHospitalServiceRequestSchema,
  previewClinicalDocumentSignRequestSchema,
  cancelClinicalDocumentSignRequestSchema,
  reviseClinicalDocumentRequestSchema,
  retryLaboratoryResultGenerationRequestSchema,
  saveClinicalDocumentDraftRequestSchema,
  checkClinicalDocumentQualityRequestSchema,
  retainClinicalDocumentQualityIssueRequestSchema,
  controlConsultationRecordingRequestSchema,
  saveDiagnosisDraftRequestSchema,
  saveLaboratoryRequestDraftRequestSchema,
  savePrescriptionDraftRequestSchema,
  signClinicalDocumentRequestSchema,
  withdrawPrescriptionRequestSchema,
} from '@clinmesh/contracts/his'
import { referenceDataItemIdSchema } from '@clinmesh/contracts/reference-data'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { prepareImagingCasesRequestSchema } from '@clinmesh/contracts/imaging'
import { preparePathologyCasesRequestSchema } from '@clinmesh/contracts/pathology'
import {
  ImagingResultUnavailableError,
  type ImagingResultResolver,
} from './application/imaging-result-resolver.ts'
import type { ImagingAssetLibrary } from './infrastructure/imaging-assets/imaging-asset-library.ts'
import { ImagingStudyReadError, type ImagingStudyReader } from './application/imaging-study-reader.ts'
import { PathologyPreparationError, type PathologyPreparationService } from './application/pathology-preparation-service.ts'
import {
  PathologyResultUnavailableError,
  type PathologyResultResolver,
} from './application/pathology-result-resolver.ts'
import type { PathologySlideReader } from './application/pathology-slide-reader.ts'
import {
  selectPatientPersonaRevisionRequestSchema,
  startSyntheticCaseRequestSchema,
  scenarioGenerationRequestSchema,
  updateSyntheticPatientProfileRequestSchema,
} from '@clinmesh/contracts/scenario'
import type { IdentityService } from './application/identity-service.ts'
import { IdentityError } from './application/identity-service.ts'
import type { InvestigationService } from './application/investigation-service.ts'
import type { LaboratoryServicePublisher } from './application/laboratory-service-publisher.ts'
import {
  LaboratoryServicePublisherError,
} from './application/laboratory-service-publisher.ts'
import type { ReferenceDataService } from './application/reference-data-service.ts'
import { ReferenceDataError } from './application/reference-data-service.ts'
import {
  CommandConflictError,
  CommandReceiptNotFoundError,
  ExpectedVersionConflictError,
  type CommandExecutor,
} from './application/command-executor.ts'
import type { ScenarioService } from './application/scenario-service.ts'
import { ScenarioError } from './application/scenario-service.ts'
import type { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { ScenarioDataError } from './application/scenario-data/scenario-data-service.ts'
import { ConsultationDialogueError, type ConsultationDialogueService } from './application/consultation-dialogue-service.ts'
import { createPatientPersonaRevisionFromEditRequestSchema } from '@clinmesh/contracts/scenario'
import type { PatientPersonaService } from './application/patient-persona-service.ts'
import { PatientPersonaError } from './application/patient-persona-service.ts'
import {
  ImagingPreparationError,
  type ImagingPreparationService,
} from './application/imaging-preparation-service.ts'
import type { SyntheticCaseVisitService } from './application/synthetic-case-visit-service.ts'
import { SyntheticCaseVisitError } from './application/synthetic-case-visit-service.ts'
import { PciCaseSourceError } from './application/scenario-data/pci-case-source.ts'
import type { WorkflowService } from './application/workflow-service.ts'
import { WorkflowError } from './application/workflow-service.ts'
import { RegistrationNumberError } from './infrastructure/sqlite/registration-numbering.ts'
import type { DoctorRecommendationsService } from './application/doctor-recommendations-service.ts'
import { doctorRecommendationKindSchema, generateDoctorRecommendationsRequestSchema, confirmDoctorPreparationRequestSchema, doctorConsiderationDispositionKindSchema, setDoctorConsiderationDispositionRequestSchema } from '@clinmesh/contracts/doctor-recommendations'
import { createCapabilityStatement } from './fhir/capabilities.ts'
import { isSupportedResourceType } from './fhir/capabilities.ts'
import {
  FhirRepositoryError,
  type FhirRepository,
  type RepositoryContext,
} from './infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceContextError } from './infrastructure/sqlite/workspace-repository.ts'
import { reportRuntimeError } from './runtime-error-reporting.ts'
import type { AgentIntegrationService } from './application/agent-integration-service.ts'
import { AgentIntegrationError } from './application/agent-integration-service.ts'
import {
  agentPageContextRequestSchema,
  agentReviewDecisionRequestSchema,
  agentToolAuthorizationRequestSchema,
  agentToolResultRequestSchema,
  agentDoctorQueryRequestSchema,
  doctorCaseHistoryInputSchema,
  doctorCaseHistoryDetailInputSchema,
  doctorRecordingSourceRequestSchema,
} from '@clinmesh/contracts/agent'

interface FhirRuntime {
  repository: FhirRepository
  resolveContext: (request: Request) => Promise<RepositoryContext> | RepositoryContext
}

export interface CreateAppOptions {
  dshBridgeSecret?: string
  modelUsage?: ModelUsageService
  inpatient?: InpatientService
  commandEvents?: Pick<CommandExecutor, 'subscribe'>
  recordingUpdatesSignal?: AbortSignal
  doctorRecommendations?: DoctorRecommendationsService
  agentIntegration?: AgentIntegrationService
  caseVisits?: SyntheticCaseVisitService
  fhir?: FhirRuntime
  identity?: IdentityService
  imaging?: { library: ImagingAssetLibrary; reader: ImagingStudyReader; results: ImagingResultResolver }
  imagingPreparation?: ImagingPreparationService
  pathology?: {
    preparation: PathologyPreparationService
    reader: PathologySlideReader
    results: PathologyResultResolver
  }
  investigation?: InvestigationService
  laboratoryServicePublisher?: LaboratoryServicePublisher
  consultationDialogue?: ConsultationDialogueService
  patientPersona?: PatientPersonaService
  referenceData?: ReferenceDataService
  scenario?: ScenarioService
  scenarioData?: ScenarioDataService
  workflow?: WorkflowService
  webRoot?: string
}

const requestCorrelationIds = new WeakMap<Request, string>()

function requestCorrelationId(context: Context): string {
  const existing = requestCorrelationIds.get(context.req.raw)
  if (existing !== undefined) return existing
  const correlationId = randomUUID()
  requestCorrelationIds.set(context.req.raw, correlationId)
  return correlationId
}

const pixelBlockIndexSchema = z.string().regex(/^(0|[1-9]\d{0,5})$/).transform(Number)
const pixelBlockPositionSchema = z.object({
  blockIndex: pixelBlockIndexSchema,
  frameIndex: pixelBlockIndexSchema,
  seriesIndex: pixelBlockIndexSchema,
})
/** 切片瓦片位置：序列（切片）、层级（0 为最高分辨率）与瓦片的列、行。 */
const slideTilePositionSchema = z.object({
  column: pixelBlockIndexSchema,
  level: pixelBlockIndexSchema,
  row: pixelBlockIndexSchema,
  seriesIndex: pixelBlockIndexSchema,
})

function operationOutcome(code: string, diagnostics: string) {
  return {
    resourceType: 'OperationOutcome' as const,
    issue: [{ severity: 'error' as const, code, diagnostics }],
  }
}

function apiErrorBody(
  context: Context,
  code: string,
  message: string,
  conflict?: unknown,
  reason?: string,
) {
  return {
    error: {
      code,
      ...(conflict === undefined ? {} : { conflict }),
      correlationId: requestCorrelationId(context),
      message,
      ...(reason === undefined ? {} : { reason }),
    },
  }
}

function invalidInputResponse(context: Context, message = 'The request is invalid') {
  return context.json(apiErrorBody(context, 'INVALID_INPUT', message), 400)
}

function apiErrorResponse(
  context: Context,
  error: unknown,
  invalidInputMessage?: string,
) {
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return invalidInputResponse(context, invalidInputMessage)
  }
    if (
      error instanceof IdentityError
      || error instanceof ModelUsagePolicyError
      || error instanceof InsuranceError
      || error instanceof InpatientError
      || error instanceof AgentIntegrationError
      || error instanceof ConsultationDialogueError
      || error instanceof LaboratoryServicePublisherError
    || error instanceof PatientPersonaError
    || error instanceof ImagingPreparationError
    || error instanceof PathologyPreparationError
    || error instanceof ImagingStudyReadError
    || error instanceof SyntheticCaseVisitError
    || error instanceof PciCaseSourceError
    || error instanceof ReferenceDataError
    || error instanceof ScenarioDataError
    || error instanceof ScenarioError
    || error instanceof WorkflowError
    || error instanceof RegistrationNumberError
    || error instanceof CommandReceiptNotFoundError
  ) {
    return context.json(apiErrorBody(
      context,
      error.code,
      error.message,
      error instanceof WorkflowError ? error.conflict : undefined,
      error instanceof WorkflowError ? error.reason : undefined,
    ), error.status)
  }
  if (
    error instanceof CommandConflictError
    || error instanceof ExpectedVersionConflictError
    || error instanceof FhirRepositoryError
    || error instanceof WorkspaceContextError
  ) {
    return context.json(apiErrorBody(context, error.code, error.message), 409)
  }
  throw error
}

function fhirErrorStatus(error: FhirRepositoryError): 400 | 404 | 412 {
  if (error.code === 'NOT_FOUND') return 404
  if (error.code === 'CONFLICT') return 412
  return 400
}

function fhirIssueCode(error: FhirRepositoryError): string {
  if (error.code === 'NOT_SUPPORTED') return 'not-supported'
  if (error.code === 'NOT_FOUND') return 'not-found'
  if (error.code === 'CONFLICT') return 'conflict'
  return 'invalid'
}

function fhirErrorResponse(context: Context, error: unknown) {
  if (error instanceof IdentityError) {
    const code = error.status === 401 ? 'login' : 'forbidden'
    return context.json(operationOutcome(code, error.message), error.status, {
      'Content-Type': 'application/fhir+json',
    })
  }
  if (error instanceof FhirRepositoryError) {
    return context.json(operationOutcome(fhirIssueCode(error), error.message), fhirErrorStatus(error), {
      'Content-Type': 'application/fhir+json',
    })
  }
  throw error
}

function isServicePath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/fhir' || path.startsWith('/fhir/')
}

function isStaticAssetPath(path: string): boolean {
  return extname(path) !== ''
}

const referenceCatalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  query: z.string().trim().min(2).max(100).optional(),
}).strict()

function referenceCatalogQuery(context: Context): {
  page: number
  pageSize: number
  query?: string
} {
  const parsed = referenceCatalogQuerySchema.parse(context.req.query())
  return {
    page: parsed.page,
    pageSize: parsed.pageSize,
    ...(parsed.query === undefined ? {} : { query: parsed.query }),
  }
}

const laboratoryServiceCandidateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  panelOnly: z.enum(['false', 'true']).transform(value => value === 'true').default(false),
  query: z.string().trim().min(2).max(100).optional(),
  sourceDataset: z.enum(['laboratory-cn', 'loinc-zh-cn']).optional(),
}).strict()

function laboratoryServiceCandidateQuery(context: Context) {
  const parsed = laboratoryServiceCandidateSearchInputSchema.parse(
    laboratoryServiceCandidateQuerySchema.parse(context.req.query()),
  )
  return {
    page: parsed.page,
    pageSize: parsed.pageSize,
    panelOnly: parsed.panelOnly,
    ...(parsed.query === undefined ? {} : { query: parsed.query }),
    ...(parsed.sourceDataset === undefined ? {} : { sourceDataset: parsed.sourceDataset }),
  }
}

function requestIdempotencyKey(context: Context): string {
  return z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.use('*', async (context, next) => {
    const correlationId = randomUUID()
    requestCorrelationIds.set(context.req.raw, correlationId)
    await next()
    context.header('X-Correlation-Id', correlationId)
  })

  app.onError((error, context) => {
    const correlationId = requestCorrelationId(context)
    reportRuntimeError({
      correlationId,
      error,
      method: context.req.method,
      route: context.req.routePath,
      scope: 'http',
    })
    context.header('X-Correlation-Id', correlationId)
    if (context.req.path === '/fhir' || context.req.path.startsWith('/fhir/')) {
      return context.json(
        operationOutcome('exception', 'The FHIR request could not be completed'),
        500,
        { 'Content-Type': 'application/fhir+json' },
      )
    }
    return context.json({
      error: {
        code: 'INTERNAL_ERROR',
        correlationId,
        message: 'The ClinMesh request could not be completed',
      },
    }, 500)
  })

  app.get('/api/health', (context) => {
    const response: HealthResponse = {
      service: 'clinmesh-server',
      status: 'ok',
      fhirVersion: '5.0.0',
    }
    return context.json(response)
  })

  if (options.modelUsage !== undefined && options.agentIntegration !== undefined && options.dshBridgeSecret !== undefined) {
    installHostModelUsageRoutes(app, options.modelUsage, options.agentIntegration, options.dshBridgeSecret)
  }

  if (options.identity !== undefined) {
    const identity = options.identity
    if (options.modelUsage !== undefined) {
      const usage = options.modelUsage
      app.get('/api/model-usage/retention', async context => {
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.retention(session.actor.workspaceId))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.put('/api/model-usage/retention', async context => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.updateRetention(session.actor, modelUsageRetentionUpdateSchema.parse(await context.req.json()), requestIdempotencyKey(context)))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.get('/api/model-usage/pricing', async context => {
        try {
          await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.pricing())
        } catch (error) { return apiErrorResponse(context, error) }
      })
      for (const operation of ['reconcile', 'reprice'] as const) {
        app.post(`/api/model-usage/requests/:attemptId/${operation}`, async context => {
          try {
            identity.assertTrustedMutation(context.req.raw.headers)
            const session = await identity.resolveSessionContext(context.req.raw.headers)
            const id = z.uuid().parse(context.req.param('attemptId'))
            const body: unknown = await context.req.json()
            return context.json(operation === 'reconcile'
              ? usage.reconcile(session.actor, id, modelUsageReconcileSchema.parse(body), requestIdempotencyKey(context))
              : usage.reprice(session.actor, id, modelUsageRepriceSchema.parse(body), requestIdempotencyKey(context)))
          } catch (error) { return apiErrorResponse(context, error) }
        })
      }
      app.get('/api/model-usage/control', async context => {
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.controlFor(session.actor))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.put('/api/model-usage/control', async context => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.updateControl(session.actor, modelUsageControlUpdateSchema.parse(await context.req.json()), requestIdempotencyKey(context)))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.get('/api/model-usage/overview', async context => {
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.overview(session.actor, modelUsageFilterSchema.parse(context.req.query())))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.get('/api/model-usage/requests', async context => {
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(usage.list(session.actor, modelUsageFilterSchema.parse(context.req.query())))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.get('/api/model-usage/requests/:attemptId', async context => {
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          const record = usage.detail(session.actor, z.string().uuid().parse(context.req.param('attemptId')))
          return record === undefined ? context.json(apiErrorBody(context, 'NOT_FOUND', 'The model request was not found'), 404) : context.json(record)
        } catch (error) { return apiErrorResponse(context, error) }
      })
    }
    app.post('/api/auth/sign-up/email', context => context.json(apiErrorBody(
      context,
      'PUBLIC_SIGN_UP_DISABLED',
      'Public account registration is disabled',
    ), 403))
    app.get('/api/auth/context', async (context) => {
      try {
        return context.json(await identity.resolveSessionContext(context.req.raw.headers))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/auth/role', async (context) => {
      try {
        const input = z.object({
          practitionerRoleId: z.string().min(1),
        }).parse(await context.req.json())
        return context.json(await identity.selectRole(
          context.req.raw.headers,
          input.practitionerRoleId,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/agent/v1/clients', async (context) => {
      try {
        return context.json(await identity.listAgentClients(context.req.raw.headers))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/agent/v1/clients/:agentClientId', async (context) => {
      try {
        const agentClientId = z.string().uuid().parse(context.req.param('agentClientId'))
        return context.json(await identity.getAgentClient(context.req.raw.headers, agentClientId))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/clients', async (context) => {
      try {
        const input = createAgentClientInputSchema.parse(await context.req.json())
        return context.json(await identity.createAgentClient(
          context.req.raw.headers,
          input,
          requestIdempotencyKey(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/clients/:agentClientId/actions/disable', async (context) => {
      try {
        z.object({}).strict().parse(await context.req.json())
        const agentClientId = z.string().uuid().parse(context.req.param('agentClientId'))
        return context.json(await identity.disableAgentClient(
          context.req.raw.headers,
          agentClientId,
          requestIdempotencyKey(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/agent/v1/grants', async (context) => {
      try {
        return context.json(await identity.listAgentGrants(context.req.raw.headers))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/agent/v1/grants/:grantId', async (context) => {
      try {
        const grantId = z.string().uuid().parse(context.req.param('grantId'))
        return context.json(await identity.getAgentGrant(context.req.raw.headers, grantId))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/grants', async (context) => {
      try {
        const input = createAgentCapabilityGrantInputSchema.parse(await context.req.json())
        return context.json(await identity.createAgentGrant(
          context.req.raw.headers,
          input,
          requestIdempotencyKey(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/grants/:grantId/actions/revoke', async (context) => {
      try {
        z.object({}).strict().parse(await context.req.json())
        const grantId = z.string().uuid().parse(context.req.param('grantId'))
        return context.json(await identity.revokeAgentGrant(
          context.req.raw.headers,
          grantId,
          requestIdempotencyKey(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/agent/v1/context', async (context) => {
      try {
        return context.json(await identity.resolveAgentCapabilityContext(context.req.raw.headers))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.all('/api/auth/*', context => identity.handle(context.req.raw))
  }

  if (options.agentIntegration !== undefined && options.identity !== undefined) {
    const agentIntegration = options.agentIntegration
    const identity = options.identity
    app.post('/api/agent/v1/page-contexts', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = agentPageContextRequestSchema.parse(await context.req.json())
        return context.json(agentIntegration.createPageContext({
          actor: session.actor,
          request,
          userAccountId: session.user.id,
        }), 201)
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/tool-calls', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = agentToolAuthorizationRequestSchema.parse(await context.req.json())
        return context.json(agentIntegration.authorizeToolCall({
          actor: session.actor,
          request,
          userAccountId: session.user.id,
        }), 201)
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/agent/v1/tool-calls/result', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = agentToolResultRequestSchema.parse(await context.req.json())
        return context.json(agentIntegration.completeToolCall({
          actor: session.actor,
          request,
          userAccountId: session.user.id,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    if (options.workflow !== undefined) {
      const workflow = options.workflow
      app.post('/api/agent/v1/doctor-inputs', async context => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const request = doctorRecordingSourceRequestSchema.parse(await context.req.json())
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          const source = agentIntegration.verifyDoctorRecordingSource({ actor: session.actor,
            request, userAccountId: session.user.id })
          const detail = workflow.doctorCaseDetail(session.actor, source.caseId)
          return context.json(workflow.consultationRecording.recordDoctorSupplement({ ...source,
            context: session.actor, encounterId: detail.encounter.id,
            expectedVersions: { [`Encounter/${detail.encounter.id}`]: z.string().min(1).parse(detail.encounter.versionId) },
            idempotencyKey: `doctor-source:${source.sourceId}`,
          }))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.post('/api/agent/v1/doctor-queries', async context => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const request = agentDoctorQueryRequestSchema.parse(await context.req.json())
          let session = await identity.resolveSessionContext(context.req.raw.headers)
          const query = agentIntegration.verifyDoctorQuery({ actor: session.actor, request,
            userAccountId: session.user.id })
          if (query.operationId === 'ui.context.read') return context.json({ context: query.context })
          if (query.operationId === 'outpatient.case.read') {
            const [readyExamCodes, offering] = await Promise.all([
              options.imaging?.library.readyExamCodes().catch(() => undefined),
              options.pathology?.preparation.offering(session.actor, { outpatientCaseId: query.caseId }).catch(() => undefined),
            ])
            session = await identity.resolveSessionContext(context.req.raw.headers)
            agentIntegration.verifyDoctorQuery({ actor: session.actor, request, userAccountId: session.user.id })
            return context.json({ ...workflow.doctorCaseDetail(session.actor, query.caseId),
              imagingServices: readyExamCodes === undefined ? null : workflow.imaging.serviceCatalog(session.actor, readyExamCodes).items,
              pathologyServices: offering === undefined ? null : workflow.pathology.serviceCatalog(session.actor, offering.readyExamCodes, offering.sourceProcedures).items,
              queue: null,
            })
          }
          if (query.operationId === 'outpatient.history.search') return context.json(workflow.doctorCaseHistory(
            session.actor, query.caseId, doctorCaseHistoryInputSchema.parse(query.input)))
          if (query.operationId === 'outpatient.history.read') return context.json(workflow.doctorCaseHistoryDetail(
            session.actor, query.caseId, doctorCaseHistoryDetailInputSchema.parse(query.input)))
          throw new AgentIntegrationError('AGENT_OPERATION_NOT_ALLOWED', 'The doctor query is not available', 403)
        } catch (error) { return apiErrorResponse(context, error) }
      })
    }
    app.post('/api/agent/v1/doctor-tasks/permit', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(agentIntegration.createDoctorTaskPermit({
          actor: session.actor, request: await context.req.json(), userAccountId: session.user.id,
        }), 201)
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/agent/v1/tool-calls/review', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = agentReviewDecisionRequestSchema.parse(await context.req.json())
        return context.json(agentIntegration.reviewToolCall({
          actor: session.actor,
          request,
          userAccountId: session.user.id,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }

  if (options.identity !== undefined && options.scenario !== undefined) {
    const identity = options.identity
    const scenario = options.scenario
    app.get('/api/sim/v1/scenario-runs/current', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(scenario.current(session.actor))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/sim/v1/scenario-runs/:scenarioRunId/actions/reset', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = resetScenarioRequestSchema.parse(await context.req.json())
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(scenario.reset({
          clearPatientLibrary: request.clearPatientLibrary,
          context: session.actor,
          idempotencyKey,
          scenarioRunId: context.req.param('scenarioRunId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/sim/v1/scenarios/actions/install', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const input = z.object({
          kind: z.enum(['candidate', 'density']),
        }).parse(await context.req.json())
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(scenario.install({
          context: session.actor,
          idempotencyKey,
          kind: input.kind,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Scenario installation request is invalid')
      }
    })
  }

  if (options.identity !== undefined && options.referenceData !== undefined) {
    const identity = options.identity
    const referenceData = options.referenceData
    app.get('/api/sim/v1/reference-data/offline-inventories', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(referenceData.offlineInventories(session.actor, context.req.query()))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/reference-data/releases', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(referenceData.list(session.actor))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/reference-catalogs/diagnoses', async (context) => {
      try {
        const actor = await identity.resolveRequestActor(
          context.req.raw.headers,
          context.req.raw.method,
          context.req.path,
        )
        return context.json(referenceData.searchDiagnoses(
          actor,
          referenceCatalogQuery(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/reference-catalogs/medications', async (context) => {
      try {
        const actor = await identity.resolveRequestActor(
          context.req.raw.headers,
          context.req.raw.method,
          context.req.path,
        )
        return context.json(referenceData.searchMedications(
          actor,
          referenceCatalogQuery(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/reference-catalogs/laboratory', async (context) => {
      try {
        const actor = await identity.resolveRequestActor(
          context.req.raw.headers,
          context.req.raw.method,
          context.req.path,
        )
        return context.json(referenceData.searchLaboratory(
          actor,
          referenceCatalogQuery(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }

  if (options.identity !== undefined && options.laboratoryServicePublisher !== undefined) {
    const identity = options.identity
    const publisher = options.laboratoryServicePublisher
    const actor = (context: Context) => identity.resolveRequestActor(
      context.req.raw.headers,
      context.req.raw.method,
      context.req.path,
    )
    app.get('/api/his/v1/admin/laboratory-services/candidates', async (context) => {
      try {
        return context.json(publisher.candidates(
          await actor(context),
          laboratoryServiceCandidateQuery(context),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/admin/laboratory-services/actions/publish', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const request = publishLaboratoryServicesRequestSchema.parse(await context.req.json())
        return context.json(await publisher.enqueue({
          context: await actor(context),
          entries: request.input.entries,
          idempotencyKey: requestIdempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Laboratory Service publication request is invalid')
      }
    })
    app.get('/api/his/v1/admin/laboratory-services/jobs/:jobId', async (context) => {
      try {
        const jobId = laboratoryServicePublicationJobSchema.shape.jobId.parse(
          context.req.param('jobId'),
        )
        return context.json(publisher.getJob(
          await actor(context),
          jobId,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }

  if (options.identity !== undefined && options.scenarioData !== undefined) {
    const identity = options.identity
    const scenarioData = options.scenarioData
    app.get('/api/sim/v1/scenario-providers', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(await scenarioData.capabilities(session.actor))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/sim/v1/scenario-generation-jobs', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const request = scenarioGenerationRequestSchema.parse(await context.req.json())
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(await scenarioData.enqueueGeneration({
          context: session.actor,
          idempotencyKey,
          request,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Scenario generation job request is invalid')
      }
    })
    app.get('/api/sim/v1/scenario-generation-jobs/:jobId', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(scenarioData.getGenerationJob(session.actor, context.req.param('jobId')))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/sim/v1/synthetic-cases/pci/prepare', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = pciCaseSourcePrepareRequestSchema.parse(await context.req.json())
        const actor = await identity.resolveRequestActor(context.req.raw.headers, context.req.raw.method, context.req.path)
        return context.json(scenarioData.preparePciCaseSource(actor, body.input,
          z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/sim/v1/synthetic-patients', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          search: z.string().trim().min(1).max(120).optional(),
        }).parse(context.req.query())
        return context.json(scenarioData.listSyntheticPatients(session.actor, {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.search === undefined ? {} : { search: query.search }),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/admin/synthetic-cases/:caseId/truth', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const caseId = z.string().min(1).max(128).parse(context.req.param('caseId'))
        return context.json(scenarioData.getAdministratorCaseTruth(session.actor, caseId))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-cases/:caseId/history/detail', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const query = z.object({
          sourceReference: z.string().min(1).max(512),
        }).parse(context.req.query())
        return context.json(scenarioData.getSyntheticCaseHistoryDetail(
          session.actor,
          context.req.param('caseId'),
          query.sourceReference,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-cases/:caseId/history', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(20).default(20),
        }).parse(context.req.query())
        return context.json(scenarioData.listSyntheticCaseHistory(session.actor, {
          caseId: context.req.param('caseId'),
          page: query.page,
          pageSize: query.pageSize,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-cases/:caseId', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(scenarioData.getSyntheticCase(
          session.actor,
          context.req.param('caseId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-patients/:profileId', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(scenarioData.getSyntheticPatient(
          session.actor,
          context.req.param('profileId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/sim/v1/synthetic-patients/:profileId', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const body = updateSyntheticPatientProfileRequestSchema.parse(await context.req.json())
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(scenarioData.updateSyntheticPatient({
          context: session.actor,
          expectedRevision: body.expectedRevision,
          idempotencyKey,
          identity: body.input,
          profileId: context.req.param('profileId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Synthetic Patient Profile update is invalid')
      }
    })
  }

  function requireConsultationDialogue(): ConsultationDialogueService {
    if (options.consultationDialogue === undefined) {
      throw new ConsultationDialogueError(
        'CONSULTATION_REPLY_UNAVAILABLE',
        'Patient dialogue generation is not configured',
      )
    }
    return options.consultationDialogue
  }

  if (options.identity !== undefined && options.imagingPreparation !== undefined) {
    const identity = options.identity
    const imagingPreparation = options.imagingPreparation
    // 影像准备与覆盖清单只面向管理员：不进入 Operation Catalog、CLI、Page Context 或 Agent Tools。
    app.post('/api/sim/v1/admin/imaging-preparations', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = prepareImagingCasesRequestSchema.parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(await imagingPreparation.prepareBatch({
          caseIds: body.input.caseIds,
          context: session.actor,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The imaging preparation request is invalid')
      }
    })
    app.get('/api/sim/v1/admin/scenario-generation-targets', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        // 一个素材包的清单无效时只缺少它的条目，另一个素材包的条目照常可选。
        const imaging = await imagingPreparation.generationTargets(session.actor).catch((error: unknown) => {
          if (error instanceof ImagingPreparationError && error.code === 'IMAGING_CATALOG_INVALID') return { items: [] }
          throw error
        })
        const pathology = await options.pathology?.preparation.generationTargets(session.actor).catch((error: unknown) => {
          if (error instanceof PathologyPreparationError && error.code === 'PATHOLOGY_CATALOG_INVALID') return { items: [] }
          throw error
        })
        return context.json({ items: [...imaging.items, ...pathology?.items ?? []] })
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/admin/imaging-coverage', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(await imagingPreparation.coverage(session.actor))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    if (options.imaging !== undefined) {
      const { reader } = options.imaging
      // 管理员复核素材的预览入口；与影像准备一样不进入 Operation Catalog、CLI 或 Agent Tools。
      app.get('/api/sim/v1/admin/imaging-assets/:assetId', async (context) => {
        context.header('Cache-Control', 'no-store')
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          return context.json(await reader.describeAsset(session.actor, context.req.param('assetId')))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.get(
        '/api/sim/v1/admin/imaging-assets/:assetId/series/:seriesIndex/frames/:frameIndex/blocks/:blockIndex',
        async (context) => {
          context.header('Cache-Control', 'no-store')
          try {
            const session = await identity.resolveSessionContext(context.req.raw.headers)
            const position = pixelBlockPositionSchema.parse(context.req.param())
            const bytes = await reader.readAssetBlock(session.actor, context.req.param('assetId'), position)
            return context.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream' })
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
    }
    app.get('/api/sim/v1/admin/synthetic-cases/:caseId/imaging-preparation', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const caseId = z.string().min(1).max(128).parse(context.req.param('caseId'))
        return context.json(imagingPreparation.getCasePreparation(session.actor, caseId))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }
  if (options.identity !== undefined && options.pathology !== undefined) {
    const identity = options.identity
    const { preparation, reader } = options.pathology
    // 病理准备、覆盖清单与素材复核预览只面向管理员：不进入 Operation Catalog、CLI、Page Context 或 Agent Tools。
    app.post('/api/sim/v1/admin/pathology-preparations', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = preparePathologyCasesRequestSchema.parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(await preparation.prepareBatch({
          caseIds: body.input.caseIds,
          context: session.actor,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The pathology preparation request is invalid')
      }
    })
    app.get('/api/sim/v1/admin/pathology-coverage', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(await preparation.coverage(session.actor))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/admin/pathology-assets/:assetId', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(await reader.describeAsset(session.actor, context.req.param('assetId')))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get(
      '/api/sim/v1/admin/pathology-assets/:assetId/series/:seriesIndex/levels/:level/tiles/:column/:row',
      async (context) => {
        context.header('Cache-Control', 'no-store')
        try {
          const session = await identity.resolveSessionContext(context.req.raw.headers)
          const position = slideTilePositionSchema.parse(context.req.param())
          const bytes = await reader.readAssetTile(session.actor, context.req.param('assetId'), position)
          return context.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream' })
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      },
    )
    app.get('/api/sim/v1/admin/synthetic-cases/:caseId/pathology-preparation', async (context) => {
      context.header('Cache-Control', 'no-store')
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const caseId = z.string().min(1).max(128).parse(context.req.param('caseId'))
        return context.json(preparation.getCasePreparation(session.actor, caseId))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }
  if (options.identity !== undefined && options.patientPersona !== undefined) {
    const identity = options.identity
    const patientPersona = options.patientPersona
    app.post('/api/sim/v1/synthetic-cases/:caseId/patient-persona-jobs', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        z.object({}).strict().parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(await patientPersona.enqueue({
          caseId: context.req.param('caseId'),
          context: session.actor,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Patient Persona generation request is invalid')
      }
    })
    app.get('/api/sim/v1/patient-persona-jobs/:jobId', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(patientPersona.getJob(session.actor, context.req.param('jobId')))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-cases/:caseId/patient-persona-revisions', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(patientPersona.listRevisions(
          session.actor,
          context.req.param('caseId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/sim/v1/synthetic-cases/:caseId/patient-persona-revisions', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = createPatientPersonaRevisionFromEditRequestSchema.parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(patientPersona.createRevisionFromEdit({
          caseId: context.req.param('caseId'),
          content: body.input.content,
          context: session.actor,
          forceDiagnosisLeakOverride: body.input.forceDiagnosisLeakOverride ?? false,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Patient Persona edit is invalid')
      }
    })
    app.put('/api/sim/v1/synthetic-cases/:caseId/patient-persona-revisions/active', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = selectPatientPersonaRevisionRequestSchema.parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(patientPersona.selectRevision({
          personaRevision: body.personaRevision,
          caseId: context.req.param('caseId'),
          context: session.actor,
          expectedCaseRevision: body.expectedCaseRevision,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Patient Persona revision selection is invalid')
      }
    })
  }

  if (options.identity !== undefined && options.caseVisits !== undefined) {
    const identity = options.identity
    const caseVisits = options.caseVisits
    app.get('/api/his/v1/registration/synthetic-cases', async (context) => {
      try {
        const query = syntheticCaseRegistrationListInputSchema.parse(context.req.query())
        const actor = await identity.resolveRequestActor(
          context.req.raw.headers,
          context.req.raw.method,
          context.req.path,
        )
        return context.json(caseVisits.listReadyForRegistration({
          context: actor,
          page: query.page,
          pageSize: query.pageSize,
          ...(query.search === undefined ? {} : { search: query.search }),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/synthetic-cases/:caseId/actions/start-outpatient-visit', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const request = startSyntheticCaseRequestSchema.parse(await context.req.json())
        const actor = await identity.resolveRequestActor(
          context.req.raw.headers,
          context.req.raw.method,
          context.req.path,
        )
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(caseVisits.start({
          caseId: context.req.param('caseId'),
          context: actor,
          idempotencyKey,
          request,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Synthetic Case visit request is invalid')
      }
    })
    app.post('/api/his/v1/synthetic-cases/:caseId/actions/start-inpatient-visit', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const request = startSyntheticInpatientCaseRequestSchema.parse(await context.req.json())
        const actor = await identity.resolveRequestActor(context.req.raw.headers, context.req.raw.method, context.req.path)
        return context.json(caseVisits.startInpatient({ caseId: context.req.param('caseId'), context: actor, request,
          idempotencyKey: z.string().min(8).max(128).parse(context.req.header('idempotency-key')) }))
      } catch (error) { return apiErrorResponse(context, error) }
    })
  }

  if (options.identity !== undefined && options.inpatient !== undefined) {
    const identity = options.identity
    const inpatient = options.inpatient
    const actor = (context: Context) => identity.resolveRequestActor(context.req.raw.headers, context.req.raw.method, context.req.path)
    app.get('/api/his/v1/inpatient/catalog-search', async context => {
      try { return context.json(inpatient.catalogSearch.search(await actor(context), context.req.query())) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/pci-data', async context => {
      try { return context.json(inpatient.pciData.read(await actor(context))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/pci-data/prepare', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = inpatientPciDataPrepareRequestSchema.parse(await context.req.json())
        return context.json(inpatient.pciData.prepare(await actor(context), body.input,
          z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/payments', async context => {
      try { return context.json(inpatient.payments.read(await actor(context), context.req.param('admissionId'))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/payments/preview', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: z.object(inpatientPaymentInputSchema.shape).omit({ admissionId: true }).strict() }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.preview(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/payments/confirm', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientPaymentConfirmInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.confirm(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/payments/recover', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientPaymentRecoverInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.recover(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/refunds/preview', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientRefundInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.refundPreview(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/refunds/confirm', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientRefundConfirmInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.refundConfirm(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/refunds/recover', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientRefundRecoverInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.payments.refundRecover(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/record', async context => {
      try { return context.json(inpatient.records.read(await actor(context), context.req.param('admissionId'))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/record/submit', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:inpatientRecordSubmitInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.records.submit(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/record/review', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:z.object(inpatientRecordReviewInputSchema.shape).omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.records.review(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/record/archive', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:inpatientRecordArchiveInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.records.archive(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/agent', async context => {
      try { return context.json(inpatient.drgAgent.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/agent/confirm', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientDrgAgentConfirmInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.drgAgent.confirm(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/followup', async context => {
      try { return context.json(inpatient.followup.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/followup/start', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientDrgFollowupStartInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.followup.start(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/followup/stop', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientDrgFollowupStopInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.followup.stop(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/pregroup', async context => {
      try { return context.json(inpatient.drg.readPregroup(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/simulation', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body = z.object({ input: inpatientDrgSimulationInputSchema.optional() }).strict().parse(await context.req.json().catch(() => ({})))
        return context.json(inpatient.drg.readSimulation(await actor(context), context.req.param('admissionId'), body.input)) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/reservations', async context => {
      try { return context.json(inpatient.drg.readReservations(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/reservations', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:inpatientMaterialReservationCreateInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.drg.createReservation(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/reservations/:reservationId/release', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:inpatientMaterialReservationReleaseInputSchema.omit({admissionId:true,reservationId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.drg.releaseReservation(await actor(context),{...body.input,admissionId:context.req.param('admissionId'),reservationId:context.req.param('reservationId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review-preview', async context => {
      try { return context.json(inpatient.drg.readPayerReviewPreview(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/drg/payer-review', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers); const body=z.object({input:inpatientDrgPayerReviewCreateInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.drg.payerReview(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/drg/payer-reviews', async context => {
      try { return context.json(inpatient.drg.readPayerReviews(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/discharge', async context => {
      try { return context.json(inpatient.discharge.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    const dischargeAction = (action: 'issue' | 'depart' | 'recall' | 'clear') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema = action === 'depart' ? inpatientDepartInputSchema : inpatientDischargeInputSchema
        const body = z.object({ input: schema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.discharge.action(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key')), action))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/discharge/issue', dischargeAction('issue'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/discharge/depart', dischargeAction('depart'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/discharge/recall', dischargeAction('recall'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/discharge/clear', dischargeAction('clear'))
    app.get('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments', async context => {
      try { return context.json(inpatient.financialAdjustments.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    const financialInsurance = (action: 'cancel' | 'preview' | 'confirm') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema = action === 'cancel' ? inpatientFinancialInsuranceCancelInputSchema.omit({ admissionId: true, adjustmentId: true })
          : action === 'preview' ? inpatientFinancialInsurancePreviewInputSchema.omit({ admissionId: true, adjustmentId: true }) : inpatientFinancialInsuranceConfirmInputSchema.omit({ admissionId: true, adjustmentId: true })
        const body = z.object({ input: schema }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId'), adjustmentId: context.req.param('adjustmentId') }
        const currentActor = await actor(context), key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(inpatient.insuranceAdjustments[action](currentActor, input, key))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/cancel', financialInsurance('cancel'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/preview', financialInsurance('preview'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/:adjustmentId/insurance/confirm', financialInsurance('confirm'))
    const financialRefund = (action: 'preview' | 'confirm' | 'recover') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema = action === 'preview' ? inpatientFinancialRefundPreviewInputSchema.omit({ admissionId: true }) : action === 'confirm' ? inpatientFinancialRefundConfirmInputSchema.omit({ admissionId: true }) : inpatientFinancialRefundRecoverInputSchema.omit({ admissionId: true })
        const body = z.object({ input: schema }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, currentActor = await actor(context)
        const key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(action === 'preview' ? inpatient.financialAdjustments.refundPreview(currentActor, input, key)
          : action === 'confirm' ? inpatient.financialAdjustments.refundConfirm(currentActor, input, key) : inpatient.financialAdjustments.refundRecover(currentActor, input, key))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/preview', financialRefund('preview'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/confirm', financialRefund('confirm'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/refunds/recover', financialRefund('recover'))
    const financialPayment = (action: 'preview' | 'confirm' | 'recover') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema = action === 'preview' ? z.object(inpatientFinancialPaymentPreviewInputSchema.shape).omit({ admissionId: true }).strict() : action === 'confirm' ? inpatientPaymentConfirmInputSchema.omit({ admissionId: true }) : inpatientPaymentRecoverInputSchema.omit({ admissionId: true })
        const body = z.object({ input: schema }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, currentActor = await actor(context)
        const key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(action === 'preview' ? inpatient.financialAdjustments.paymentPreview(currentActor, input, key)
          : action === 'confirm' ? inpatient.financialAdjustments.paymentConfirm(currentActor, input, key) : inpatient.financialAdjustments.paymentRecover(currentActor, input, key))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/preview', financialPayment('preview'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/confirm', financialPayment('confirm'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments/payments/recover', financialPayment('recover'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/financial-adjustments', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientFinancialAdjustmentInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.financialAdjustments.adjust(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/discharge/preview', async context => {
      try { return context.json(inpatient.discharge.preview(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/discharge/settle', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSettleInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.discharge.settle(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/pci-selection', async context => {
      try { return context.json(inpatient.pciSelection.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/pci-selection/confirm', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientPciSelectionConfirmInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.pciSelection.confirm(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/surgery-catalog', async context => {
      try { return context.json(inpatient.surgery.catalog(await actor(context))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/surgeries', async context => {
      try { return context.json(inpatient.surgery.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/request', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryRequestInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.request(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    const surgeryPreparation = (action: 'check-preop' | 'confirm-consent' | 'cancel') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryActionInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.prepare(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key')), action))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/check-preop', surgeryPreparation('check-preop'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/confirm-consent', surgeryPreparation('confirm-consent'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/cancel', surgeryPreparation('cancel'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/start', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryStartInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.start(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/record-material', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryRecordMaterialInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.recordMaterial(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/correct-material', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryCorrectMaterialInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.correctMaterial(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/complete', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryCompleteInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.complete(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/surgeries/execute', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientSurgeryExecuteInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.surgery.execute(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/transfer-catalog', async context=>{
      try { return context.json(inpatient.transfers.catalog(await actor(context))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/transfers/incoming', async context=>{
      try { return context.json(inpatient.transfers.incoming(await actor(context))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/transfers', async context=>{
      try { return context.json(inpatient.transfers.read(await actor(context),context.req.param('admissionId'))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/transfers/request', async context=>{
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({input:inpatientTransferRequestInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.transfers.request(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    const transferAction=(action:'handover'|'receive'|'cancel')=>async(context:Context)=>{
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema=action==='receive'?inpatientTransferReceiveInputSchema:inpatientTransferActionInputSchema
        const body=z.object({input:schema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.transfers.action(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key')),action))
      } catch(error) { return apiErrorResponse(context,error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/transfers/handover',transferAction('handover'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/transfers/receive',transferAction('receive'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/transfers/cancel',transferAction('cancel'))
    app.get('/api/his/v1/inpatient/investigation-catalog', async context => {
      try { return context.json(inpatient.investigations.catalog(await actor(context),await options.imaging?.library.readyExamCodes() ?? new Set())) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/investigations', async context => {
      try { return context.json(inpatient.investigations.read(await actor(context),context.req.param('admissionId'))) } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/investigations/issue', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({input:inpatientInvestigationIssueInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.investigations.issue(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key')),await options.imaging?.library.readyExamCodes() ?? new Set()))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/investigations/acknowledge',async context=>{
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({input:inpatientInvestigationAcknowledgeInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        const bound=await actor(context),input={...body.input,admissionId:context.req.param('admissionId')}
        inpatient.admissionBinding(bound,input.admissionId)
        const request=inpatient.investigations.request(bound,input.admissionId,input.requestId)
        const available=request.request_kind!=='imaging' || await options.imaging?.results.studyAvailable(bound.workspaceId,bound.epoch,input.requestId)===true
        return context.json(inpatient.investigations.acknowledge(bound,input,z.string().min(8).max(128).parse(context.req.header('idempotency-key')),available))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    const investigationAction=(action:'send'|'cancel'|'retry')=>async(context:Context)=>{
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({input:inpatientInvestigationActionInputSchema.omit({admissionId:true})}).strict().parse(await context.req.json())
        return context.json(inpatient.investigations.action(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key')),action))
      } catch(error) { return apiErrorResponse(context,error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/investigations/send',investigationAction('send'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/investigations/cancel',investigationAction('cancel'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/investigations/retry',investigationAction('retry'))
    app.get('/api/his/v1/inpatient/pharmacy/admissions', async context => {
      try { return context.json(inpatient.orders.pharmacyList(await actor(context))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/pharmacy', async context => {
      try { return context.json(inpatient.orders.pharmacy(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/charges', async context => {
      try { return context.json(inpatient.orders.charges(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/clinical-catalog', async context => {
      try { return context.json(inpatient.orders.catalog(await actor(context))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId/clinical', async context => {
      try { return context.json(inpatient.orders.read(await actor(context), context.req.param('admissionId'))) } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/diagnoses/confirm', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: z.object(inpatientDiagnosisConfirmInputSchema.shape).omit({ admissionId: true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.confirmDiagnosis(await actor(context), { ...body.input, admissionId: context.req.param('admissionId') }, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/orders/issue', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientOrderIssueInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, bound = await actor(context), key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(inpatient.orders.issue(bound,input,key))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/orders/verify', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientOrderActionInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, bound = await actor(context), key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(inpatient.orders.action(bound,input,key,'verify'))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/orders/request-stop', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientOrderReasonInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, bound = await actor(context), key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(inpatient.orders.action(bound,input,key,'request-stop'))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/orders/verify-stop', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientOrderActionInputSchema.omit({ admissionId: true }) }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }, bound = await actor(context), key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(inpatient.orders.action(bound,input,key,'verify-stop'))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/executions/dispense', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({ input: inpatientDispenseInputSchema.omit({ admissionId:true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.dispense(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/executions/administer', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({ input: inpatientExecutionActionInputSchema.omit({ admissionId:true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.administer(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/executions/complete', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({ input: inpatientExecutionActionInputSchema.omit({ admissionId:true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.completeService(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/charges/reverse', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({ input: inpatientChargeReverseInputSchema.omit({ admissionId:true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.reverseCharge(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.post('/api/his/v1/inpatient/admissions/:admissionId/executions/request-prn', async context => {
      try { identity.assertTrustedMutation(context.req.raw.headers)
        const body=z.object({ input: inpatientOrderReasonInputSchema.omit({ admissionId:true }) }).strict().parse(await context.req.json())
        return context.json(inpatient.orders.requestPrn(await actor(context),{...body.input,admissionId:context.req.param('admissionId')},z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch(error) { return apiErrorResponse(context,error) }
    })
    app.get('/api/his/v1/inpatient/catalog', async context => {
      try { return context.json(inpatient.catalog(await actor(context))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/referrals', async context => {
      try { return context.json(inpatient.referrals(await actor(context))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/referrals', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientReferralInputSchema }).strict().parse(await context.req.json())
        return context.json(inpatient.issueReferral(await actor(context), body.input, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions', async context => {
      try { return context.json(inpatient.list(await actor(context))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/inpatient/admissions/:admissionId', async context => {
      try { return context.json(inpatient.detail(await actor(context), context.req.param('admissionId'))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    const bedAction = (action: 'receive' | 'move-bed' | 'swap-bed') => async (context: Context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const schema = action === 'swap-bed' ? inpatientSwapInputSchema.omit({ admissionId: true }) : inpatientBedInputSchema.omit({ admissionId: true })
        const body = z.object({ input: schema }).strict().parse(await context.req.json())
        const input = { ...body.input, admissionId: context.req.param('admissionId') }
        const bound = await actor(context)
        const key = z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
        return context.json(action === 'swap-bed' ? inpatient.swapBeds(bound, input, key) : inpatient.assignBed(bound, input, key, action))
      } catch (error) { return apiErrorResponse(context, error) }
    }
    app.post('/api/his/v1/inpatient/admissions/:admissionId/receive', bedAction('receive'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/move-bed', bedAction('move-bed'))
    app.post('/api/his/v1/inpatient/admissions/:admissionId/swap-bed', bedAction('swap-bed'))
    app.post('/api/sim/v1/scenario-runs/:scenarioRunId/actions/advance-time', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const bound = await actor(context)
        if (bound.scenarioRunId !== context.req.param('scenarioRunId')) throw new InpatientError('SCENARIO_RUN_MISMATCH', '场景轮次已变化')
        const body = z.object({ input: advanceVirtualTimeInputSchema }).strict().parse(await context.req.json())
        return context.json(inpatient.advanceTime(bound, body.input, z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/inpatient/admissions', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ input: inpatientRegistrationInputSchema }).strict().parse(await context.req.json())
        return context.json(inpatient.register(await actor(context), body.input,
          z.string().min(8).max(128).parse(context.req.header('idempotency-key'))))
      } catch (error) { return apiErrorResponse(context, error) }
    })
  }

  if (options.identity !== undefined && options.workflow !== undefined) {
    const identity = options.identity
    const workflow = options.workflow
    const actor = async (context: Context) => identity.resolveRequestActor(
      context.req.raw.headers,
      context.req.raw.method,
      context.req.path,
    )
    const idempotencyKey = (context: Context) => z.string().min(8).max(128).parse(
      context.req.header('idempotency-key'),
    )

    app.get('/api/his/v1/command-receipts', async (context) => {
      try {
        const query = z.object({
          idempotencyKey: z.string().min(8).max(128),
          operationId: z.string().min(1).max(128),
        }).strict().parse(context.req.query())
        return context.json(workflow.commandReceipt(
          await identity.resolveReceiptActor(
            context.req.raw.headers,
            context.req.raw.method,
            context.req.path,
            query.operationId,
          ),
          query.operationId,
          query.idempotencyKey,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })

    app.get('/api/his/v1/catalogs/registration', async (context) => {
      try {
        return context.json(workflow.registrationCatalog(await actor(context)))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/catalogs/clinical', async (context) => {
      try {
        return context.json(workflow.clinicalCatalog(await actor(context)))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/catalogs/services', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          query: z.string().trim().min(1).max(200).optional(),
        }).parse(context.req.query())
        return context.json(workflow.serviceCatalog(await actor(context), {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.query === undefined ? {} : { query: query.query }),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/services/:serviceId/actions/order', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const request = orderHospitalServiceRequestSchema.parse(await context.req.json())
        return context.json(workflow.orderHospitalService({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: request.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          serviceId: context.req.param('serviceId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Hospital Service order request is invalid')
      }
    })
    app.post('/api/his/v1/service-requests/:serviceRequestId/actions/complete', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const request = completeHospitalServiceRequestSchema.parse(await context.req.json())
        return context.json(workflow.completeHospitalService({
          context: await actor(context),
          expectedVersions: request.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          serviceRequestId: context.req.param('serviceRequestId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Hospital Service completion request is invalid')
      }
    })
    app.get('/api/his/v1/patients', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          query: z.string().trim().min(1),
        }).parse(context.req.query())
        return context.json(workflow.searchPatients({
          context: await actor(context),
          page: query.page,
          pageSize: query.pageSize,
          query: query.query,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/registrations', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }).parse(context.req.query())
        return context.json(workflow.registrationQueue(
          await actor(context),
          query.pageSize,
          query.page,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/patients', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            birthDate: z.iso.date(),
            gender: z.enum(['female', 'male', 'other', 'unknown']),
            identifier: z.string().trim().min(3).max(64),
            name: z.string().trim().min(2).max(80),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.createPatient({
          context: await actor(context),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          patient: body.input,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/registrations/actions/register', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            departmentId: z.string().min(1),
            locationId: z.string().min(1),
            patientId: z.string().min(1),
            visitDate: z.iso.date(),
            visitTypeId: z.string().min(1),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.register({
          context: await actor(context),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          registration: body.input,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/triage/queue', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          status: z.enum(['completed', 'exception', 'pending']).default('pending'),
        }).parse(context.req.query())
        return context.json(workflow.triageQueue(
          await actor(context),
          query.pageSize,
          query.status,
          query.page,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/record-triage', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            acuityCode: z.enum(['level-1', 'level-2', 'level-3', 'level-4']),
            bloodPressure: z.object({
              diastolicMmHg: z.number().int().min(30).max(180),
              systolicMmHg: z.number().int().min(50).max(260),
            }),
            chiefComplaint: z.string().trim().min(2).max(500),
            oxygenSaturationPct: z.number().min(50).max(100),
            pulseBpm: z.number().int().min(20).max(250),
            respirationBpm: z.number().int().min(5).max(80),
            temperatureC: z.number().min(30).max(45),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.recordTriage({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          triage: body.input,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/doctor/queue', async (context) => {
      try {
        const query = z.object({
          view: doctorQueueViewSchema.optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }).parse(context.req.query())
        return context.json(workflow.doctorQueue(
          await actor(context),
          query.pageSize,
          query.page,
          query.view,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/doctor/completed-cases', async (context) => {
      try {
        const query = z.object({
          completedFrom: z.iso.date().optional(),
          completedTo: z.iso.date().optional(),
          diagnosisCatalogItemId: referenceDataItemIdSchema.optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          patientId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
        }).refine(value => (
          value.completedFrom === undefined
          || value.completedTo === undefined
          || value.completedFrom <= value.completedTo
        ), {
          message: 'completedFrom must not be after completedTo',
          path: ['completedFrom'],
        }).parse(context.req.query())
        return context.json(workflow.doctorCompletedCases(
          await actor(context),
          query,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/doctor/completed-cases/:caseId', async (context) => {
      try {
        const caseId = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).parse(
          context.req.param('caseId'),
        )
        return context.json(workflow.doctorCompletedCaseDetail(
          await actor(context),
          caseId,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    if (options.investigation !== undefined && options.referenceData !== undefined) {
      app.get('/api/his/v1/doctor/cases/:caseId/reference-catalogs/laboratory', async (context) => {
        try {
          return context.json(workflow.caseLaboratoryCatalog(
            await actor(context),
            context.req.param('caseId'),
            referenceCatalogQuery(context),
          ))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
    }
    if (options.doctorRecommendations !== undefined) {
      app.get('/api/his/v1/doctor/cases/:caseId/recommendations/:kind', async (context) => {
        try {
          return context.json(await options.doctorRecommendations!.read(
            await actor(context), context.req.param('caseId'), doctorRecommendationKindSchema.parse(context.req.param('kind')),
          ))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.post('/api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/confirm', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          return context.json(await options.doctorRecommendations!.confirm(
            await actor(context), context.req.param('caseId'), doctorRecommendationKindSchema.parse(context.req.param('kind')),
            confirmDoctorPreparationRequestSchema.parse(await context.req.json()), requestIdempotencyKey(context),
          ))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.post('/api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/generate', async (context) => {
        try {
          return context.json(await options.doctorRecommendations!.generate(
            await actor(context), context.req.param('caseId'), doctorRecommendationKindSchema.parse(context.req.param('kind')),
            generateDoctorRecommendationsRequestSchema.parse(await context.req.json()), requestIdempotencyKey(context),
          ))
        } catch (error) { return apiErrorResponse(context, error) }
      })
      app.post('/api/his/v1/doctor/cases/:caseId/recommendations/:kind/considerations/disposition', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          return context.json(await options.doctorRecommendations!.setConsiderationDisposition(
            await actor(context), context.req.param('caseId'), doctorConsiderationDispositionKindSchema.parse(context.req.param('kind')),
            setDoctorConsiderationDispositionRequestSchema.parse(await context.req.json()),
          ))
        } catch (error) { return apiErrorResponse(context, error) }
      })
    }
    app.get('/api/his/v1/doctor/cases/:caseId/recording-events', async context => {
      try {
        const bound = await actor(context)
        const caseId = context.req.param('caseId')
        const since = z.string().regex(/^[a-f0-9]{64}$/).optional().parse(context.req.query('since'))
        let current = workflow.doctorCaseRecordingRevision(bound, caseId)
        if (since === current && options.commandEvents !== undefined) {
          await new Promise<void>(resolve => {
            const finish = () => {
              clearTimeout(timer); dispose()
              context.req.raw.signal.removeEventListener('abort', finish)
              options.recordingUpdatesSignal?.removeEventListener('abort', finish)
              resolve()
            }
            const dispose = options.commandEvents!.subscribe((source, effects) => {
              if (source.workspaceId === bound.workspaceId && source.epoch === bound.epoch && effects.some(effect =>
                [`ConsultationRecording/${caseId}`, `ClinicalDocumentDraft/${caseId}`, `Consultation/${caseId}`].includes(effect.reference))) finish()
            })
            const timer = setTimeout(finish, 10_000)
            context.req.raw.signal.addEventListener('abort', finish, { once: true })
            options.recordingUpdatesSignal?.addEventListener('abort', finish, { once: true })
            if (context.req.raw.signal.aborted || options.recordingUpdatesSignal?.aborted) finish()
          })
          if (options.recordingUpdatesSignal?.aborted) return context.body(null, 503)
          current = workflow.doctorCaseRecordingRevision(await actor(context), caseId)
        }
        context.header('Cache-Control', 'no-store')
        return context.json({ revision: current })
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/doctor/cases/:caseId', async (context) => {
      try {
        return context.json(workflow.doctorCaseDetail(
          await actor(context),
          context.req.param('caseId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/encounters/:encounterId/completion', async (context) => {
      try {
        return context.json(workflow.encounterCompletionPreview(
          await actor(context),
          context.req.param('encounterId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/complete', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = completeEncounterRequestSchema.parse(await context.req.json())
        return context.json(workflow.completeEncounter({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/ask-consultation-question', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            expectedConsultationVersion: z.number().int().positive(),
            message: z.string().trim().min(1).max(2_000),
          }).strict(),
        }).strict().parse(await context.req.json())
        const dialogue = requireConsultationDialogue()
        return context.json(await dialogue.ask({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedConsultationVersion: body.input.expectedConsultationVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          message: body.input.message,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/retry-consultation-reply', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.object({}).strict(),
          input: z.object({
            expectedConsultationVersion: z.number().int().positive(),
          }).strict(),
        }).strict().parse(await context.req.json())
        const dialogue = requireConsultationDialogue()
        return context.json(await dialogue.retryReply({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedConsultationVersion: body.input.expectedConsultationVersion,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/his/v1/encounters/:encounterId/diagnosis/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = saveDiagnosisDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.saveDiagnosisDraft({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          entries: body.input.entries,
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/diagnosis/actions/confirm', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = confirmDiagnosisRequestSchema.parse(await context.req.json())
        return context.json(workflow.confirmDiagnosis({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/his/v1/encounters/:encounterId/prescription/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = savePrescriptionDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.savePrescriptionDraft({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          items: body.input.items,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.delete('/api/his/v1/encounters/:encounterId/prescription/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = deletePrescriptionDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.deletePrescriptionDraft({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/prescription/actions/issue', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = issuePrescriptionRequestSchema.parse(await context.req.json())
        return context.json(workflow.issuePrescription({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/medication-conclusion/actions/confirm-no-medication', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = confirmNoMedicationRequestSchema.parse(await context.req.json())
        return context.json(workflow.confirmNoMedication({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/consultation-recording/actions/control', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = controlConsultationRecordingRequestSchema.parse(await context.req.json())
        return context.json(workflow.consultationRecording.control({
          ...body.input, context: await actor(context), encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions, idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.get('/api/his/v1/doctor/cases/:caseId/document-quality-control', async context => {
      try {
        const clientId = context.req.query('clientId')
        if (clientId !== undefined) z.string().min(1).max(128).parse(clientId)
        return context.json(workflow.qualityControl.read(await actor(context), context.req.param('caseId'), clientId))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/check', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        return context.json(workflow.qualityControl.check(await actor(context), context.req.param('caseId'),
          checkClinicalDocumentQualityRequestSchema.parse(await context.req.json()), idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/doctor/cases/:caseId/document-quality-control/actions/retain', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        return context.json(workflow.qualityControl.retain(await actor(context), context.req.param('caseId'),
          retainClinicalDocumentQualityIssueRequestSchema.parse(await context.req.json()), idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.put('/api/his/v1/encounters/:encounterId/clinical-document/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = saveClinicalDocumentDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.saveClinicalDocumentDraft({
          context: await actor(context),
          document: body.input.document,
          ...(body.input.agentGenerated === undefined ? {} : { agentGenerated: body.input.agentGenerated }),
          ...(body.input.agentFacts === undefined ? {} : { agentFacts: body.input.agentFacts }),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/clinical-document/actions/preview-sign', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = previewClinicalDocumentSignRequestSchema.parse(await context.req.json())
        return context.json(workflow.previewStructuredClinicalDocumentSign({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/clinical-document/actions/cancel-sign', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = cancelClinicalDocumentSignRequestSchema.parse(await context.req.json())
        return context.json(workflow.cancelStructuredClinicalDocumentSign({
          context: await actor(context), encounterId: context.req.param('encounterId'),
          previewId: body.input.previewId, expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/encounters/:encounterId/clinical-document/actions/sign', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = signClinicalDocumentRequestSchema.parse(await context.req.json())
        return context.json(workflow.signStructuredClinicalDocument({
          commitToken: body.input.commitToken,
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          previewId: body.input.previewId,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/start-first-visit', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({}),
        }).parse(await context.req.json())
        return context.json(workflow.startFirstVisit({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/start-revisit', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({}),
        }).parse(await context.req.json())
        return context.json(workflow.startRevisit({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/his/v1/encounters/:encounterId/drafts/first-visit', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            assessment: z.string().trim().min(2).max(2_000),
            expectedDraftVersion: z.number().int().min(0),
            historyOfPresentIllness: z.string().trim().min(2).max(5_000),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.saveFirstVisitDraft({
          context: await actor(context),
          draft: body.input,
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/his/v1/encounters/:encounterId/drafts/revisit', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            diagnosis: z.object({
              code: z.string().trim().min(2).max(24),
              display: z.string().trim().min(2).max(240),
            }),
            document: z.object({
              assessment: z.string().trim().min(2).max(4_000),
              plan: z.string().trim().min(2).max(4_000),
            }),
            expectedVersions: z.object({
              documentDraft: z.number().int().min(0),
              prescription: z.number().int().min(0),
              revisitDraft: z.number().int().min(0),
            }),
            medications: z.array(z.object({
              catalogItemId: z.string().min(1),
              doseText: z.string().trim().min(1).max(120),
              frequencyCode: z.string().trim().min(1).max(32),
              quantity: z.number().int().min(1).max(1_000),
            })).min(1).max(8),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.saveRevisitDraft({
          context: await actor(context),
          draft: body.input,
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/preview-sign', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            expectedDraftVersions: z.object({
              documentDraft: z.number().int().min(1),
              prescription: z.number().int().min(1),
              revisitDraft: z.number().int().min(1),
            }),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.previewClinicalSign({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersions: body.input.expectedDraftVersions,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/actions/sign-and-complete', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            commitToken: z.string().min(16).max(256),
            previewId: z.string().min(1).max(128),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.signAndComplete({
          commitToken: body.input.commitToken,
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          previewId: body.input.previewId,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/clinical-documents/:compositionId/actions/revise', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = reviseClinicalDocumentRequestSchema.parse(await context.req.json())
        return context.json(workflow.reviseClinicalDocument({
          compositionId: context.req.param('compositionId'),
          context: await actor(context),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          reason: body.input.reason,
          revision: 'document' in body.input
            ? { document: body.input.document }
            : { assessment: body.input.assessment, plan: body.input.plan },
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/his/v1/encounters/:encounterId/laboratory-request/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = saveLaboratoryRequestDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.saveLaboratoryRequestDraft({
          catalogItemId: body.input.catalogItemId,
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          indicationCode: body.input.indicationCode,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.delete('/api/his/v1/encounters/:encounterId/laboratory-request/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = deleteLaboratoryRequestDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.deleteLaboratoryRequestDraft({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/encounters/:encounterId/laboratory-request/actions/issue', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = issueLaboratoryRequestRequestSchema.parse(await context.req.json())
        return context.json(workflow.issueLaboratoryRequest({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/laboratory-requests/:requestId/actions/cancel', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = cancelLaboratoryRequestRequestSchema.parse(await context.req.json())
        return context.json(workflow.cancelLaboratoryRequest({
          context: await actor(context),
          expectedRequestVersion: body.input.expectedRequestVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          reasonCode: body.input.reasonCode,
          requestId: context.req.param('requestId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/laboratory-requests/:requestId/actions/retry-generation', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = retryLaboratoryResultGenerationRequestSchema.parse(await context.req.json())
        return context.json(workflow.retryLaboratoryResultGeneration({
          context: await actor(context),
          expectedRequestVersion: body.input.expectedRequestVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          requestId: context.req.param('requestId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post(
      '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
      async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = acknowledgeLaboratoryReportRequestSchema.parse(await context.req.json())
          return context.json(workflow.acknowledgeLaboratoryReport({
            context: await actor(context),
            diagnosticReportId: context.req.param('diagnosticReportId'),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            requestId: context.req.param('requestId'),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      },
    )
    app.post(
      '/api/his/v1/laboratory-requests/:requestId/reports/:diagnosticReportId/actions/correct',
      async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = correctLaboratoryReportRequestSchema.parse(await context.req.json())
          const authenticatedContext = await identity.resolveAdministratorActor(
            context.req.raw.headers,
            context.req.raw.method,
            context.req.path,
          )
          return context.json(workflow.correctLaboratoryReport({
            conclusion: body.input.conclusion,
            context: {
              actorId: authenticatedContext.actorId,
              epoch: authenticatedContext.epoch,
              ...(authenticatedContext.organizationId === undefined ? {} : {
                organizationId: authenticatedContext.organizationId,
              }),
              ...(authenticatedContext.locationId === undefined ? {} : {
                locationId: authenticatedContext.locationId,
              }),
              ...(authenticatedContext.practitionerId === undefined ? {} : {
                practitionerId: authenticatedContext.practitionerId,
              }),
              ...(authenticatedContext.practitionerRoleId === undefined ? {} : {
                practitionerRoleId: authenticatedContext.practitionerRoleId,
              }),
              roleCode: 'lis-system',
              scenarioRunId: authenticatedContext.scenarioRunId,
              workspaceId: authenticatedContext.workspaceId,
            },
            diagnosticReportId: context.req.param('diagnosticReportId'),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            reason: body.input.reason,
            requestId: context.req.param('requestId'),
            results: body.input.results,
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      },
    )
    if (options.imaging !== undefined) {
      const { library, reader, results } = options.imaging
      // 阅片器的读取通道：描述与像素块都只面向责任医生，响应不进入任何共享缓存。
      app.get('/api/his/v1/imaging-studies/:studyId', async (context) => {
        context.header('Cache-Control', 'private, no-store')
        try {
          const context_ = await actor(context)
          const studyId = context.req.param('studyId')
          try {
            return context.json(await reader.describeStudy(context_, studyId))
          } catch (error) {
            // 病理检查与放射检查共用同一个本院检查入口：不是放射检查时交给病理读取边界，放射读取的语句预算不变。
            const pathologyStudy = error instanceof ImagingStudyReadError && error.code === 'IMAGING_STUDY_NOT_FOUND'
              ? await options.pathology?.reader.describeStudy(context_, studyId)
              : undefined
            if (pathologyStudy === undefined) throw error
            return context.json(pathologyStudy)
          }
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.get(
        '/api/his/v1/imaging-studies/:studyId/series/:seriesIndex/frames/:frameIndex/blocks/:blockIndex',
        async (context) => {
          context.header('Cache-Control', 'private, no-store')
          try {
            const position = pixelBlockPositionSchema.parse(context.req.param())
            const bytes = await reader.readStudyBlock(await actor(context), context.req.param('studyId'), position)
            return context.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream' })
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
      app.get('/api/his/v1/doctor/cases/:caseId/imaging-services', async (context) => {
        try {
          const context_ = await actor(context)
          workflow.doctorCaseDetail(context_, context.req.param('caseId'))
          return context.json(workflow.imaging.serviceCatalog(context_, await library.readyExamCodes()))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.put('/api/his/v1/encounters/:encounterId/imaging-request/draft', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = saveImagingRequestDraftRequestSchema.parse(await context.req.json())
          return context.json(workflow.imaging.saveDraft({
            context: await actor(context),
            encounterId: context.req.param('encounterId'),
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            indication: body.input.indication,
            serviceId: body.input.serviceId,
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.delete('/api/his/v1/encounters/:encounterId/imaging-request/draft', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = deleteImagingRequestDraftRequestSchema.parse(await context.req.json())
          return context.json(workflow.imaging.deleteDraft({
            context: await actor(context),
            encounterId: context.req.param('encounterId'),
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/encounters/:encounterId/imaging-request/actions/issue', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = issueImagingRequestRequestSchema.parse(await context.req.json())
          return context.json(workflow.imaging.issue({
            context: await actor(context),
            encounterId: context.req.param('encounterId'),
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            readyExamCodes: await library.readyExamCodes(),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/imaging-requests/:requestId/actions/cancel', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = cancelImagingRequestRequestSchema.parse(await context.req.json())
          return context.json(workflow.imaging.cancel({
            context: await actor(context),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            reasonCode: body.input.reasonCode,
            requestId: context.req.param('requestId'),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/imaging-requests/:requestId/actions/retry', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = retryImagingRequestRequestSchema.parse(await context.req.json())
          return context.json(workflow.imaging.retry({
            context: await actor(context),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            requestId: context.req.param('requestId'),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post(
        '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
        async (context) => {
          try {
            identity.assertTrustedMutation(context.req.raw.headers)
            const body = acknowledgeImagingReportRequestSchema.parse(await context.req.json())
            const context_ = await actor(context)
            const requestId = context.req.param('requestId')
            return context.json(workflow.imaging.acknowledge({
              context: context_,
              diagnosticReportId: context.req.param('diagnosticReportId'),
              expectedRequestVersion: body.input.expectedRequestVersion,
              expectedVersions: body.expectedVersions,
              idempotencyKey: idempotencyKey(context),
              requestId,
              studyAvailable: await results.studyAvailable(context_.workspaceId, context_.epoch, requestId),
            }))
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
      app.post(
        '/api/his/v1/imaging-requests/:requestId/reports/:diagnosticReportId/actions/correct',
        async (context) => {
          try {
            identity.assertTrustedMutation(context.req.raw.headers)
            const body = correctImagingReportRequestSchema.parse(await context.req.json())
            const administrator = await identity.resolveAdministratorActor(
              context.req.raw.headers,
              context.req.raw.method,
              context.req.path,
            )
            const requestId = context.req.param('requestId')
            // 解析失败不在这里抛出：命令先按幂等键返回已提交的回执，只有真正执行时才使用解析结果。
            const resolution = await results.resolveCorrection(
              administrator.workspaceId,
              administrator.epoch,
              requestId,
              body.input.reportRevision,
            ).then(result => ({ result }), (error: unknown) => ({
              error: error instanceof ImagingResultUnavailableError
                ? new WorkflowError(
                    'WORKFLOW_CONFLICT',
                    'The correction must use a reviewed report revision of the same imaging asset',
                  )
                : error,
            }))
            return context.json(workflow.imaging.correct({
              // 更正由管理员发起，以放射系统执行者的身份签发，与检验更正一致。
              context: { ...administrator, roleCode: 'ris-system' },
              diagnosticReportId: context.req.param('diagnosticReportId'),
              expectedRequestVersion: body.input.expectedRequestVersion,
              expectedVersions: body.expectedVersions,
              idempotencyKey: idempotencyKey(context),
              reason: body.input.reason,
              reportRevision: body.input.reportRevision,
              requestId,
              resolution,
            }))
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
    }
    if (options.pathology !== undefined) {
      const { preparation, reader, results } = options.pathology
      // 切片瓦片的读取通道：只面向责任医生，响应不进入任何共享缓存。
      app.get(
        '/api/his/v1/imaging-studies/:studyId/series/:seriesIndex/levels/:level/tiles/:column/:row',
        async (context) => {
          context.header('Cache-Control', 'private, no-store')
          try {
            const position = slideTilePositionSchema.parse(context.req.param())
            const bytes = await reader.readStudyTile(await actor(context), context.req.param('studyId'), position)
            return context.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream' })
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
      app.get('/api/his/v1/doctor/cases/:caseId/pathology-services', async (context) => {
        try {
          const context_ = await actor(context)
          const outpatientCaseId = context.req.param('caseId')
          workflow.doctorCaseDetail(context_, outpatientCaseId)
          const offering = await preparation.offering(context_, { outpatientCaseId })
          return context.json(workflow.pathology.serviceCatalog(context_, offering.readyExamCodes, offering.sourceProcedures))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.put('/api/his/v1/encounters/:encounterId/pathology-request/draft', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = savePathologyRequestDraftRequestSchema.parse(await context.req.json())
          const context_ = await actor(context)
          const encounterId = context.req.param('encounterId')
          return context.json(workflow.pathology.saveDraft({
            context: context_,
            encounterId,
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            purpose: body.input.purpose,
            serviceId: body.input.serviceId,
            sourceProcedureReference: body.input.sourceProcedureReference,
            sourceProcedures: (await preparation.offering(context_, { encounterId })).sourceProcedures,
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.delete('/api/his/v1/encounters/:encounterId/pathology-request/draft', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = deletePathologyRequestDraftRequestSchema.parse(await context.req.json())
          return context.json(workflow.pathology.deleteDraft({
            context: await actor(context),
            encounterId: context.req.param('encounterId'),
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/encounters/:encounterId/pathology-request/actions/issue', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = issuePathologyRequestRequestSchema.parse(await context.req.json())
          const context_ = await actor(context)
          const encounterId = context.req.param('encounterId')
          const offering = await preparation.offering(context_, { encounterId })
          return context.json(workflow.pathology.issue({
            context: context_,
            encounterId,
            expectedDraftVersion: body.input.expectedDraftVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            readyExamCodes: offering.readyExamCodes,
            sourceProcedures: offering.sourceProcedures,
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/pathology-requests/:requestId/actions/cancel', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = cancelPathologyRequestRequestSchema.parse(await context.req.json())
          return context.json(workflow.pathology.cancel({
            context: await actor(context),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            reasonCode: body.input.reasonCode,
            requestId: context.req.param('requestId'),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post('/api/his/v1/pathology-requests/:requestId/actions/retry', async (context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body = retryPathologyRequestRequestSchema.parse(await context.req.json())
          return context.json(workflow.pathology.retry({
            context: await actor(context),
            expectedRequestVersion: body.input.expectedRequestVersion,
            expectedVersions: body.expectedVersions,
            idempotencyKey: idempotencyKey(context),
            requestId: context.req.param('requestId'),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
      app.post(
        '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
        async (context) => {
          try {
            identity.assertTrustedMutation(context.req.raw.headers)
            const body = acknowledgePathologyReportRequestSchema.parse(await context.req.json())
            const context_ = await actor(context)
            const requestId = context.req.param('requestId')
            return context.json(workflow.pathology.acknowledge({
              context: context_,
              diagnosticReportId: context.req.param('diagnosticReportId'),
              expectedRequestVersion: body.input.expectedRequestVersion,
              expectedVersions: body.expectedVersions,
              idempotencyKey: idempotencyKey(context),
              requestId,
              studyAvailable: await results.studyAvailable(context_.workspaceId, context_.epoch, requestId),
            }))
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
      app.post(
        '/api/his/v1/pathology-requests/:requestId/reports/:diagnosticReportId/actions/correct',
        async (context) => {
          try {
            identity.assertTrustedMutation(context.req.raw.headers)
            const body = correctPathologyReportRequestSchema.parse(await context.req.json())
            const administrator = await identity.resolveAdministratorActor(
              context.req.raw.headers,
              context.req.raw.method,
              context.req.path,
            )
            const requestId = context.req.param('requestId')
            // 解析失败不在这里抛出：命令先按幂等键返回已提交的回执，只有真正执行时才使用解析结果。
            const resolution = await results.resolveCorrection(
              administrator.workspaceId,
              administrator.epoch,
              requestId,
              body.input.reportRevision,
            ).then(result => ({ result }), (error: unknown) => ({
              error: error instanceof PathologyResultUnavailableError
                ? new WorkflowError(
                    'WORKFLOW_CONFLICT',
                    'The correction must use a reviewed report revision of the same slide asset',
                  )
                : error,
            }))
            return context.json(workflow.pathology.correct({
              // 更正由管理员发起，以病理系统执行者的身份签发，与检验、放射更正一致。
              context: { ...administrator, roleCode: 'pathology-system' },
              diagnosticReportId: context.req.param('diagnosticReportId'),
              expectedRequestVersion: body.input.expectedRequestVersion,
              expectedVersions: body.expectedVersions,
              idempotencyKey: idempotencyKey(context),
              reason: body.input.reason,
              reportRevision: body.input.reportRevision,
              requestId,
              resolution,
            }))
          } catch (error) {
            return apiErrorResponse(context, error)
          }
        },
      )
    }
    app.post('/api/his/v1/encounters/:encounterId/actions/issue-laboratory-order', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            catalogItemId: z.string().min(1),
            expectedDraftVersion: z.number().int().min(1),
            indicationCode: z.string().min(1).max(64),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.issueLaboratoryOrder({
          catalogItemId: body.input.catalogItemId,
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedDraftVersion: body.input.expectedDraftVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          indicationCode: body.input.indicationCode,
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/insurance/:kind/:id', async context => {
      try { return context.json(workflow.insurance.state(await actor(context),insuranceTargetSchema.parse({kind:context.req.param('kind'),id:context.req.param('id')}))) }
      catch(error){return apiErrorResponse(context,error)}
    })
    const insuranceAction = (action: 'preview' | 'confirm' | 'cancel') => async (context: Context) => {
        try {
          identity.assertTrustedMutation(context.req.raw.headers)
          const body=z.object({input:z.record(z.string(),z.unknown()),expectedVersions:z.record(z.string(),z.string())}).strict().parse(await context.req.json())
          const target=insuranceTargetSchema.parse({kind:context.req.param('kind'),id:context.req.param('id')})
          const raw={...body.input,target},acting=await actor(context),key=idempotencyKey(context)
          if(action==='preview')return context.json(workflow.insurance.preview(acting,insurancePreviewInputSchema.parse(raw),key))
          if(action==='confirm')return context.json(workflow.insurance.confirm(acting,insuranceConfirmInputSchema.parse(raw),key))
          return context.json(workflow.insurance.cancel(acting,insuranceCancelInputSchema.parse(raw),key))
        }catch(error){return apiErrorResponse(context,error)}
    }
    app.post('/api/his/v1/insurance/:kind/:id/preview', insuranceAction('preview'))
    app.post('/api/his/v1/insurance/:kind/:id/confirm', insuranceAction('confirm'))
    app.post('/api/his/v1/insurance/:kind/:id/cancel', insuranceAction('cancel'))
    app.get('/api/his/v1/billing/cases/:caseId', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }).parse(context.req.query())
        return context.json(workflow.billingCase({ context: await actor(context), caseId: context.req.param('caseId'), ...query }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/billing/queue', async (context) => {
      try {
        const query = z.object({
          category: z.enum(['laboratory', 'imaging', 'pathology', 'medication']),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          status: z.enum(['ambiguous', 'declined', 'paid', 'pending']).default('pending'),
        }).parse(context.req.query())
        return context.json(workflow.billingQueue({
          ...query,
          context: await actor(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/pharmacy/queue', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          status: z.enum(['completed', 'exception', 'pending']).default('pending'),
        }).parse(context.req.query())
        return context.json(workflow.pharmacyQueue({
          ...query,
          context: await actor(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/prescriptions/:prescriptionId/actions/dispense', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            expectedPrescriptionVersion: z.number().int().min(1),
            lotSelections: z.array(z.object({
              expectedVersion: z.number().int().min(1),
              lotId: z.string().min(1).max(128),
              quantity: z.number().int().min(1).max(100_000),
            })).min(1).max(32),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.dispensePrescription({
          context: await actor(context),
          expectedPrescriptionVersion: body.input.expectedPrescriptionVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          lotSelections: body.input.lotSelections,
          prescriptionId: context.req.param('prescriptionId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/prescriptions/:prescriptionId/actions/withdraw', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = withdrawPrescriptionRequestSchema.parse(await context.req.json())
        return context.json(workflow.withdrawPrescription({
          context: await actor(context),
          expectedPrescriptionVersion: body.input.expectedPrescriptionVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          prescriptionId: context.req.param('prescriptionId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/prescriptions/:prescriptionId/actions/review', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            expectedPrescriptionVersion: z.number().int().min(1),
            note: z.string().trim().min(2).max(500),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.reviewPrescription({
          context: await actor(context),
          expectedPrescriptionVersion: body.input.expectedPrescriptionVersion,
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          note: body.input.note,
          prescriptionId: context.req.param('prescriptionId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/payments/actions/preview', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({
            caseId: z.string().min(1),
            category: z.enum(['laboratory', 'imaging', 'pathology', 'medication']),
            chargeItemId: z.string().min(1).optional(),
            simulatorRule: paymentSimulatorRuleSchema,
            tenders: paymentTendersSchema.optional(),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.previewPayment({
          ...body.input,
          context: await actor(context),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/his/v1/billing/cases/:caseId/refunds', async context => {
      try { return context.json(workflow.refunds.read(await actor(context), context.req.param('caseId'))) }
      catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/billing/cases/:caseId/adjustments', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ expectedVersions: z.record(z.string(), z.string()), input: chargeAdjustmentInputSchema }).strict().parse(await context.req.json())
        return context.json(workflow.refunds.adjust(await actor(context), context.req.param('caseId'), body.input, body.expectedVersions, idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/refunds/actions/preview', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ expectedVersions: z.record(z.string(), z.string()), input: refundPreviewInputSchema }).strict().parse(await context.req.json())
        return context.json(workflow.refunds.preview(await actor(context), body.input, body.expectedVersions, idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/refunds/:previewId/actions/confirm', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ expectedVersions: z.record(z.string(), z.string()), input: refundConfirmInputSchema }).strict().parse(await context.req.json())
        return context.json(workflow.refunds.confirm(await actor(context), context.req.param('previewId'), body.input, body.expectedVersions, idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/refunds/:refundId/actions/recover', async context => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({ expectedVersions: z.record(z.string(), z.string()), input: refundRecoverInputSchema }).strict().parse(await context.req.json())
        return context.json(workflow.refunds.recover(await actor(context), context.req.param('refundId'), body.input, body.expectedVersions, idempotencyKey(context)))
      } catch (error) { return apiErrorResponse(context, error) }
    })
    app.post('/api/his/v1/payments/:paymentId/actions/recover', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({ expectedPaymentVersion: z.number().int().positive() }).strict(),
        }).strict().parse(await context.req.json())
        return context.json(workflow.recoverPayment({
          ...body.input, context: await actor(context), expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context), paymentId: context.req.param('paymentId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/payments/:previewId/actions/confirm', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.record(z.string(), z.string()),
          input: z.object({ commitToken: z.string().min(16).max(256) }),
        }).parse(await context.req.json())
        return context.json(workflow.confirmPayment({
          commitToken: body.input.commitToken,
          context: await actor(context),
          expectedVersions: body.expectedVersions,
          idempotencyKey: idempotencyKey(context),
          previewId: context.req.param('previewId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
  }

  app.get('/fhir/R5/metadata', async (context) => {
    try {
      await options.fhir?.resolveContext(context.req.raw)
      return context.json(
        createCapabilityStatement({ includeResources: options.fhir !== undefined }),
        200,
        { 'Content-Type': 'application/fhir+json' },
      )
    } catch (error) {
      return fhirErrorResponse(context, error)
    }
  })

  if (options.fhir !== undefined) {
    const fhirRuntime = options.fhir

    app.put('/fhir/R5/:resourceType/:resourceId', (context) => {
      const resourceType = context.req.param('resourceType')
      const diagnostic = isSupportedResourceType(resourceType)
        ? `Direct update of ${resourceType} is not supported; use the owning business command`
        : `Resource type ${resourceType} is not supported`
      return context.json(operationOutcome('not-supported', diagnostic), 405, {
        Allow: 'GET',
        'Content-Type': 'application/fhir+json',
      })
    })

    app.get('/fhir/R5/:resourceType/:resourceId/_history/:versionId', async (context) => {
      try {
        const resourceType = context.req.param('resourceType')
        if (!isSupportedResourceType(resourceType)) {
          throw new FhirRepositoryError('NOT_SUPPORTED', `Resource type ${resourceType} is not supported`)
        }
        const repositoryContext = await fhirRuntime.resolveContext(context.req.raw)
        const resource = fhirRuntime.repository.vread(
          repositoryContext,
          resourceType,
          context.req.param('resourceId'),
          context.req.param('versionId'),
        )
        return context.json(resource, 200, {
          'Content-Type': 'application/fhir+json',
          ETag: `W/"${resource.meta?.versionId}"`,
        })
      } catch (error) {
        return fhirErrorResponse(context, error)
      }
    })

    app.get('/fhir/R5/:resourceType/:resourceId/_history', async (context) => {
      try {
        const resourceType = context.req.param('resourceType')
        if (!isSupportedResourceType(resourceType)) {
          throw new FhirRepositoryError('NOT_SUPPORTED', `Resource type ${resourceType} is not supported`)
        }
        const repositoryContext = await fhirRuntime.resolveContext(context.req.raw)
        const resources = fhirRuntime.repository.history(
          repositoryContext,
          resourceType,
          context.req.param('resourceId'),
        )
        const baseUrl = new URL(context.req.url)
        const body = {
          resourceType: 'Bundle' as const,
          type: 'history' as const,
          total: resources.length,
          link: [{ relation: 'self', url: baseUrl.toString() }],
          entry: resources.map(resource => ({
            fullUrl: new URL(`/fhir/R5/${resource.resourceType}/${resource.id}`, baseUrl).toString(),
            resource,
          })),
        }
        return context.json(body, 200, { 'Content-Type': 'application/fhir+json' })
      } catch (error) {
        return fhirErrorResponse(context, error)
      }
    })

    app.get('/fhir/R5/:resourceType/:resourceId', async (context) => {
      try {
        const resourceType = context.req.param('resourceType')
        if (!isSupportedResourceType(resourceType)) {
          throw new FhirRepositoryError('NOT_SUPPORTED', `Resource type ${resourceType} is not supported`)
        }
        const repositoryContext = await fhirRuntime.resolveContext(context.req.raw)
        const resource = fhirRuntime.repository.read(
          repositoryContext,
          resourceType,
          context.req.param('resourceId'),
        )
        return context.json(resource, 200, {
          'Content-Type': 'application/fhir+json',
          ETag: `W/"${resource.meta?.versionId}"`,
        })
      } catch (error) {
        return fhirErrorResponse(context, error)
      }
    })

    app.get('/fhir/R5/:resourceType', async (context) => {
      try {
        const resourceType = context.req.param('resourceType')
        if (!isSupportedResourceType(resourceType)) {
          throw new FhirRepositoryError('NOT_SUPPORTED', `Resource type ${resourceType} is not supported`)
        }
        const repositoryContext = await fhirRuntime.resolveContext(context.req.raw)
        const url = new URL(context.req.url)
        const page = fhirRuntime.repository.search(repositoryContext, resourceType, url.searchParams)
        const links = [{ relation: 'self', url: url.toString() }]
        if (page.nextCursor !== undefined) {
          const nextUrl = new URL(url)
          nextUrl.searchParams.set('_cursor', page.nextCursor)
          links.push({ relation: 'next', url: nextUrl.toString() })
        }
        const body = {
          resourceType: 'Bundle' as const,
          type: 'searchset' as const,
          ...(page.total === undefined ? {} : { total: page.total }),
          link: links,
          entry: page.resources.map(resource => ({
            fullUrl: new URL(`/fhir/R5/${resource.resourceType}/${resource.id}`, url).toString(),
            resource,
          })),
        }
        return context.json(body, 200, { 'Content-Type': 'application/fhir+json' })
      } catch (error) {
        return fhirErrorResponse(context, error)
      }
    })

    app.all('/fhir/R5/*', (context) => {
      if (context.req.method === 'GET') {
        return context.json(operationOutcome('not-found', 'The requested FHIR endpoint was not found'), 404, {
          'Content-Type': 'application/fhir+json',
        })
      }
      return context.json(operationOutcome(
        'not-supported',
        `FHIR ${context.req.method} is not supported; use the owning business command`,
      ), 405, {
        Allow: 'GET',
        'Content-Type': 'application/fhir+json',
      })
    })
  }

  if (options.webRoot !== undefined) {
    app.use('*', serveStatic({ root: options.webRoot, precompressed: true }))
    const serveEntryPoint = serveStatic({ root: options.webRoot, path: 'index.html' })

    app.get('*', async (context, next) => {
      if (isServicePath(context.req.path) || isStaticAssetPath(context.req.path)) return context.notFound()

      const response = await serveEntryPoint(context, next)
      return response ?? context.notFound()
    })
  }

  return app
}
