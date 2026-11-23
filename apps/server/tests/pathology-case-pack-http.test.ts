import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { authoredCasePackPrepareResponseSchema, authoredCasePackSummarySchema } from '@clinmesh/contracts/inpatient-pci-data'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations-runtime'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { mutation, signIn, startConsultation } from './fixtures/imaging-scenario.ts'

it('管理员准备病理两例并按原键恢复，其他病例包不能复用该键混回执，通用回执GET保持可读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pathology-pack-http-'))
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-with-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret', databasePath: join(directory, 'runtime.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply', autoDispatchIntervalMs: 0, trustedOrigins: ['http://localhost'] })
  try {
    const admin = await signIn(runtime), doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
    const base = '/api/sim/v1/admin/pathology-case-pack'
    expect((await runtime.app.request(base, { headers: { cookie: doctor } })).status).toBe(403)
    const before = authoredCasePackSummarySchema.parse(await (await runtime.app.request(base, { headers: { cookie: admin } })).json())
    expect(before).toMatchObject({ packageId: 'clinmesh-pathology-consultations-v1', readyCount: 0, totalCount: 2 })
    const key = randomUUID(), body = { input: { expectedEpoch: 'epoch-1' } }
    const prepare = (path: string) => {
      const init = mutation(admin, body)
      init.headers['idempotency-key'] = key
      return runtime.app.request(path, init)
    }
    const prepared = await prepare(`${base}/prepare`)
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const original = authoredCasePackPrepareResponseSchema.parse(await prepared.json())
    expect(original.data).toMatchObject({ packageId: before.packageId, readyCount: 2, totalCount: 2 })
    expect(original.data.cases.map(item => item.case?.status)).toEqual(['brief-ready', 'brief-ready'])
    const conflict = await prepare('/api/sim/v1/synthetic-cases/authored-pack/prepare')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } })
    const replay = await prepare(`${base}/prepare`)
    expect(replay.status).toBe(200)
    expect(authoredCasePackPrepareResponseSchema.parse(await replay.json())).toEqual(original)
    const lookup = await runtime.app.request(`/api/his/v1/command-receipts?operationId=admin.authored-case-pack.prepare&idempotencyKey=${key}`, { headers: { cookie: admin } })
    expect(lookup.status).toBe(200)
    expect(commandReceiptLookupSchema.parse(await lookup.json())).toMatchObject({ status: 'completed', idempotencyKey: key, response: original })
    const fresh = await runtime.app.request(`${base}/prepare`, mutation(admin, body))
    expect(fresh.status).toBe(200)
    const repeated = authoredCasePackPrepareResponseSchema.parse(await fresh.json())
    expect(repeated.effects).toEqual([])
    expect(repeated.data.cases.map(item => item.case)).toEqual(original.data.cases.map(item => item.case))
    const selected = original.data.cases[0]!.case!
    await startConsultation(runtime, admin, selected.caseId)
    const afterStart = await runtime.app.request(`${base}/prepare`, mutation(admin, body))
    expect(afterStart.status, await afterStart.clone().text()).toBe(200)
    const retained = authoredCasePackPrepareResponseSchema.parse(await afterStart.json())
    expect(retained.effects).toEqual([])
    expect(retained.data.cases[0]!.case).toMatchObject({ caseId: selected.caseId, profileRevision: selected.profileRevision, status: 'started' })
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
})
