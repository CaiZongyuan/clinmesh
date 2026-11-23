import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { pathologyReadingStatusSchema } from '@clinmesh/contracts/pathology-reading'
import { mutation } from './fixtures/imaging-scenario.ts'
import { createPathologyReadingScenario, SyntheticPathJxService } from './fixtures/pathology-reading-scenario.ts'

type Scenario = Awaited<ReturnType<typeof createPathologyReadingScenario>>
const scenarios: Scenario[] = []
afterEach(async () => { for (const scenario of scenarios.splice(0)) await scenario.close() })
async function setup(options?: Parameters<typeof createPathologyReadingScenario>[0]) {
  const scenario = await createPathologyReadingScenario(options)
  scenarios.push(scenario)
  return scenario
}
async function status(s: Scenario) {
  const response = await s.runtime.app.request('/api/sim/v1/admin/pathology-reading/status', { headers: { cookie: s.admin } })
  expect(response.status).toBe(200)
  return pathologyReadingStatusSchema.parse(await response.json())
}
async function advance(s: Scenario, sessionId: string, revision: number) {
  const bindingId = [...s.remote.bindings.keys()][0]!, intentId = `synthetic-action-${revision}`
  const authorized = await s.callback(sessionId, { event: 'authorize', bindingId, revision: revision - 1, intentId })
  expect(await authorized.json()).toEqual({ active: true, writable: true })
  s.remote.revision = revision
  const committed = await s.callback(sessionId, { event: 'committed', bindingId, previousRevision: revision - 1, revision, intentId })
  expect(await committed.json()).toEqual({ active: true, writable: false })
}
async function expectRepairWithoutReplacement(s: Scenario, before: { bindings: number; sessions: number }) {
  const opened = await s.open()
  expect(opened.status).toBe(409)
  expect(await opened.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_REPAIR_REQUIRED' } })
  expect(await status(s)).toMatchObject({ state: 'repair-required' })
  const repeated = await s.open()
  expect(repeated.status).toBe(409)
  expect(await repeated.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_REPAIR_REQUIRED' } })
  expect(s.remote.count('PUT', '/bindings/')).toBe(before.bindings)
  expect(s.remote.count('POST', '/sessions')).toBe(before.sessions)
  const report = (await s.detail()).pathologyRequests!.requests[0]!.report!
  expect(report.diagnosticReportId).toBe(s.input.reportId)
  expect(report.diagnosis).toBe('合成结直肠切片会诊诊断')
  expect((await s.acknowledge()).status).toBe(409)
}
function writeCounts(s: Scenario) {
  return { bindings: s.remote.count('PUT', '/bindings/'), sessions: s.remote.count('POST', '/sessions') }
}

it('切换同合同服务实例不能接管历史切片，重新启用原实例沿用原绑定', async () => {
  const original = new SyntheticPathJxService()
  const replacement = new SyntheticPathJxService({ kind: 'pathjx', instanceId: 'synthetic-replacement-instance',
    assetKey: 'synthetic-colorectal-slide', contentHash: 'b'.repeat(64), organ: 'colorectal', specimenType: 'resection', stain: 'HE' })
  const replacementOrigin = 'http://synthetic-replacement.invalid'
  const s = await setup({ remote: original, trustedOrigins: ['http://synthetic-pathjx.invalid', replacementOrigin],
    fetch: (input, init) => new URL(String(input)).origin === replacementOrigin ? replacement.fetch(input, init) : original.fetch(input, init) })
  const first = await s.session(), before = writeCounts(s)
  const switched = await s.runtime.app.request('/api/sim/v1/admin/pathology-reading/config', mutation(s.admin, {
    expectedVersion: 1, enabled: true, instanceId: 'synthetic-replacement-instance', endpoint: replacementOrigin, viewerOrigin: replacementOrigin,
  }, 'PUT'))
  expect(switched.status).toBe(200)
  expect(await status(s)).toMatchObject({ state: 'ready', config: { instanceId: 'synthetic-replacement-instance' } })
  const unavailable = await s.open()
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_ORIGINAL_SERVICE_UNAVAILABLE' } })
  expect(replacement.count('PUT', '/bindings/')).toBe(0)
  expect(replacement.count('POST', '/sessions')).toBe(0)
  expect((await s.detail()).pathologyRequests!.requests[0]!.report!.diagnosticReportId).toBe(first.reportId)
  expect((await s.configure(true, 2)).status).toBe(200)
  expect(await s.session()).toMatchObject({ requestId: first.requestId, reportId: first.reportId, writable: true })
  expect(original.count('PUT', '/bindings/')).toBe(before.bindings)
  expect(original.bindings.size).toBe(1)
})

it('同合同新增模型可经原能力入口发现，不重绑历史或隐式创建分析', async () => {
  const s = await setup(), first = await s.session()
  const initial = await status(s), before = writeCounts(s)
  expect(initial.capabilities).toHaveLength(1)
  s.remote.capabilities.push({ taskCode: 'synthetic-colorectal-additional-review', modelVersion: 'synthetic-v2',
    modelDigest: 'c'.repeat(64), organ: 'colorectal', specimenTypes: ['resection'], stain: 'HE', available: true,
    limitations: ['新增合成能力，仅验证登记发现，不运行模型'] })
  expect((await status(s)).capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({ taskCode: 'synthetic-colorectal-additional-review', modelVersion: 'synthetic-v2', modelDigest: 'c'.repeat(64) }),
  ]))
  expect(await s.session()).toMatchObject({ requestId: first.requestId, reportId: first.reportId })
  expect(s.remote.count('PUT', '/bindings/')).toBe(before.bindings)
  expect(s.remote.calls.filter(call => call.method !== 'GET').every(call => call.path.startsWith('/bindings/') || call.path === '/sessions')).toBe(true)
})

