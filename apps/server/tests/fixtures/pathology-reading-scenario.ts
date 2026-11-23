import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { expect } from 'vitest'
import { casePathologyServiceCatalogSchema, doctorCaseDetailSchema, issuePathologyRequestResponseSchema, pathologyRequestDraftResponseSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { authoredCasePackPrepareResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { pathologyReadingProtocol, pathologyReadingSessionSchema, readingAuthorizationInputSchema, readingBindingSchema, readingSessionCreatedSchema, type PathologyReadingSessionInput } from '@clinmesh/contracts/pathology-reading'
import { externalPathologyCatalogSchema, externalPathologyReportHash, type ExternalPathologyAsset } from '../../src/application/pathology-external-catalog.ts'
import { createClinMeshRuntime } from '../../src/runtime.ts'
import { mutation, signIn, startConsultation } from './imaging-scenario.ts'
import { payOutpatientInvestigation } from './pay-outpatient-investigation.ts'

const instanceId = 'synthetic-reading-instance'
const endpoint = 'http://synthetic-pathjx.invalid'
const output = { kind: 'pathjx' as const, instanceId, assetKey: 'synthetic-colorectal-slide', contentHash: 'b'.repeat(64),
  organ: 'colorectal' as const, specimenType: 'polypectomy', stain: 'HE' as const }
const report = { revision: 1, diagnosis: '合成结直肠切片会诊诊断', microscopy: '合成 H&E 测试所见。', immunohistochemistry: '未提供免疫组化切片。', note: '纯合成测试，不作医学诊断。' }
const reviewed = (value: typeof report) => ({ ...value, review: { conclusion: 'approved' as const,
  contentHash: externalPathologyReportHash({ output }, value), reviewedAt: '2026-11-20T00:00:00Z', reviewer: 'Synthetic Reviewer' } })
const remoteSessionInputSchema = z.object({ intentId: z.string(), bindingId: z.string(), expiresAt: z.string(), authorizationToken: z.string(),
  writable: z.boolean() }).passthrough()

/** Only the external HTTP boundary is replaced; ClinMesh runs its real routes, commands and temporary SQLite database. */
export class SyntheticPathJxService {
  readonly bindings = new Map<string, z.infer<typeof readingBindingSchema>>()
  readonly sessions = new Map<string, z.infer<typeof readingSessionCreatedSchema>>()
  readonly authorizationTokens = new Map<string, string>()
  readonly calls: Array<{ method: string; path: string }> = []
  revision = 0
  available = true
  loseNextSessionResponse = false

  constructor(private readonly asset: ExternalPathologyAsset['output'] = output) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    const path = url.pathname.replace('/api/integrations/clinmesh/v1', '')
    this.calls.push({ method, path })
    const headers = new Headers(init?.headers)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('authorization')).toBe('Bearer synthetic-service-credential')
    if (path === '/capabilities') return Response.json({ protocol: pathologyReadingProtocol, instanceId: this.asset.instanceId, capabilities: [{
      taskCode: `synthetic-${this.asset.organ}-review`, modelVersion: 'synthetic-v1', modelDigest: 'a'.repeat(64), organ: this.asset.organ,
      specimenTypes: [this.asset.specimenType], stain: 'HE', available: true, limitations: ['合成执行器，仅验证协议，不运行模型'] }] })
    if (path.startsWith('/assets/')) return Response.json({ ...this.asset, kind: undefined, instanceId: undefined,
      assetKey: decodeURIComponent(path.slice('/assets/'.length)), available: this.available })
    if (path.startsWith('/bindings/')) {
      const bindingId = decodeURIComponent(path.slice('/bindings/'.length))
      if (method === 'PUT') {
        const body = z.object({ contentHash: z.string() }).passthrough().parse(JSON.parse(String(init?.body)))
        const binding = { bindingId, instanceId: this.asset.instanceId, slideId: 'synthetic-bound-slide', contentHash: body.contentHash }
        this.bindings.set(bindingId, binding)
        return Response.json(binding)
      }
      const binding = this.bindings.get(bindingId)
      return binding === undefined ? new Response(null, { status: 404 }) : Response.json({ ...binding, available: this.available, revision: this.revision })
    }
    if (path === '/sessions' && method === 'POST') {
      const body = remoteSessionInputSchema.parse(JSON.parse(String(init?.body)))
      expect(this.bindings.has(body.bindingId)).toBe(true)
      const remote = { sessionId: `remote-${body.intentId}`, launchToken: `synthetic-launch-${body.intentId}`,
        expiresAt: body.expiresAt, viewerPath: '/clinmesh/reading' as const }
      this.sessions.set(body.intentId, remote)
      this.authorizationTokens.set(remote.sessionId, body.authorizationToken)
      if (this.loseNextSessionResponse) { this.loseNextSessionResponse = false; throw new Error('Synthetic response lost after session commit') }
      return Response.json(remote)
    }
    if (path.startsWith('/operations/')) {
      const intentId = decodeURIComponent(path.slice('/operations/'.length))
      const result = this.sessions.get(intentId) ?? this.bindings.get(intentId)
      return Response.json({ intentId, status: result === undefined ? 'not-found' : 'applied', ...(result === undefined ? {} : { result }) })
    }
    if (path.startsWith('/sessions/') && method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`Unexpected synthetic PathJX request: ${method} ${path}`)
  }

  count(method: string, prefix: string) { return this.calls.filter(call => call.method === method && call.path.startsWith(prefix)).length }
}

