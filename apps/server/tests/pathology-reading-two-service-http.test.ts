import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { pathologyReadingProtocol, pathologyReadingSessionSchema, readingAssetStatusSchema, readingCapabilitiesSchema } from '@clinmesh/contracts/pathology-reading'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startServer } from '../src/server.ts'
import { createPathologyReadingScenario } from './fixtures/pathology-reading-scenario.ts'
import { mutation } from './fixtures/imaging-scenario.ts'

// 显式的两侧真实服务验收：PathJX 临时 PostgreSQL 和合成瓦片由其 bridge 提供；默认测试不连接外部服务。
const bridgeOrigin = process.env.CLINMESH_TEST_PATHJX_ORIGIN
const metadataPath = process.env.CLINMESH_TEST_PATHJX_DESCRIPTOR
const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

it.skipIf(!bridgeOrigin || !metadataPath)('真实 ClinMesh 与 PathJX 从双器官会诊走到受限人类复核、已阅和同片报告更正', async () => {
  const descriptor = z.object({ instanceId: z.string(), serviceKey: z.string(), actorId: z.string() }).loose()
    .parse(JSON.parse(await readFile(metadataPath!, 'utf8')))
  const prefix = `${bridgeOrigin}/api/integrations/clinmesh/v1`
  const call = async (path: string, credential: string, method = 'GET', body?: unknown, intentId?: string) => fetch(`${prefix}${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(intentId ? { 'idempotency-key': intentId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const capabilities = readingCapabilitiesSchema.parse(await (await call('/capabilities', descriptor.serviceKey)).json())
  expect(capabilities.instanceId).toBe(descriptor.instanceId)
  let current: Awaited<ReturnType<typeof createPathologyReadingScenario>> | undefined
  const callback = new Hono()
  callback.all('*', context => current ? current.runtime.app.fetch(context.req.raw) : context.json({ active: false, writable: false }, 503))
  const server = startServer({ app: callback, hostname: '0.0.0.0', port: 51993 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  resources.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const exchangeSchema = z.object({ protocol: z.literal(pathologyReadingProtocol), sessionId: z.string(), token: z.string(), apiBase: z.string(),
    slideId: z.uuid(), writable: z.boolean(), actor: z.object({ id: z.uuid(), displayName: z.string() }),
    binding: z.object({ requestId: z.string(), reportId: z.string(), reportVersion: z.string() }).strict() }).loose()
  for (const organ of ['colorectal', 'thyroid'] as const) {
    const asset = readingAssetStatusSchema.parse(await (await call(`/assets/bridge-${organ}`, descriptor.serviceKey)).json())
    expect(asset.available).toBe(true)
    current = await createPathologyReadingScenario({ assetOutput: { kind: 'pathjx', instanceId: descriptor.instanceId,
      assetKey: asset.assetKey, contentHash: asset.contentHash, organ, specimenType: 'resection', stain: 'HE' },
      serviceOrigin: bridgeOrigin!, serviceToken: descriptor.serviceKey, fetch: globalThis.fetch })
    const scenario = current
    resources.push(() => scenario.close())
    const opened = await scenario.session()
    const exchange = await call('/sessions/exchange', '', 'POST', { launchToken: opened.launchToken })
    expect(exchange.status, await exchange.clone().text()).toBe(200)
    const remote = exchangeSchema.parse(await exchange.json())
    expect(remote.binding).toEqual({ requestId: opened.requestId, reportId: opened.reportId, reportVersion: opened.reportVersion })
    expect(remote.actor.id).not.toBe(descriptor.actorId)
    const sessionPath = remote.apiBase.replace('/api/integrations/clinmesh/v1', '')
    const slideResponse = await call(`${sessionPath}/api/v1/slides/${remote.slideId}`, remote.token)
    expect(slideResponse.status).toBe(200)
    expect(slideResponse.headers.get('cache-control')).toBe('private, no-store')
    expect((await call(`${sessionPath}/api/v1/slides`, remote.token)).status).toBe(404)
    expect((await scenario.acknowledge()).status).toBe(409)
    const task = capabilities.capabilities.find(item => item.organ === organ)!
    const taskList = await call(`${sessionPath}/api/v1/analysis-tasks`, remote.token)
    expect(taskList.status, await taskList.clone().text()).toBe(200)
    const tasks = z.object({ items: z.array(z.object({ id: z.uuid(), code: z.string() }).loose()) }).loose().parse(await taskList.json())
    const taskId = tasks.items.find(item => item.code === task.taskCode)!.id
    const reviewIntent = randomUUID(), reviewPath = `${sessionPath}/api/v1/slides/${remote.slideId}/review-actions`
    const review = await call(reviewPath, remote.token, 'POST', { items: [{ kind: 'comment', task_id: taskId, text: '纯合成跨仓库复核意见' }] }, reviewIntent)
    expect(review.status, await review.clone().text()).toBe(201)
    const actions = z.object({ items: z.array(z.object({ actor: z.object({ id: z.uuid() }).loose() }).loose()) }).loose().parse(await review.json())
    expect(actions.items[0]!.actor.id).toBe(remote.actor.id)
    const receipt = await call(`${sessionPath}/operations/${reviewIntent}`, remote.token)
    expect(await receipt.json()).toMatchObject({ status: 'applied', intentId: reviewIntent })
    expect((await call(`${sessionPath}/operations/${reviewIntent}/acknowledge`, remote.token, 'POST', {})).status).toBe(200)
    const shown = await scenario.runtime.app.request(`/api/his/v1/pathology-reading/sessions/${opened.id}/displayed`, mutation(scenario.visit.doctor, {
      protocol: pathologyReadingProtocol, type: 'displayed', sessionId: opened.sessionId, generation: opened.generation,
      requestId: opened.requestId, reportId: opened.reportId, reportVersion: opened.reportVersion,
    }))
    expect(shown.status, await shown.clone().text()).toBe(200)
    expect((await scenario.acknowledge()).status).toBe(200)
    const correction = await scenario.correct()
    expect(correction.status, await correction.clone().text()).toBe(409)
    const changed = doctorCaseDetailSchema.parse(await (await scenario.runtime.app.request(`/api/his/v1/doctor/cases/${scenario.visit.outpatientCaseId}`, { headers: { cookie: scenario.visit.doctor } })).json())
    const request = changed.pathologyRequests!.requests[0]!
    const corrected = await scenario.runtime.app.request(`/api/his/v1/pathology-requests/${request.id}/reports/${request.report!.diagnosticReportId}/actions/correct`, mutation(scenario.admin, {
      expectedVersions: { [`DiagnosticReport/${request.report!.diagnosticReportId}`]: request.report!.diagnosticReportVersion },
      input: { expectedRequestVersion: request.version, reportRevision: 2, reason: '同片已复核合成修订' },
    }))
    expect(corrected.status, await corrected.clone().text()).toBe(200)
    const nextRequest = (await scenario.detail()).pathologyRequests!.requests[0]!
    const nextResponse = await scenario.open(randomUUID(), { ...scenario.input, requestVersion: nextRequest.version,
      reportId: nextRequest.report!.diagnosticReportId, reportVersion: nextRequest.report!.diagnosticReportVersion, generation: randomUUID() })
    expect(nextResponse.status, await nextResponse.clone().text()).toBe(200)
    const next = pathologyReadingSessionSchema.parse(await nextResponse.json())
    const nextRemote = exchangeSchema.parse(await (await call('/sessions/exchange', '', 'POST', { launchToken: next.launchToken })).json())
    expect(nextRemote.slideId).toBe(remote.slideId)
    expect(nextRemote.binding.reportId).toBe(next.reportId)
    expect((await call(`${sessionPath}/api/v1/slides/${remote.slideId}`, remote.token)).status).toBe(403)
    expect((await scenario.configure(false, 1)).status).toBe(200)
    const nextBase = nextRemote.apiBase.replace('/api/integrations/clinmesh/v1', '')
    expect((await call(`${nextBase}/api/v1/slides/${nextRemote.slideId}`, nextRemote.token)).status).toBe(403)
  }
}, 120_000)
