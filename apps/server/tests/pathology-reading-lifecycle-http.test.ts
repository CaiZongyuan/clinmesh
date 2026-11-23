import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { pathologyReadingMessageSchema, pathologyReadingProtocol, pathologyReadingSessionStateSchema } from '@clinmesh/contracts/pathology-reading'
import { mutation } from './fixtures/imaging-scenario.ts'
import { createPathologyReadingScenario, SyntheticPathJxService } from './fixtures/pathology-reading-scenario.ts'

type Scenario = Awaited<ReturnType<typeof createPathologyReadingScenario>>
const scenarios: Scenario[] = []
afterEach(async () => { for (const scenario of scenarios.splice(0)) await scenario.close() })
async function setup(options: Parameters<typeof createPathologyReadingScenario>[0] = {}) { const scenario = await createPathologyReadingScenario(options); scenarios.push(scenario); return scenario }
const statePath = (id: string) => `/api/his/v1/pathology-reading/sessions/${id}`

it('会话响应丢失后按原幂等键恢复同一会话，不重复绑定或创建；只有匹配的 displayed 事件允许确认报告', async () => {
  const s = await setup(), key = randomUUID()
  s.remote.loseNextSessionResponse = true
  const lost = await s.open(key)
  expect(lost.status).toBe(503)
  expect(await lost.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_UNAVAILABLE' } })
  const opened = await s.session(key)
  expect(opened.writable).toBe(true)
  expect(opened.viewerUrl).toBe('http://synthetic-pathjx.invalid/clinmesh/reading')
  expect(opened.viewerUrl).not.toContain(opened.launchToken)
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(1)
  expect(s.remote.count('GET', '/operations/')).toBe(1)
  expect(await s.session(key)).toEqual(opened)
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(1)
  const reused = await s.open(key, { ...s.input, generation: randomUUID() })
  expect(reused.status).toBe(409)
  expect(await reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } })
  const before = await s.runtime.app.request(statePath(opened.id), { headers: { cookie: s.visit.doctor } })
  expect(pathologyReadingSessionStateSchema.parse(await before.json())).toMatchObject({ active: true, writable: true, displayed: false })
  const blocked = await s.acknowledge()
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toMatchObject({ error: { code: 'IMAGING_STUDY_UNAVAILABLE' } })
  const message = pathologyReadingMessageSchema.parse({ protocol: pathologyReadingProtocol, type: 'displayed',
    sessionId: opened.sessionId, generation: opened.generation, requestId: opened.requestId, reportId: opened.reportId, reportVersion: opened.reportVersion })
  const stale = await s.runtime.app.request(`${statePath(opened.id)}/displayed`, mutation(s.visit.doctor, { ...message, generation: randomUUID() }))
  expect(stale.status).toBe(403)
  expect((await s.acknowledge()).status).toBe(409)
  const displayed = await s.runtime.app.request(`${statePath(opened.id)}/displayed`, mutation(s.visit.doctor, message))
  expect(displayed.status, await displayed.clone().text()).toBe(200)
  expect(pathologyReadingSessionStateSchema.parse(await displayed.json())).toMatchObject({ active: true, writable: true, displayed: true })
  const confirmed = await s.acknowledge()
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  expect((await s.detail()).pathologyRequests!.requests[0]!.report!.acknowledgement).toBeDefined()
})

it('停用服务立即使旧会话及回调失效，重新启用后显式新开会话仍沿用原绑定', async () => {
  const s = await setup(), opened = await s.session(), bindingId = [...s.remote.bindings.keys()][0]!
  expect((await s.configure(false, 1)).status).toBe(200)
  const disabled = await s.runtime.app.request(statePath(opened.id), { headers: { cookie: s.visit.doctor } })
  expect(await disabled.json()).toMatchObject({ active: false, writable: false, displayed: false })
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0 })).json()).toEqual({ active: false, writable: false })
  expect((await s.open()).status).toBe(503)
  expect((await s.configure(true, 2)).status).toBe(200)
  const fresh = await s.session(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(fresh.id).not.toBe(opened.id)
  expect(fresh.writable).toBe(true)
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0 })).json()).toEqual({ active: false, writable: false })
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(2)
})