export async function createPathologyReadingScenario() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-reading-lifecycle-'))
  const catalogPath = join(directory, 'synthetic-external-catalog.json')
  const catalog = externalPathologyCatalogSchema.parse({ packId: 'synthetic-reading-slides', ruleVersion: 1, assets: [{
    assetId: 'synthetic-colorectal-asset', diagnosis: { system: 'http://snomed.info/sct', code: '68496003' },
    examCode: 'colorectal-slide-consultation', license: { source: 'https://example.invalid/synthetic', identifier: 'synthetic',
      attribution: 'Synthetic fixture', deidentified: true, synthetic: true }, output,
    sourceSpecimenType: 'prior-colorectal-polypectomy', reports: [reviewed(report)],
  }] })
  await writeFile(catalogPath, JSON.stringify(catalog))
  const remote = new SyntheticPathJxService()
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'runtime.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', autoDispatchIntervalMs: 0, migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    pathologyExternalCatalogPath: catalogPath, pathologyReading: { serviceToken: 'synthetic-service-credential', trustedOrigins: [endpoint], fetch: remote.fetch },
  })
  try {
    const admin = await signIn(runtime)
    const configure = async (enabled: boolean, expectedVersion: number) => runtime.app.request('/api/sim/v1/admin/pathology-reading/config',
      mutation(admin, { enabled, expectedVersion, instanceId, endpoint, viewerOrigin: endpoint }, 'PUT'))
    expect((await configure(true, 0)).status).toBe(200)
    const context = await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })
    expect(context.status).toBe(200)
    const epoch = sessionContextSchema.parse(await context.json()).actor.epoch
    const prepare = await runtime.app.request('/api/sim/v1/admin/pathology-case-pack/prepare', mutation(admin, { input: { expectedEpoch: epoch } }))
    expect(prepare.status, await prepare.clone().text()).toBe(200)
    const selected = authoredCasePackPrepareResponseSchema.parse(await prepare.json()).data.cases.find(item => item.draftId.includes('colorectal'))!.case!
    const preparation = await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(admin, { input: { caseIds: [selected.caseId] } }))
    expect(preparation.status, await preparation.clone().text()).toBe(200)
    const visit = await startConsultation(runtime, admin, selected.caseId)
    const detail = async () => {
      const response = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, { headers: { cookie: visit.doctor } })
      expect(response.status).toBe(200)
      return doctorCaseDetailSchema.parse(await response.json())
    }
    const services = await runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}/pathology-services`, { headers: { cookie: visit.doctor } })
    const service = casePathologyServiceCatalogSchema.parse(await services.json()).items.find(item => item.service.examCode === 'colorectal-slide-consultation')!
    expect(service.available).toBe(true)
    const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
    const drafted = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/pathology-request/draft`, mutation(visit.doctor, {
      expectedVersions, input: { expectedDraftVersion: 0, purpose: '复核既往标本切片', serviceId: service.service.id,
        sourceProcedureReference: service.sourceProcedures[0]!.sourceReference },
    }, 'PUT'))
    expect(drafted.status).toBe(200)
    const draft = pathologyRequestDraftResponseSchema.parse(await drafted.json()).data
    const issued = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/pathology-request/actions/issue`, mutation(visit.doctor, {
      expectedVersions, input: { expectedDraftVersion: draft.draftVersion },
    }))
    expect(issued.status).toBe(200)
    const request = issuePathologyRequestResponseSchema.parse(await issued.json()).data.request
    await payOutpatientInvestigation(runtime, { caseId: visit.outpatientCaseId, category: 'pathology', chargeItemId: request.billing!.chargeItemId })
    while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* Run the synthetic report worker, without a model. */ }
    const reported = (await detail()).pathologyRequests!.requests[0]!
    const input: PathologyReadingSessionInput = { reportId: reported.report!.diagnosticReportId, reportVersion: reported.report!.diagnosticReportVersion,
      requestVersion: reported.version, generation: randomUUID(), parentOrigin: 'http://localhost' }
    const open = (idempotencyKey = randomUUID(), next = input) => {
      const init = mutation(visit.doctor, next)
      init.headers['idempotency-key'] = idempotencyKey
      return runtime.app.request(`/api/his/v1/pathology-requests/${reported.id}/reading-sessions`, init)
    }
    const session = async (idempotencyKey = randomUUID(), next = input) => {
      const response = await open(idempotencyKey, next)
      expect(response.status, await response.clone().text()).toBe(200)
      return pathologyReadingSessionSchema.parse(await response.json())
    }
    const acknowledge = () => runtime.app.request(`/api/his/v1/pathology-requests/${reported.id}/reports/${input.reportId}/actions/acknowledge`,
      mutation(visit.doctor, { expectedVersions: { [`DiagnosticReport/${input.reportId}`]: input.reportVersion,
        [`ServiceRequest/${reported.serviceRequestId}`]: reported.serviceRequestVersion, [`Task/${reported.taskId}`]: reported.taskVersion },
        input: { expectedRequestVersion: reported.version } }))
    const callback = (sessionId: string, event: z.infer<typeof readingAuthorizationInputSchema>) => runtime.app.request('/api/his/v1/pathology-reading/authorize', {
      method: 'POST', headers: { authorization: `Bearer ${remote.authorizationTokens.get(sessionId)}`, 'content-type': 'application/json' }, body: JSON.stringify(event),
    })
    const correct = async () => {
      catalog.assets[0]!.reports.push(reviewed({ ...report, revision: 2, microscopy: '同一切片已复核第二版镜下所见。' }))
      await writeFile(catalogPath, JSON.stringify(catalog))
      return runtime.app.request(`/api/his/v1/pathology-requests/${reported.id}/reports/${input.reportId}/actions/correct`, mutation(admin, {
        expectedVersions: { [`DiagnosticReport/${input.reportId}`]: input.reportVersion },
        input: { expectedRequestVersion: reported.version, reason: '采用同片已复核修订', reportRevision: 2 },
      }))
    }
    return { runtime, remote, admin, visit, reported, input, detail, open, session, acknowledge, callback, correct, configure,
      close: async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) { await runtime.close(); await rm(directory, { recursive: true, force: true }); throw error }
}
