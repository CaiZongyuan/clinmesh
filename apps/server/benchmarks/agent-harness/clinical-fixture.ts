import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  billingCaseSchema,
  clinicalCatalogSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryRequestDraftResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  registrationCatalogSchema,
  startVisitResponseSchema,
} from '@clinmesh/contracts/his'
import { createClinMeshRuntime } from '../../src/runtime.ts'
import type { JsonChatCompletionsProvider } from '../../src/infrastructure/ai/openai-chat-completions.ts'
import {
  persona,
  signIn,
  startConsultationCase,
  StubSyntheaProvider,
  useSyntheticLaboratoryCatalog,
} from '../../tests/fixtures/consultation.ts'
import { signInitialOutpatientDocument, confirmPrimaryOutpatientDiagnosis } from '../../tests/fixtures/outpatient-order-gate.ts'
import { createHttpExecutor } from '../../../cli/src/http-executor.ts'

export type ClinMeshRuntime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const DETERMINISTIC_JSON_PROVIDER: JsonChatCompletionsProvider = {
  async completeJson() {
    return { content: JSON.stringify(persona), model: 'synthetic-persona' }
  },
}

export interface OutpatientBenchmarkFixture {
  readonly runtime: ClinMeshRuntime
  readonly directory: string
  readonly origin: string
  readonly password: string
  readonly doctorCookie: string
  readonly adminCookie: string
  readonly caseId: string
  readonly outpatientCaseId: string
  readonly encounterId: string
  readonly patientName: string
  readonly hiddenCaseTruth: string
  readonly publishedLabRequestIds: string[]
  readonly publishedLabReportIds: string[]
  readonly diagnosisCatalogSample: Array<{ id: string; code: string; display: string }>
  readonly medicationCatalogSample: Array<{ id: string; nameZh: string; dose?: string; frequency?: string }>
  readonly executeOp: (operationId: string, input: unknown, idempotencyKey?: string) => Promise<unknown>
  readonly close: () => Promise<void>
}

function postJsonInit(cookie: string, body: unknown, method: 'POST' | 'PUT' = 'POST', origin = 'http://localhost') {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
      origin,
    },
    method,
  }
}

async function payCharge(
  runtime: ClinMeshRuntime,
  password: string,
  origin: string,
  caseId: string,
  chargeItemId: string,
): Promise<void> {
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local', password, origin)
  const detailResp = await runtime.app.request(`/api/his/v1/billing/cases/${caseId}`, { headers: { cookie: cashier } })
  assert.equal(detailResp.status, 200, await detailResp.clone().text())
  const billingCase = billingCaseSchema.parse(await detailResp.json())
  const charge = billingCase.charges.find(item => item.chargeItemId === chargeItemId)
  assert.ok(charge, `Missing charge item ${chargeItemId}`)
  const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const previewResp = await runtime.app.request('/api/his/v1/payments/actions/preview', postJsonInit(cashier, {
    expectedVersions,
    input: { caseId, category: 'laboratory', chargeItemId, simulatorRule: 'success' },
  }, 'POST', origin))
  assert.equal(previewResp.status, 200, await previewResp.clone().text())
  const preview = paymentPreviewResponseSchema.parse(await previewResp.json()).data
  const confirmResp = await runtime.app.request(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, postJsonInit(cashier, {
    expectedVersions,
    input: { commitToken: preview.commitToken },
  }, 'POST', origin))
  assert.equal(confirmResp.status, 200, await confirmResp.clone().text())
  assert.equal(paymentResponseSchema.parse(await confirmResp.json()).data.outcome, 'success')
}

export interface CreateFixtureOptions {
  /** Whether to publish real CBC (WBC 11.2 H, Hgb 135 N, Plt 210 N) & CRP (18.6 H) lab reports. */
  withPublishedLabs?: boolean
  /**
   * When true, starts the outpatient visit as a clean in-progress visit (unsigned doc, unconfirmed diagnosis)
   * suitable for T3 end-to-end clinical write testing without pre-signed prerequisites.
   */
  cleanForWriteTask?: boolean
}