it('关闭通知丢失后新一轮打开撤销旧显示资格，必须在新会话实际显示后才能已阅', async () => {
  const s = await setup(), first = await s.session()
  const displayed = (session: typeof first) => s.runtime.app.request(`${statePath(session.id)}/displayed`, mutation(s.visit.doctor, {
    protocol: pathologyReadingProtocol, type: 'displayed', sessionId: session.sessionId, generation: session.generation,
    requestId: session.requestId, reportId: session.reportId, reportVersion: session.reportVersion,
  }))
  expect((await displayed(first)).status).toBe(200)
  const second = await s.session(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(second.id).not.toBe(first.id)
  expect(await (await s.runtime.app.request(statePath(first.id), { headers: { cookie: s.visit.doctor } })).json())
    .toMatchObject({ active: false, displayed: false })
  expect((await s.acknowledge()).status).toBe(409)
  expect((await displayed(second)).status).toBe(200)
  expect((await s.acknowledge()).status).toBe(200)
})

it('原医生注销后外部授权凭据不能继续读写或确认报告', async () => {
  const s = await setup(), opened = await s.session(), bindingId = [...s.remote.bindings.keys()][0]!
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0 })).json()).toEqual({ active: true, writable: true })
  const revoked = await s.runtime.app.request('/api/auth/sign-out', mutation(s.visit.doctor, {}))
  expect(revoked.status).toBe(200)
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0, intentId: 'after-logout' })).json()).toEqual({ active: false, writable: false })
  expect((await s.acknowledge()).status).toBe(401)
  expect(s.remote.count('POST', '/sessions')).toBe(1)
})

it('报告更正使旧会话失效，新当前报告可写而显式打开历史报告只读，三者不重绑切片', async () => {
  const s = await setup(), opened = await s.session(), bindingId = [...s.remote.bindings.keys()][0]!
  const corrected = await s.correct()
  expect(corrected.status, await corrected.clone().text()).toBe(200)
  const old = await s.runtime.app.request(statePath(opened.id), { headers: { cookie: s.visit.doctor } })
  expect(await old.json()).toMatchObject({ active: false, writable: false, displayed: false })
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0 })).json()).toEqual({ active: false, writable: false })
  const current = (await s.detail()).pathologyRequests!.requests[0]!
  const next = await s.session(randomUUID(), { reportId: current.report!.diagnosticReportId, reportVersion: current.report!.diagnosticReportVersion,
    requestVersion: current.version, generation: randomUUID(), parentOrigin: 'http://localhost' })
  expect(next.writable).toBe(true)
  const historical = await s.session(randomUUID(), { ...s.input, requestVersion: current.version, generation: randomUUID() })
  expect(historical.writable).toBe(false)
  expect(await (await s.callback(historical.sessionId, { event: 'authorize', bindingId, revision: 0 })).json()).toEqual({ active: true, writable: false })
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(3)
})