// ClinMesh uses its real SQLite backup/restore and runtime restart. The remote snapshots below
// represent only the controlled PathJX HTTP boundary, not a PathJX PostgreSQL restore exercise.
it('只恢复 ClinMesh 较旧 SQLite 后拒绝已推进的远端修订，保留文字报告且不补建', async () => {
  const s = await setup(), first = await s.session(), backup = await s.backup('before-confirmed-action')
  await advance(s, first.sessionId, 1)
  const before = writeCounts(s)
  await s.restore(backup)
  await expectRepairWithoutReplacement(s, before)
})

it('只恢复受控 PathJX 较旧状态后拒绝确认修订回退，不补建原对象', async () => {
  const s = await setup(), first = await s.session()
  const remoteSnapshot = { revision: s.remote.revision, bindings: new Map(s.remote.bindings) }
  await advance(s, first.sessionId, 1)
  s.remote.revision = remoteSnapshot.revision
  s.remote.bindings.clear()
  for (const [id, binding] of remoteSnapshot.bindings) s.remote.bindings.set(id, binding)
  await expectRepairWithoutReplacement(s, writeCounts(s))
})

it('受控 PathJX 恢复缺少原对象时明确待修复，不拿同内容重建或换片', async () => {
  const s = await setup()
  await s.session()
  s.remote.bindings.clear()
  await expectRepairWithoutReplacement(s, writeCounts(s))
})

it('匹配恢复 SQLite 与受控远端确认版本后可继续原会诊并推进下一修订', async () => {
  const s = await setup(), first = await s.session()
  await advance(s, first.sessionId, 1)
  const backup = await s.backup('matched-confirmed-action')
  const remoteSnapshot = { revision: s.remote.revision, bindings: new Map(s.remote.bindings), sessions: new Map(s.remote.sessions),
    authorizationTokens: new Map(s.remote.authorizationTokens) }
  await advance(s, first.sessionId, 2)
  const before = writeCounts(s)
  await s.restore(backup)
  s.remote.revision = remoteSnapshot.revision
  s.remote.bindings.clear()
  for (const [id, binding] of remoteSnapshot.bindings) s.remote.bindings.set(id, binding)
  s.remote.sessions.clear()
  for (const [id, session] of remoteSnapshot.sessions) s.remote.sessions.set(id, session)
  s.remote.authorizationTokens.clear()
  for (const [id, token] of remoteSnapshot.authorizationTokens) s.remote.authorizationTokens.set(id, token)
  const recovered = await s.session(randomUUID(), { ...s.input, generation: randomUUID() })
  expect(recovered).toMatchObject({ requestId: first.requestId, reportId: first.reportId, writable: true })
  expect(await status(s)).toMatchObject({ state: 'ready' })
  expect(s.remote.count('PUT', '/bindings/')).toBe(before.bindings)
  await advance(s, recovered.sessionId, 2)
  expect((await s.detail()).pathologyRequests!.requests[0]!.report!.diagnosticReportId).toBe(first.reportId)
})
