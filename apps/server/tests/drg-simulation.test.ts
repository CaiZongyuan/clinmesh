import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { simCatalogSchema, simViewSchema } from '@clinmesh/contracts/drg'
import { createDrgReferenceFixture } from './fixtures/drg-reference.ts'
import { startBrowserServer } from './browser-server.ts'
import { simulationRules } from '../src/application/drg-simulation-service.ts'
import { importPreparedCatalogues, readPreparedRecord } from '../src/infrastructure/reference-data/prepared-catalogues.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { runReferenceSync } from '../src/reference-sync.ts'

describe('持久化住院 DRG 模拟', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-test-'))
    cleanups.push(() => rm(directory, { force: true, recursive: true }))
    const fixture = await createDrgReferenceFixture(directory)
    const server = await startBrowserServer('', { referenceDatabasePath: fixture.databasePath })
    cleanups.push(server.close)
    const app = server.runtime.app
    const login = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'doctor@demo.clinmesh.local', password: server.password }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    async function request(path: string, body?: unknown, key: string = randomUUID(), overrideCookie = cookie) {
      return app.request(`/api/sim/v1/drg${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { origin: server.origin, cookie: overrideCookie, 'content-type': 'application/json', 'idempotency-key': key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    }
    const created = await request('/cases', {})
    expect(created.status).toBe(200)
    const state = simViewSchema.parse((await created.json()).data).case
    return { ...fixture, state, request, server }
  }

  it('处方计价只乘总数量，开具重试不重复记费，重新分组保留旧费用与历史', async () => {
    const { state, request, server, databasePath } = await setup()
    const lines = [{ mappingId: 'SIM-CEFTRIAXONE', quantity: 3, dose: '1g', frequency: '每日一次', days: 7 }]
    const pre = await request(`/cases/${state.id}/preview`, { expectedRevision: 1, lines })
    const quoted = simViewSchema.parse(await pre.json()).assessment
    expect(quoted.draftChargeFen).toBe(14513)
    expect(quoted.draftCostFen).toBe(8138)
    const issue = { expectedRevision: 1, action: { kind: 'issue', lines } }
    const first = await request(`/cases/${state.id}/actions/change`, issue, 'same-key')
    const firstData = await first.json()
    const issued = simViewSchema.parse(firstData.data)
    expect(issued.case.lines).toHaveLength(1)
    expect(issued.assessment.incurredChargeFen).toBe(254513)
    expect(issued.assessment.committedChargeFen).toBe(0)
    const replay = await request(`/cases/${state.id}/actions/change`, issue, 'same-key')
    expect(await replay.json()).toEqual(firstData)
    const stale = await request(`/cases/${state.id}/actions/change`, issue)
    expect(stale.status).toBe(409)
    const clinical = { ...state.clinical, secondaryDiagnosisIds: [simulationRules.complicationId] }
    const hypothesis = simViewSchema.parse(await (await request(`/cases/${state.id}/preview`, { expectedRevision: 2, lines: [], clinical })).json())
    expect(hypothesis.assessment.group?.referenceFen).toBe(1800000)
    expect(hypothesis.case.clinical.secondaryDiagnosisIds).toEqual([])
    const confirmed = await request(`/cases/${state.id}/actions/change`, { expectedRevision: 2, action: { kind: 'confirm-clinical', clinical } })
    const regrouped = simViewSchema.parse((await confirmed.json()).data)
    expect(regrouped.assessment.group?.referenceFen).toBe(1800000)
    expect(regrouped.assessment.incurredChargeFen).toBe(254513)
    expect(regrouped.case.lines[0]?.mapping.chargePrice).toBe('48.375')
    expect(regrouped.case.history).toHaveLength(3)
    expect(regrouped.case.history[1]?.assessment.group?.referenceFen).toBe(1000000)
    const persisted = simViewSchema.parse(await (await request(`/cases/${state.id}`)).json())
    expect(persisted).toEqual(regrouped)
    const operationalPath = server.runtime.database.driver.name
    await server.runtime.close()
    const restarted = await createClinMeshRuntime({ databasePath: operationalPath, migrationMode: 'verify',
      referenceDatabasePath: databasePath, authBaseUrl: server.origin, trustedOrigins: [server.origin],
      authSecret: 'synthetic-restart-auth-secret-32-characters', cursorSecret: 'synthetic-restart-cursor-secret-32-characters', demoPassword: server.password })
    cleanups.push(() => restarted.close())
    const login = await restarted.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'doctor@demo.clinmesh.local', password: server.password }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const restored = await restarted.app.request(`/api/sim/v1/drg/cases/${state.id}`, { headers: { cookie } })
    expect(simViewSchema.parse(await restored.json())).toEqual(regrouped)
  })

  it('待记费转为发生不双算，收费发生和成本执行独立，撤回不会自动删除费用', async () => {
    const { state, request } = await setup()
    const act = async (expectedRevision: number, action: unknown) => {
      const response = await request(`/cases/${state.id}/actions/change`, { expectedRevision, action })
      expect(response.status).toBe(200)
      return simViewSchema.parse((await response.json()).data)
    }
    const issued = await act(1, { kind: 'issue', lines: [{ mappingId: 'SIM-INFUSION', quantity: 3, dose: '', frequency: '', days: 3 }] })
    const lineId = issued.case.lines[0]!.id
    expect(issued.assessment.committedChargeFen).toBe(10800)
    const charged = await act(2, { kind: 'record-charge', lineId })
    expect(charged.assessment.committedChargeFen).toBe(0)
    expect(charged.assessment.totalChargeFen).toBe(issued.assessment.totalChargeFen)
    expect(charged.assessment.committedCostFen).toBe(6450)
    const withdrawn = await act(3, { kind: 'withdraw', lineId })
    expect(withdrawn.assessment.totalChargeFen).toBe(charged.assessment.totalChargeFen)
    const reversed = await act(4, { kind: 'reverse', lineId })
    expect(reversed.assessment.incurredChargeFen).toBe(240000)
    expect(reversed.assessment.committedCostFen).toBe(0)
    const second = await act(5, { kind: 'issue', lines: [{ mappingId: 'SIM-AMOX', quantity: 1, dose: '', frequency: '', days: 1 }] })
    const secondId = second.case.lines[1]!.id
    await act(6, { kind: 'execute', lineId: secondId })
    const stopped = await act(7, { kind: 'withdraw', lineId: secondId })
    expect(stopped.assessment.incurredCostFen).toBe(160820)
    expect((await request(`/cases/${state.id}/actions/change`, { expectedRevision: 8, action: { kind: 'reverse', lineId: secondId } })).status).toBe(409)
  })

  it('缺价格保留 null，缺规则没有确定剩余额度，超额仍可开具', async () => {
    const { state, request } = await setup()
    const lines = [{ mappingId: 'SIM-PENDING', quantity: 1, dose: '', frequency: '', days: 1 }]
    const incomplete = simViewSchema.parse(await (await request(`/cases/${state.id}/preview`, { expectedRevision: 1, lines })).json()).assessment
    expect(incomplete.totalChargeFen).toBeNull()
    expect(incomplete.costBalanceFen).toBeNull()
    expect(incomplete.remainingFen).toBeNull()
    expect(incomplete.knownChargeFen).toBe(360000)
    const excessive = [{ ...lines[0], mappingId: 'SIM-CEFTRIAXONE', quantity: 1000 }]
    const chargeOnlyOver = simViewSchema.parse(await (await request(`/cases/${state.id}/preview`, { expectedRevision: 1, lines: [{ ...excessive[0], quantity: 200 }] })).json()).assessment
    expect(chargeOnlyOver.chargeProgress).toBeGreaterThan(1)
    expect(chargeOnlyOver.costBalanceFen).toBeGreaterThan(0)
    const preview = simViewSchema.parse(await (await request(`/cases/${state.id}/preview`, { expectedRevision: 1, lines: excessive })).json()).assessment
    expect(preview.chargeProgress).toBeGreaterThan(1)
    expect(preview.costBalanceFen).toBeLessThan(0)
    expect((await request(`/cases/${state.id}/actions/change`, { expectedRevision: 1, action: { kind: 'issue', lines: excessive } })).status).toBe(200)
    const unknownGroup = simViewSchema.parse(await (await request(`/cases/${state.id}/preview`, { expectedRevision: 2, lines: [], clinical: {
      mainDiagnosisId: 'icd10-p1310-r03', secondaryDiagnosisIds: [], completedProcedureIds: [],
    } })).json()).assessment
    expect(unknownGroup.group).toBeNull()
    expect(unknownGroup.remainingFen).toBeNull()
    expect((await request(`/cases/${state.id}/preview`, { expectedRevision: 2, lines: [{ ...lines[0], mappingId: 'arbitrary' }] })).status).toBe(422)
    expect((await request(`/cases/${state.id}/preview`, { expectedRevision: 2, lines: [], clinical: { ...state.clinical, completedProcedureIds: ['hierarchy-only'] } })).status).toBe(422)
  })

  it('参考导入幂等，源价与模拟价分开，保密标记保留且版本不可覆盖', async () => {
    const { databasePath, manifestPath, lock, request } = await setup()
    const catalog = simCatalogSchema.parse(await (await request('/catalog')).json())
    expect(catalog.mappings.find(item => item.id === 'SIM-INFUSION')?.chargePrice).toBe('36.00')
    const db = openReferenceDatabase({ databasePath, busyTimeoutMs: 5000 })
    try {
      expect((await importPreparedCatalogues(db, manifestPath, lock)).created).toBe(false)
      const drug = readPreparedRecord(db, lock.releaseId, 'drugs', 'drugs-p009-t0-r027')
      expect(drug?.payload.paymentStandard).toEqual({ raw: '*', amount: null, state: 'confidential' })
      expect(() => db.driver.prepare('UPDATE prepared_reference_record SET code = ?').run('bad')).toThrow(/immutable/)
      await writeFile(manifestPath, '{}\n')
      await expect(importPreparedCatalogues(db, manifestPath, lock)).rejects.toThrow(/哈希/)
    } finally { db.close() }
    expect((await request('/catalog', undefined, randomUUID(), '')).status).toBe(401)
  })

  it('同一版本并发开具只有一次成功，不影响其他模拟病例', async () => {
    const { state, request } = await setup()
    const other = simViewSchema.parse((await (await request('/cases', {})).json()).data)
    const payload = { expectedRevision: 1, action: { kind: 'issue', lines: [{ mappingId: 'SIM-AMOX', quantity: 1, dose: '', frequency: '', days: 1 }] } }
    const results = await Promise.all([request(`/cases/${state.id}/actions/change`, payload), request(`/cases/${state.id}/actions/change`, payload)])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    const updated = simViewSchema.parse(await (await request(`/cases/${state.id}`)).json())
    expect(updated.case.lines).toHaveLength(1)
    expect(updated.case.revision).toBe(2)
    expect(simViewSchema.parse(await (await request(`/cases/${other.case.id}`)).json()).case.lines).toHaveLength(0)
  })

  it('清洗同步的 check-only 不写正式库且不调用签名 Registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-sync-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const { lock } = await createDrgReferenceFixture(directory)
    const rootLock = JSON.parse(await readFile(new URL('../../../reference-data.lock.json', import.meta.url), 'utf8'))
    const lockPath = join(directory, 'lock.json')
    await writeFile(lockPath, JSON.stringify({ ...rootLock, preparedRelease: lock }))
    const databasePath = join(directory, 'not-created.sqlite')
    const result = await runReferenceSync({ lockPath, repositoryRoot: directory, databasePath, checkOnly: true, preparedOnly: true })
    expect(result).toMatchObject({ checkOnly: true, prepared: { created: true, releaseId: lock.releaseId } })
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