it('authorize 与 committed 双阶段推进 revision 并保持重放幂等，错误修订进入 repair 且不补建绑定或会话', async () => {
  const s = await setup(), key = randomUUID(), opened = await s.session(key), bindingId = [...s.remote.bindings.keys()][0]!
  const callback = async (event: Parameters<typeof s.callback>[1]) => {
    const response = await s.callback(opened.sessionId, event)
    expect(response.status).toBe(200)
    return response.json()
  }
  const first = { event: 'authorize' as const, bindingId, revision: 0, intentId: 'synthetic-analysis-1' }
  expect(await callback(first)).toEqual({ active: true, writable: true })
  expect(await callback(first)).toEqual({ active: true, writable: true })
  s.remote.revision = 1
  const committed = { event: 'committed' as const, bindingId, previousRevision: 0, revision: 1, intentId: first.intentId }
  expect(await callback(committed)).toEqual({ active: true, writable: false })
  expect(await callback(committed)).toEqual({ active: true, writable: false })
  expect(await callback({ event: 'authorize', bindingId, revision: 1, intentId: 'synthetic-analysis-2' })).toEqual({ active: true, writable: true })
  s.remote.revision = 2
  expect(await callback({ event: 'committed', bindingId, previousRevision: 1, revision: 2, intentId: 'synthetic-analysis-2' })).toEqual({ active: true, writable: false })
  expect(await callback(committed)).toEqual({ active: true, writable: false })
  expect(await callback({ event: 'authorize', bindingId, revision: 2 })).toEqual({ active: true, writable: true })
  expect(await callback({ ...committed, revision: 3 })).toEqual({ active: false, writable: false })
  const invalid = await s.runtime.app.request(statePath(opened.id), { headers: { cookie: s.visit.doctor } })
  expect(await invalid.json()).toMatchObject({ active: false, writable: false, displayed: false })
  const cached = await s.open(key)
  expect(cached.status).toBe(403)
  expect(await cached.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_CONTEXT_CHANGED' } })
  const repair = await s.open(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(repair.status).toBe(409)
  expect(await repair.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_REPAIR_REQUIRED' } })
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(1)
})

it('会话结果未知时刷新产生的新键恢复原未决 intent 和原 generation，不重新创建外部会话', async () => {
  const s = await setup()
  s.remote.loseNextSessionResponse = true
  expect((await s.open()).status).toBe(503)
  const recovered = await s.session(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(recovered.generation).toBe(s.input.generation)
  expect(s.remote.count('PUT', '/bindings/')).toBe(1)
  expect(s.remote.count('POST', '/sessions')).toBe(1)
  expect(s.remote.count('GET', '/operations/')).toBe(1)
})

for (const outcome of ['applied', 'not-found', 'unknown'] as const) it(`过期未决会话先查询原意图${outcome}，不会重发过期创建`, async () => {
  let now = new Date(), originalIntent = '', recovering = false, queried = 0
  const remote = new SyntheticPathJxService()
  const s = await setup({ remote, now: () => now, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/sessions') && init?.method === 'POST') {
      originalIntent = z.object({ intentId: z.string() }).passthrough().parse(JSON.parse(String(init.body))).intentId
    }
    if (recovering && path.endsWith(`/operations/${originalIntent}`)) {
      queried++
      if (outcome === 'unknown') return Response.json({ intentId: originalIntent, status: 'unknown' })
      if (outcome === 'not-found') return Response.json({ intentId: originalIntent, status: 'not-found' })
    }
    return remote.fetch(input, init)
  } })
  remote.loseNextSessionResponse = true
  expect((await s.open()).status).toBe(503)
  now = new Date(now.getTime() + 6 * 60_000)
  recovering = true
  const recovered = await s.open(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(recovered.status).toBe(outcome === 'unknown' ? 503 : 403)
  expect(await recovered.json()).toMatchObject({ error: { code: outcome === 'unknown' ? 'PATHOLOGY_READING_RESULT_UNKNOWN' : 'PATHOLOGY_READING_SESSION_EXPIRED' } })
  expect(queried).toBe(1)
  expect(remote.count('POST', '/sessions')).toBe(1)
  if (outcome !== 'unknown') {
    recovering = false
    expect((await s.open(randomUUID(), { ...s.input, generation: randomUUID() })).status).toBe(200)
    expect(remote.count('POST', '/sessions')).toBe(2)
  }
})

for (const revocation of ['closed', 'expired'] as const) it(`原动作已授权后会话${revocation}只允许committed原确认，不恢复读写资格`, async () => {
  let now = new Date()
  const s = await setup({ now: () => now }), opened = await s.session(), bindingId = [...s.remote.bindings.keys()][0]!
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 0, intentId: 'synthetic-before-close' })).json())
    .toEqual({ active: true, writable: true })
  if (revocation === 'closed') {
    const response = await s.runtime.app.request(statePath(opened.id), mutation(s.visit.doctor, {}, 'DELETE'))
    expect(response.status).toBe(200)
  } else now = new Date(now.getTime() + 6 * 60_000)
  const committed = { event: 'committed' as const, bindingId, previousRevision: 0, revision: 1, intentId: 'synthetic-before-close' }
  s.remote.revision = 1
  expect(await (await s.callback(opened.sessionId, committed)).json()).toEqual({ active: true, writable: false })
  expect(await (await s.callback(opened.sessionId, committed)).json()).toEqual({ active: true, writable: false })
  expect(await (await s.callback(opened.sessionId, { event: 'authorize', bindingId, revision: 1, intentId: 'synthetic-after-close' })).json())
    .toEqual({ active: false, writable: false })
  const state = await s.runtime.app.request(statePath(opened.id), { headers: { cookie: s.visit.doctor } })
  expect(await state.json()).toMatchObject({ active: false, writable: false, displayed: false })
  expect((await s.acknowledge()).status).toBe(409)
  const fresh = await s.session(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(fresh.id).not.toBe(opened.id)
  expect(fresh.writable).toBe(true)
})

it('未知绑定明确查无后重发冻结原体，报告更正不会改写原绑定意图', async () => {
  const remote = new SyntheticPathJxService(), bindingBodies: unknown[] = []
  const s = await setup({ remote, fetch: async (input, init) => {
    if (new URL(String(input)).pathname.includes('/bindings/') && init?.method === 'PUT') {
      bindingBodies.push(JSON.parse(String(init.body)))
      if (bindingBodies.length === 1) throw new Error('Synthetic binding request not received')
    }
    return remote.fetch(input, init)
  } })
  expect((await s.open()).status).toBe(503)
  expect((await s.correct()).status).toBe(200)
  const current = (await s.detail()).pathologyRequests!.requests[0]!
  const next = await s.session(randomUUID(), { ...s.input, generation: randomUUID(), requestVersion: current.version,
    reportId: current.report!.diagnosticReportId, reportVersion: current.report!.diagnosticReportVersion })
  expect(next.reportId).toBe(current.report!.diagnosticReportId)
  expect(bindingBodies).toHaveLength(2)
  expect(bindingBodies[1]).toEqual(bindingBodies[0])
  expect(bindingBodies[1]).toMatchObject({ context: { reportId: s.input.reportId } })
})
