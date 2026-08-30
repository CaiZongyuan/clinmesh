import { extname } from 'node:path'
import type { HealthResponse } from '@clinmesh/contracts/health'
import {
  createAgentCapabilityGrantInputSchema,
  createAgentClientInputSchema,
} from '@clinmesh/contracts/agent'
import {
  acknowledgeLaboratoryReportRequestSchema,
  caseLaboratoryCatalogSearchSchema,
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
  orderHospitalServiceRequestSchema,
  previewClinicalDocumentSignRequestSchema,
  reviseClinicalDocumentRequestSchema,
  retryLaboratoryResultGenerationRequestSchema,
  saveClinicalDocumentDraftRequestSchema,
  saveDiagnosisDraftRequestSchema,
  saveLaboratoryRequestDraftRequestSchema,
  savePrescriptionDraftRequestSchema,
  signClinicalDocumentRequestSchema,
  withdrawPrescriptionRequestSchema,
} from '@clinmesh/contracts/his'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  selectPatientBriefRevisionRequestSchema,
  startSyntheticCaseRequestSchema,
  scenarioGenerationRequestSchema,
  updateSyntheticPatientProfileRequestSchema,
} from '@clinmesh/contracts/scenario'
import type { IdentityService } from './application/identity-service.ts'
import { IdentityError } from './application/identity-service.ts'
import type { InvestigationService } from './application/investigation-service.ts'
import type { ReferenceDataService } from './application/reference-data-service.ts'
import { ReferenceDataError } from './application/reference-data-service.ts'
import {
  CommandConflictError,
  CommandReceiptNotFoundError,
  ExpectedVersionConflictError,
} from './application/command-executor.ts'
import type { ScenarioService } from './application/scenario-service.ts'
import { ScenarioError } from './application/scenario-service.ts'
import type { ScenarioDataService } from './application/scenario-data/scenario-data-service.ts'
import { ScenarioDataError } from './application/scenario-data/scenario-data-service.ts'
import type { PatientBriefService } from './application/patient-brief-service.ts'
import { PatientBriefError } from './application/patient-brief-service.ts'
import type { SyntheticCaseVisitService } from './application/synthetic-case-visit-service.ts'
import { SyntheticCaseVisitError } from './application/synthetic-case-visit-service.ts'
import type { WorkflowService } from './application/workflow-service.ts'
import { WorkflowError } from './application/workflow-service.ts'
import { createCapabilityStatement } from './fhir/capabilities.ts'
import { isSupportedResourceType } from './fhir/capabilities.ts'
import {
  FhirRepositoryError,
  type FhirRepository,
  type RepositoryContext,
} from './infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceContextError } from './infrastructure/sqlite/workspace-repository.ts'

interface FhirRuntime {
  repository: FhirRepository
  resolveContext: (request: Request) => Promise<RepositoryContext> | RepositoryContext
}

export interface CreateAppOptions {
  caseVisits?: SyntheticCaseVisitService
  fhir?: FhirRuntime
  identity?: IdentityService
  investigation?: InvestigationService
  patientBrief?: PatientBriefService
  referenceData?: ReferenceDataService
  scenario?: ScenarioService
  scenarioData?: ScenarioDataService
  workflow?: WorkflowService
  webRoot?: string
}

function operationOutcome(code: string, diagnostics: string) {
  return {
    resourceType: 'OperationOutcome' as const,
    issue: [{ severity: 'error' as const, code, diagnostics }],
  }
}