export async function createOutpatientBenchmarkFixture(
  options: CreateFixtureOptions = {},
): Promise<OutpatientBenchmarkFixture> {
  const withPublishedLabs = options.withPublishedLabs ?? !options.cleanForWriteTask
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-bench-'))
  const origin = 'http://localhost'
  const password = `Bench-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({
    authBaseUrl: origin,
    authSecret: randomUUID() + randomUUID(),
    chatCompletionsProvider: DETERMINISTIC_JSON_PROVIDER,
    consultationModel: 'synthetic-consultation',
    cursorSecret: randomUUID() + randomUUID(),
    databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: password,
    imagingAssetDirectory: join(directory, 'imaging-assets'),
    imagingCatalogDirectory: join(directory, 'imaging-catalog'),
    migrationMode: 'apply',
    pathologyAssetDirectory: join(directory, 'pathology-assets'),
    pathologyCatalogDirectory: join(directory, 'pathology-catalog'),
    patientPersonaModel: 'synthetic-persona',
    syntheaProvider: new StubSyntheaProvider(),
    trustedOrigins: [origin],
  })

  try {
    useSyntheticLaboratoryCatalog(runtime)
    const started = await startConsultationCase(runtime, password, origin)
    const doctorCookie = await signIn(runtime, 'doctor@demo.clinmesh.local', password, origin)

    // Start first visit so encounter transitions to in-progress
    let detailResp = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
      headers: { cookie: doctorCookie },
    })
    assert.equal(detailResp.status, 200)
    let detail = doctorCaseDetailSchema.parse(await detailResp.json())
    if (detail.status === 'awaiting-doctor') {
      const startResp = await runtime.app.request(
        `/api/his/v1/encounters/${detail.encounter.id}/actions/start-first-visit`,
        postJsonInit(doctorCookie, {
          expectedVersions: {
            [`Encounter/${detail.encounter.id}`]: detail.encounter.versionId,
            [`Task/${detail.taskId}`]: detail.taskVersion,
          },
          input: {},
        }, 'POST', origin),
      )
      assert.equal(startResp.status, 200, await startResp.clone().text())
      startVisitResponseSchema.parse(await startResp.json())
      detailResp = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
        headers: { cookie: doctorCookie },
      })
      detail = doctorCaseDetailSchema.parse(await detailResp.json())
    }

    const publishedLabRequestIds: string[] = []
    const publishedLabReportIds: string[] = []

    if (withPublishedLabs) {
      // To issue lab requests via public outpatient order gate, sign initial doc + confirm preliminary diagnosis
      // ONLY for T1 (briefing) where rich published labs are desired.
      // For T2 (safety audit), we want blockers visible (unsigned doc, unconfirmed diagnosis) while still having
      // real clinical vitals/prior history/scores/quality/completion preview.
      // Wait: if we want published labs in T1, we sign doc + confirm diagnosis + issue CBC & CRP + pay + dispatch LIS!
      await signInitialOutpatientDocument(runtime, doctorCookie, started.outpatientCaseId, {
        chiefComplaint: '反复头晕一周',
        historyOfPresentIllness: '患者一周前起立时反复出现头晕、眼前发黑，休息后可缓解。',
        priorMedicalHistory: '既往有高血压病史，规律口服降压药。',
        physicalExamination: '神志清，BP 162/96 mmHg，P 82次/分，R 18次/分，SpO2 98%，T 36.5℃。',
        assessment: '高血压伴头晕待查，需完善血常规及炎症指标评估。',
        disposition: '完善血常规与C反应蛋白检验，监测血压变化。',
        followUp: '检验回报后复诊评估。',
      }, origin)
      await confirmPrimaryOutpatientDiagnosis(runtime, doctorCookie, started.outpatientCaseId, 'diagnosis-hypertension', { origin })
        .catch(async () => {
          // Fall back to first catalog diagnosis if hypertension ID differs
          const catResp = await runtime.app.request('/api/his/v1/catalogs/clinical', { headers: { cookie: doctorCookie } })
          const cat = clinicalCatalogSchema.parse(await catResp.json())
          await confirmPrimaryOutpatientDiagnosis(runtime, doctorCookie, started.outpatientCaseId, cat.diagnoses[0]!.id, { origin })
        })

      detailResp = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
        headers: { cookie: doctorCookie },
      })
      detail = doctorCaseDetailSchema.parse(await detailResp.json())

      for (const serviceId of ['lab-cbc', 'lab-crp']) {
        const expectedVersions = { [`Encounter/${detail.encounter.id}`]: detail.encounter.versionId }
        const draftResp = await runtime.app.request(
          `/api/his/v1/encounters/${detail.encounter.id}/laboratory-request/draft`,
          postJsonInit(doctorCookie, {
            expectedVersions,
            input: {
              catalogItemId: serviceId,
              expectedDraftVersion: detail.laboratoryRequests?.draftVersion ?? 0,
              indicationCode: 'clinical-evaluation',
            },
          }, 'PUT', origin),
        )
        assert.equal(draftResp.status, 200, await draftResp.clone().text())
        const draft = laboratoryRequestDraftResponseSchema.parse(await draftResp.json()).data

        const issueResp = await runtime.app.request(
          `/api/his/v1/encounters/${detail.encounter.id}/laboratory-request/actions/issue`,
          postJsonInit(doctorCookie, {
            expectedVersions,
            input: { expectedDraftVersion: draft.draftVersion },
          }, 'POST', origin),
        )
        assert.equal(issueResp.status, 200, await issueResp.clone().text())
        const issued = issueLaboratoryRequestResponseSchema.parse(await issueResp.json()).data.request
        publishedLabRequestIds.push(issued.id)

        if (issued.billing?.chargeItemId) {
          await payCharge(runtime, password, origin, started.outpatientCaseId, issued.billing.chargeItemId)
        }
        // Dispatch outbox events until LIS publishes the lab report
        for (let step = 0; step < 12; step += 1) {
          const evt = await runtime.dispatcher.dispatchOnce()
          if (evt === undefined) break
        }
        detailResp = await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
          headers: { cookie: doctorCookie },
        })
        detail = doctorCaseDetailSchema.parse(await detailResp.json())
      }

      for (const req of detail.laboratoryRequests?.requests ?? []) {
        if (req.report?.diagnosticReportId) {
          publishedLabReportIds.push(req.report.diagnosticReportId)
        }
      }
    }

    const catalogResp = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: doctorCookie },
    })
    assert.equal(catalogResp.status, 200)
    const clinicalCatalog = clinicalCatalogSchema.parse(await catalogResp.json())

    const httpExecute = createHttpExecutor({
      baseUrl: origin,
      credential: { kind: 'human', cookie: doctorCookie },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url
        return runtime.app.request(url, init)
      },
    })

    return {
      runtime,
      directory,
      origin,
      password,
      doctorCookie,
      adminCookie: started.adminCookie,
      caseId: started.caseId,
      outpatientCaseId: started.outpatientCaseId,
      encounterId: started.encounterId,
      patientName: '张琴',
      hiddenCaseTruth: '2 型糖尿病',
      publishedLabRequestIds,
      publishedLabReportIds,
      diagnosisCatalogSample: clinicalCatalog.diagnoses.slice(0, 6).map(d => ({
        id: d.id,
        code: d.code,
        display: d.nameZh,
      })),
      medicationCatalogSample: clinicalCatalog.medications.slice(0, 6).map(m => ({
        id: m.id,
        nameZh: m.nameZh,
        ...(m.allowedDoseTexts[0] ? { dose: m.allowedDoseTexts[0] } : {}),
        ...(m.allowedFrequencyCodes[0] ? { frequency: m.allowedFrequencyCodes[0] } : {}),
      })),
      executeOp: (operationId, input, idempotencyKey) => httpExecute(
        operationId,
        input,
        idempotencyKey ? { idempotencyKey } : undefined,
      ),
      close: async () => {
        try {
          await runtime.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await runtime.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Starts a freshly registered patient awaiting triage (for Frontend U2 Playwright benchmark).
 */
export async function createPendingTriageCase(
  runtime: ClinMeshRuntime,
  password: string,
  origin: string,
): Promise<{ caseId: string; outpatientCaseId: string; encounterId: string; queueTaskId: string }> {
  const adminContext = {
    actorId: 'actor-administrator',
    epoch: 'epoch-1',
    locationId: 'location-administrator',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerRoleId: 'practitioner-role-administrator',
    roleCode: 'administrator' as const,
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  }
  await runtime.scenarioData.enqueueGeneration({
    context: adminContext,
    idempotencyKey: randomUUID(),
    request: {
      moduleMode: 'all',
      modules: [],
      name: '分诊基准测试患者',
      population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    },
  })
  const generated = await runtime.scenarioData.processNextGenerationJob()
  const caseId = generated?.caseIds[0]
  if (!caseId) throw new Error('Failed to generate triage benchmark case')
  await runtime.patientPersona.enqueue({ caseId, context: adminContext, idempotencyKey: randomUUID() })
  const personaJob = await runtime.patientPersona.processNext()
  if (personaJob?.status !== 'succeeded') throw new Error('Persona generation failed')

  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local', password, origin)
  const regCatalog = registrationCatalogSchema.parse(await (await runtime.app.request(
    '/api/his/v1/catalogs/registration',
    { headers: { cookie: registrar } },
  )).json())
  const startedResponse = await runtime.app.request(
    `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
    postJsonInit(registrar, {
      activeBriefRevision: 1,
      departmentId: regCatalog.departments[0]!.id,
      expectedCaseRevision: 2,
      locationId: regCatalog.locations[0]!.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    }, 'POST', origin),
  )
  assert.equal(startedResponse.status, 200, await startedResponse.clone().text())
  const parsed = await startedResponse.json() as {
    data: { encounterId: string; outpatientCaseId: string; queueTaskId: string }
  }
  return {
    caseId,
    outpatientCaseId: parsed.data.outpatientCaseId,
    encounterId: parsed.data.encounterId,
    queueTaskId: parsed.data.queueTaskId,
  }
}