function invalidInputResponse(context: Context, message = 'The request is invalid') {
  return context.json({ error: { code: 'INVALID_INPUT', message } }, 400)
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
    || error instanceof PatientBriefError
    || error instanceof SyntheticCaseVisitError
    || error instanceof ReferenceDataError
    || error instanceof ScenarioDataError
    || error instanceof ScenarioError
    || error instanceof WorkflowError
    || error instanceof CommandReceiptNotFoundError
  ) {
    return context.json({
      error: {
        code: error.code,
        ...(error instanceof WorkflowError && error.conflict !== undefined
          ? { conflict: error.conflict }
          : {}),
        message: error.message,
      },
    }, error.status)
  }
  if (
    error instanceof CommandConflictError
    || error instanceof ExpectedVersionConflictError
    || error instanceof FhirRepositoryError
    || error instanceof WorkspaceContextError
  ) {
    return context.json({ error: { code: error.code, message: error.message } }, 409)
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
    const code = error.code === 'AUTHENTICATION_REQUIRED' ? 'login' : 'forbidden'
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

function requestIdempotencyKey(context: Context): string {
  return z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.get('/api/health', (context) => {
    const response: HealthResponse = {
      service: 'clinmesh-server',
      status: 'ok',
      fhirVersion: '5.0.0',
    }
    return context.json(response)
  })

  if (options.identity !== undefined) {
    const identity = options.identity
    app.post('/api/auth/sign-up/email', context => context.json({
      error: {
        code: 'PUBLIC_SIGN_UP_DISABLED',
        message: 'Public account registration is disabled',
      },
    }, 403))
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
        z.object({}).parse(await context.req.json())
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(scenario.reset({
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
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
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

  if (options.identity !== undefined && options.patientBrief !== undefined) {
    const identity = options.identity
    const patientBrief = options.patientBrief
    app.post('/api/sim/v1/synthetic-cases/:caseId/patient-brief-jobs', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        z.object({}).strict().parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(patientBrief.enqueue({
          caseId: context.req.param('caseId'),
          context: session.actor,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Patient Brief generation request is invalid')
      }
    })
    app.get('/api/sim/v1/patient-brief-jobs/:jobId', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(patientBrief.getJob(session.actor, context.req.param('jobId')))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.get('/api/sim/v1/synthetic-cases/:caseId/patient-brief-revisions', async (context) => {
      try {
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        return context.json(patientBrief.listRevisions(
          session.actor,
          context.req.param('caseId'),
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.put('/api/sim/v1/synthetic-cases/:caseId/patient-brief-revisions/active', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = selectPatientBriefRevisionRequestSchema.parse(await context.req.json())
        const session = await identity.resolveSessionContext(context.req.raw.headers)
        const idempotencyKey = z.string().min(8).max(128).parse(
          context.req.header('idempotency-key'),
        )
        return context.json(patientBrief.selectRevision({
          briefRevision: body.briefRevision,
          caseId: context.req.param('caseId'),
          context: session.actor,
          expectedCaseRevision: body.expectedCaseRevision,
          idempotencyKey,
        }))
      } catch (error) {
        return apiErrorResponse(context, error, 'The Patient Brief revision selection is invalid')
      }
    })
  }

  if (options.identity !== undefined && options.caseVisits !== undefined) {
    const identity = options.identity
    const caseVisits = options.caseVisits
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
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }).parse(context.req.query())
        return context.json(workflow.doctorQueue(
          await actor(context),
          query.pageSize,
          query.page,
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
          diagnosisCatalogItemId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
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
    app.get('/api/his/v1/doctor/virtual-patients', async (context) => {
      try {
        const query = z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }).parse(context.req.query())
        return context.json(workflow.virtualPatients(
          await actor(context),
          query.pageSize,
          query.page,
        ))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    app.post('/api/his/v1/doctor/virtual-patients/:virtualPatientId/actions/start', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = z.object({
          expectedVersions: z.object({}).strict(),
          input: z.object({
            expectedVersion: z.string().min(32).max(2_048),
          }),
        }).parse(await context.req.json())
        return context.json(workflow.startVirtualPatient({
          context: await actor(context),
          expectedVersion: body.input.expectedVersion,
          idempotencyKey: idempotencyKey(context),
          virtualPatientId: context.req.param('virtualPatientId'),
        }))
      } catch (error) {
        return apiErrorResponse(context, error)
      }
    })
    if (options.investigation !== undefined && options.referenceData !== undefined) {
      const investigation = options.investigation
      const referenceData = options.referenceData
      app.get('/api/his/v1/doctor/cases/:caseId/reference-catalogs/laboratory', async (context) => {
        try {
          const actorContext = await actor(context)
          const caseId = context.req.param('caseId')
          workflow.doctorCaseDetail(actorContext, caseId)
          const result = referenceData.searchLaboratory(
            actorContext,
            referenceCatalogQuery(context),
          )
          return context.json(caseLaboratoryCatalogSearchSchema.parse({
            ...result,
            items: result.items.map((item) => {
              const { domain: _domain, status: _status, ...concept } = item
              return {
                ...item,
                resultGeneration: investigation.generationCapabilityForCase(
                  actorContext.workspaceId,
                  actorContext.epoch,
                  caseId,
                  concept,
                ),
              }
            }),
          }))
        } catch (error) {
          return apiErrorResponse(context, error)
        }
      })
    }
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
            expectedVersion: z.number().int().positive(),
            questionCode: z.string().min(1).max(64),
          }).strict(),
        }).strict().parse(await context.req.json())
        return context.json(workflow.askConsultationQuestion({
          context: await actor(context),
          encounterId: context.req.param('encounterId'),
          expectedVersions: body.expectedVersions,
          expectedVersion: body.input.expectedVersion,
          idempotencyKey: idempotencyKey(context),
          questionCode: body.input.questionCode,
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
    app.put('/api/his/v1/encounters/:encounterId/clinical-document/draft', async (context) => {
      try {
        identity.assertTrustedMutation(context.req.raw.headers)
        const body = saveClinicalDocumentDraftRequestSchema.parse(await context.req.json())
        return context.json(workflow.saveClinicalDocumentDraft({
          context: await actor(context),
          document: body.input.document,
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
    app.get('/api/his/v1/billing/queue', async (context) => {
      try {
        const query = z.object({
          category: z.enum(['laboratory', 'medication']),
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
            category: z.enum(['laboratory', 'medication']),
            simulatorRule: z.enum(['ambiguous', 'decline', 'success']),
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

  app.get('/fhir/R5/metadata', (context) => context.json(
    createCapabilityStatement({ includeResources: options.fhir !== undefined }),
    200,
    { 'Content-Type': 'application/fhir+json' },
  ))

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
