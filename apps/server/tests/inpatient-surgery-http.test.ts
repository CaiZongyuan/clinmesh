import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiErrorSchema, commandResponseSchema } from '@clinmesh/contracts/his'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCompletionPreviewSchema, inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-surgery-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成手术患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

async function previewCompletion(s: Awaited<ReturnType<typeof setup>>, input: unknown) {
  const response = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, input)
  expect(response.status, await response.clone().text()).toBe(200)
  return inpatientSurgeryCompletionPreviewSchema.parse(await response.json())
}

describe('住院手术公共 HTTP 与真实 SQLite', () => {
  it('同一预留的不同冻结快照分别核实，保持原用量、费用与未选余量', async () => {
    const { s, state, reservation } = await surgeryWithDistinctReservationSnapshots()
    const execution = state.inProgress[0]!
    const common = { requestId: execution.requestId, expectedRequestVersion: state.requests[0]!.version,
      executionId: execution.id, note: '按各笔原冻结依据核实最终总量' }
    const draft = { finalMaterials: execution.materials.map(use => ({ materialId: use.item.id, catalogVersion: use.item.version,
      quantity: use.quantity, materialUseIds: [use.id], reservationId: reservation.id, expectedReservationVersion: reservation.version })), releaseReservations: [] }
    const preview = await previewCompletion(s, { ...common, ...draft })
    expect(preview.materialDeltaFen).toBe(0)
    expect(preview.materials.map(item => item.item.display)).toEqual(execution.materials.map(use => use.item.display))
    const response = await s.request(s.doctor, `${s.path}/surgeries/complete`, { ...common,
      reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })
    expect(response.status).toBe(200)
    expect(inpatientSurgeryResponseSchema.parse(await response.json()).data.executions[0]!.materialHistory).toEqual(execution.materialHistory)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(440000)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0])
      .toMatchObject({ status: 'reserved', consumedQuantity: 3, remainingQuantity: 2 })
  })
  it('同一耗尽预留跨冻结依据先减后增，按净量核实且整笔失败不留部分更正', async () => {
    const { s, state, reservation } = await surgeryWithDistinctReservationSnapshots(3)
    const execution = state.inProgress[0]!
    const common = { requestId: execution.requestId, expectedRequestVersion: state.requests[0]!.version,
      executionId: execution.id, note: '首笔增至两枚，第二笔减为一枚，合计仍为三枚' }
    const draft = { finalMaterials: execution.materials.map((use, index) => ({ materialId: use.item.id, catalogVersion: use.item.version,
      quantity: index === 0 ? 2 : 1, materialUseIds: [use.id], reservationId: reservation.id, expectedReservationVersion: reservation.version })),
      releaseReservations: [{ reservationId: reservation.id, expectedReservationVersion: reservation.version }] }
    const beforeCharges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    const preview = await previewCompletion(s, { ...common, ...draft })
    expect(preview.materials.map(row => row.deltaQuantity)).toEqual([1, -1])
    expect(preview.materialDeltaFen).toBe(0)
    const input = { ...common, reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } }, key = randomUUID()
    s.runtime.database.driver.exec("CREATE TRIGGER fail_snapshot_completion BEFORE INSERT ON inpatient_charge WHEN NEW.kind='surgery' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END;")
    expect((await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)).status).toBe(500)
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(state)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(beforeCharges)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]).toEqual(reservation)
    s.runtime.database.driver.exec('DROP TRIGGER fail_snapshot_completion')
    const response = await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)
    expect(response.status).toBe(200)
    const receipt = inpatientSurgeryResponseSchema.parse(await response.json()), completed = receipt.data.executions[0]!
    expect(completed.materials.filter(use => use.item.display === execution.materials[0]!.item.display).reduce((sum, use) => sum + use.quantity, 0)).toBe(2)
    expect(completed.materials.filter(use => use.item.display === execution.materials[1]!.item.display).reduce((sum, use) => sum + use.quantity, 0)).toBe(1)
    expect(completed.materialHistory.find(use => use.id === execution.materials[0]!.id)).toEqual(execution.materialHistory[0])
    expect(completed.materialHistory.find(use => use.id === execution.materials[1]!.id)!.correction).not.toBeNull()
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(440000)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0])
      .toMatchObject({ status: 'replaced', consumedQuantity: 3, remainingQuantity: 0, releaseReason: common.note })
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)).json()).toEqual(receipt)
  })
  it('同一预留按合计余量拒绝多行超用、相同冻结依据重复和不同依据合并', async () => {
    const { s, state, reservation } = await surgeryWithDistinctReservationSnapshots()
    const execution = state.inProgress[0]!
    const rows = execution.materials.map(use => ({ materialId: use.item.id, catalogVersion: use.item.version,
      quantity: use.quantity, materialUseIds: [use.id], reservationId: reservation.id, expectedReservationVersion: reservation.version }))
    const invalidLists = [
      rows.map(row => ({ ...row, quantity: 3 })),
      [...rows, { ...rows[0]!, quantity: 1, materialUseIds: [] }],
      [{ ...rows[0]!, quantity: 3, materialUseIds: execution.materials.map(use => use.id) }],
    ]
    for (const finalMaterials of invalidLists) {
      const response = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { requestId: execution.requestId,
        expectedRequestVersion: state.requests[0]!.version, executionId: execution.id, note: '合成无效总量核实', finalMaterials, releaseReservations: [] })
      expect(response.status).toBe(409)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INPATIENT_SURGERY_REVIEW_CONFLICT')
    }
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(state)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]).toEqual(reservation)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(240000)
  })
  it.each([
    { quantities: [2, 3], deltaFen: 160000, consumed: 5, totalFen: 600000 },
    { quantities: [0, 0], deltaFen: -240000, consumed: 0, totalFen: 200000 },
  ])('同一预留不同冻结依据核实最终 $quantities，只记本次净差额', async ({ quantities, deltaFen, consumed, totalFen }) => {
    const { s, state, reservation } = await surgeryWithDistinctReservationSnapshots()
    const execution = state.inProgress[0]!
    const common = { requestId: execution.requestId, expectedRequestVersion: state.requests[0]!.version,
      executionId: execution.id, note: '合成不同冻结依据的最终真实总量' }
    const draft = { finalMaterials: execution.materials.map((use, index) => ({ materialId: use.item.id, catalogVersion: use.item.version,
      quantity: quantities[index], materialUseIds: [use.id], reservationId: reservation.id, expectedReservationVersion: reservation.version })), releaseReservations: [] }
    const preview = await previewCompletion(s, { ...common, ...draft })
    expect(preview.materialDeltaFen).toBe(deltaFen)
    const response = await s.request(s.doctor, `${s.path}/surgeries/complete`, { ...common,
      reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })
    expect(response.status).toBe(200)
    const completed = inpatientSurgeryResponseSchema.parse(await response.json()).data.executions[0]!
    expect(completed.materials.reduce((sum, use) => sum + use.quantity, 0)).toBe(consumed)
    expect(completed.materialHistory.every(use => use.quantity > 0)).toBe(true)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(totalFen)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0])
      .toMatchObject({ status: consumed === 5 ? 'replaced' : 'reserved', consumedQuantity: consumed, remainingQuantity: 5 - consumed, releaseReason: null })
  })
  it.each([0, 2])('无逐笔事件时核实最终 %i 件，预览后只提交实际差额并恢复原回执', async quantity => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    const running = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始',
    })).json()).data
    const common = { requestId: row.id, expectedRequestVersion: running.requests[0]!.version,
      executionId: running.inProgress[0]!.id, note: '核实最终真实用量' }
    const reconciliation = { finalMaterials: [
      { materialId: 'hospital-material-stent', catalogVersion: 1, quantity, materialUseIds: [] },
      { materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 0, materialUseIds: [] },
    ], releaseReservations: [] }
    const preview = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { ...common, ...reconciliation })
    expect(preview.status).toBe(200)
    const reviewed = inpatientSurgeryCompletionPreviewSchema.parse(await preview.json())
    expect(reviewed).toMatchObject({ materialDeltaFen: quantity === 0 ? 0 : 160000, procedureAmountFen: 200000, totalDeltaFen: quantity === 0 ? 200000 : 360000 })
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(0)
    const input = { ...common, reconciliation: { ...reconciliation, expectedFingerprint: reviewed.fingerprint } }, key = randomUUID()
    const completed = await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)
    expect(completed.status).toBe(200)
    const receipt = inpatientSurgeryResponseSchema.parse(await completed.json())
    expect(receipt.data.executions[0]!.materials).toEqual(quantity === 0 ? [] : [expect.objectContaining({ quantity: 2, amountFen: 160000 })])
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)).json()).toEqual(receipt)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(quantity === 0 ? 200000 : 360000)
  })
  it.each([0, 1, 3])('已有更正后按净实际量核实最终 %i 件，未选预留保留', async quantity => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    for (const materialId of ['hospital-material-stent', 'hospital-material-balloon'])
      expect((await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
        requestId: row.id, materialId, catalogVersion: 1, quantity: 5, reason: '合成原计划预留' })).status).toBe(200)
    let reservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    const reserved = reservations.reservations.find(item => item.materialId === 'hospital-material-stent')!
    let state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始',
    })).json()).data
    const executionId = state.inProgress[0]!.id
    state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
      requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId, note: '原误录三枚',
      material: { materialId: reserved.materialId, catalogVersion: 1, quantity: 3, reservationId: reserved.id, expectedReservationVersion: reserved.version },
    })).json()).data
    reservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/correct-material`, {
      requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId, note: '已更正为两枚', materialUseId: state.inProgress[0]!.materials[0]!.id,
      replacement: { materialId: reserved.materialId, catalogVersion: 1, quantity: 2, reservationId: reserved.id,
        expectedReservationVersion: reservations.reservations.find(item => item.id === reserved.id)!.version },
    })).json()).data
    reservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    const visible = reservations.reservations.find(item => item.id === reserved.id)!, other = reservations.reservations.find(item => item.id !== reserved.id)!
    const common = { requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId, note: '核实最终用量' }
    const draft = { finalMaterials: [{ materialId: reserved.materialId, catalogVersion: 1, quantity,
      materialUseIds: state.inProgress[0]!.materials.map(item => item.id), reservationId: reserved.id, expectedReservationVersion: visible.version }], releaseReservations: [] }
    if (quantity === 1) {
      for (const materialUseIds of [[], [draft.finalMaterials[0]!.materialUseIds[0], draft.finalMaterials[0]!.materialUseIds[0]], [state.inProgress[0]!.materialHistory[0]!.id]]) {
        const rejected = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, {
          ...common, ...draft, finalMaterials: [{ ...draft.finalMaterials[0], materialUseIds }],
        })
        expect(rejected.status).toBe(409)
        expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_SURGERY_REVIEW_CONFLICT')
      }
    }
    const previewResponse = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { ...common, ...draft })
    expect(previewResponse.status).toBe(200)
    const preview = inpatientSurgeryCompletionPreviewSchema.parse(await previewResponse.json())
    expect(preview.materialDeltaFen).toBe(({ 0: -160000, 1: -80000, 3: 80000 })[quantity])
    const completed = await s.request(s.doctor, `${s.path}/surgeries/complete`, { ...common, reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })
    expect(completed.status).toBe(200)
    const receipt = inpatientSurgeryResponseSchema.parse(await completed.json()), result = receipt.data.executions[0]!
    expect(result.materials.reduce((sum, item) => sum + item.quantity, 0)).toBe(quantity)
    expect(result.materialHistory[0]).toEqual(state.inProgress[0]!.materialHistory[0])
    const after = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    expect(after.reservations.find(item => item.id === reserved.id)).toMatchObject({ status: 'reserved', consumedQuantity: quantity, remainingQuantity: 5 - quantity })
    expect(after.reservations.find(item => item.id === other.id)).toEqual(other)
    expect(receipt.warnings.join(' ')).toContain(other.id)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(({ 0: 200000, 1: 280000, 3: 440000 })[quantity])
  })
  it('多候选预留必须明确引用，只释放选中本计划项；目录变化拒绝旧审阅且故障整笔回滚', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    const another = (await readySurgery(s, false)).requests.find((item: { id: string }) => item.id !== row.id)
    for (const requestId of [row.id, row.id, another.id, undefined])
      expect((await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
        ...(requestId ? { requestId } : {}), materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 3, reason: '合成多候选隔离' })).status).toBe(200)
    const reservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    const selected = reservations.reservations.find(item => item.requestId === row.id)!, cross = reservations.reservations.find(item => item.requestId === another.id)!
    const running = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始',
    })).json()).data
    const common = { requestId: row.id, expectedRequestVersion: running.requests.find(item => item.id === row.id)!.version,
      executionId: running.inProgress[0]!.id, note: '本次只使用并释放明确选中的原预留' }
    const draft = { finalMaterials: [{ materialId: selected.materialId, catalogVersion: 1, quantity: 1, materialUseIds: [],
      reservationId: selected.id, expectedReservationVersion: selected.version }],
      releaseReservations: [{ reservationId: selected.id, expectedReservationVersion: selected.version }] }
    expect((await s.request(s.nurse, `${s.path}/surgeries/preview-completion`, { ...common, ...draft })).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { ...common, ...draft,
      releaseReservations: [{ reservationId: cross.id, expectedReservationVersion: cross.version }] })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { ...common, ...draft,
      finalMaterials: [{ ...draft.finalMaterials[0], reservationId: cross.id, expectedReservationVersion: cross.version }] })).status).toBe(409)
    const preview = await previewCompletion(s, { ...common, ...draft })
    s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',90000) WHERE item_id='hospital-material-stent'")
    const stale = await s.request(s.doctor, `${s.path}/surgeries/complete`, { ...common, reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })
    expect(stale.status).toBe(409)
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('INPATIENT_SURGERY_REVIEW_CONFLICT')
    const refreshed = await previewCompletion(s, { ...common, ...draft })
    expect(refreshed.materialDeltaFen).toBe(80000)
    const input = { ...common, reconciliation: { ...draft, expectedFingerprint: refreshed.fingerprint } }, key = randomUUID()
    s.runtime.database.driver.exec("CREATE TRIGGER fail_final_surgery BEFORE INSERT ON inpatient_charge WHEN NEW.kind='surgery' BEGIN SELECT RAISE(ABORT,'synthetic final failure'); END;")
    expect((await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)).status).toBe(500)
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(running)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())).toEqual(reservations)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    expect((await s.request(s.doctor, `/api/his/v1/command-receipts?operationId=inpatient.surgery.complete&idempotencyKey=${key}`)).status).toBe(404)
    s.runtime.database.driver.exec('DROP TRIGGER fail_final_surgery')
    const completed = await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)
    expect(completed.status).toBe(200)
    const result = inpatientSurgeryResponseSchema.parse(await completed.json())
    const recovered = await (await s.request(s.doctor, `/api/his/v1/command-receipts?operationId=inpatient.surgery.complete&idempotencyKey=${key}`)).json()
    expect(recovered.response).toEqual(result)
    const after = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    expect(after.reservations.find(item => item.id === selected.id)).toMatchObject({ status: 'released', consumedQuantity: 1, remainingQuantity: 0, priceFen: 80000 })
    for (const item of reservations.reservations.filter(item => item.id !== selected.id)) expect(after.reservations.find(value => value.id === item.id)).toEqual(item)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(280000)
  })
  it('减少使用保留历史冻结价；已有财务冲正时预览与提交均不重复退款', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    let state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始',
    })).json()).data
    const executionId = state.inProgress[0]!.id
    state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
      requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId, note: '合成原使用两枚',
      material: { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2 },
    })).json()).data
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()), charge = charges.charges[0]!
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '先办理财务精确冲正' })).status).toBe(200)
    s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.version',2,'$.chargeDefinition.priceFen',90000) WHERE item_id='hospital-material-stent'")
    const common = { requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId, note: '核实原实际使用应为一枚' }
    const draft = { finalMaterials: [{ materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1,
      materialUseIds: state.inProgress[0]!.materials.map(item => item.id) }], releaseReservations: [] }
    const response = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, { ...common, ...draft })
    expect(response.status).toBe(200)
    const preview = inpatientSurgeryCompletionPreviewSchema.parse(await response.json())
    expect(preview).toMatchObject({ materialDeltaFen: 80000, totalDeltaFen: 280000 })
    const completed = await s.request(s.doctor, `${s.path}/surgeries/complete`, { ...common, reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })
    expect(completed.status).toBe(200)
    const execution = inpatientSurgeryResponseSchema.parse(await completed.json()).data.executions[0]!
    expect(execution.materials[0]).toMatchObject({ quantity: 1, amountFen: 80000, item: { version: 1 } })
    const after = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(after.charges.filter(item => item.reversalOf === charge.id)).toHaveLength(1)
    expect(after.chargesFen).toBe(280000)
  })
  it('旧预留缺少快照时只沿原使用恢复依据，无使用依据不按现行目录猜单位', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    for (const materialId of ['hospital-material-stent', 'hospital-material-balloon'])
      expect((await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
        requestId: row.id, materialId, catalogVersion: 1, quantity: 3, reason: '合成历史预留依据' })).status).toBe(200)
    const reserved = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations
      .find(item => item.materialId === 'hospital-material-stent')!
    let state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成历史开始',
    })).json()).data
    state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
      requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId: state.inProgress[0]!.id, note: '合成原记录两枚',
      material: { materialId: reserved.materialId, catalogVersion: 1, quantity: 2, reservationId: reserved.id, expectedReservationVersion: reserved.version },
    })).json()).data
    s.runtime.database.driver.exec("UPDATE inpatient_material_reservation SET material_snapshot_json=NULL; UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.unit','盒') WHERE item_id IN ('hospital-material-stent','hospital-material-balloon')")
    const historical = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations
    expect(historical.find(item => item.id === reserved.id)).toMatchObject({ unit: '个', priceFen: 80000 })
    expect(historical.find(item => item.materialId === 'hospital-material-balloon')).toMatchObject({ unit: null, specification: null })
    const preview = await previewCompletion(s, { requestId: row.id, expectedRequestVersion: state.requests[0]!.version, executionId: state.inProgress[0]!.id,
      note: '合成按原单位核实减少', finalMaterials: [{ materialId: reserved.materialId, catalogVersion: 1, quantity: 1,
        materialUseIds: state.inProgress[0]!.materials.map(item => item.id), reservationId: reserved.id,
        expectedReservationVersion: historical.find(item => item.id === reserved.id)!.version }], releaseReservations: [] })
    expect(preview.materials[0]!.item.chargeDefinition.unit).toBe('个')
    expect(preview.materialDeltaFen).toBe(-80000)
  })
  it('旧已完成且全耗尽的预留升级后继续关闭，历史用量、费用与回执不改写', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    const reserved = commandResponseSchema(inpatientMaterialReservationListSchema).parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`, {
      encounterVersion: prepared.encounterVersion, requestId: row.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成旧版全量预留',
    })).json()).data.reservations[0]!
    const key = randomUUID(), input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      note: '合成旧版全量实施', materials: [{ materialId: reserved.materialId, catalogVersion: 1, quantity: 2, reservationId: reserved.id }] }
    const receipt = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).json())
    const fees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    // 公开入口形成旧版相同的持久事实；移除本次迁移标记以验证真实重启升级。
    s.runtime.database.driver.prepare('DELETE FROM schema_migration WHERE migration_id=?').run('0102_surgery-reservation-completion-policy.sql')
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const invoke = (cookie: string, path: string, input?: unknown, idempotencyKey = randomUUID()) => reopened.app.request(path, {
      method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
    })
    const migrated = inpatientMaterialReservationListSchema.parse(await (await invoke(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]!
    expect(migrated).toMatchObject({ status: 'replaced', consumedQuantity: 2, remainingQuantity: 0, releaseReason: expect.stringContaining('历史手术已完成') })
    expect(inpatientSurgerySchema.parse(await (await invoke(s.doctor, `${s.path}/surgeries`)).json())).toEqual(receipt.data)
    expect(inpatientChargesSchema.parse(await (await invoke(s.cashier, `${s.path}/charges`)).json())).toEqual(fees)
    expect(inpatientSurgeryResponseSchema.parse(await (await invoke(s.doctor, `${s.path}/surgeries/execute`, input, key)).json())).toEqual(receipt)
    const corrected = await invoke(s.doctor, `${s.path}/surgeries/correct-material`, { requestId: row.id, expectedRequestVersion: receipt.data.requests[0]!.version,
      executionId: receipt.data.executions[0]!.id, materialUseId: receipt.data.executions[0]!.materials[0]!.id, note: '合成升级后减少为一枚',
      replacement: { materialId: reserved.materialId, catalogVersion: 1, quantity: 1, reservationId: reserved.id, expectedReservationVersion: migrated.version } })
    expect(corrected.status).toBe(200)
    expect(inpatientMaterialReservationListSchema.parse(await (await invoke(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0])
      .toMatchObject({ status: 'released', consumedQuantity: 1, remainingQuantity: 0 })
  })
  it('按当前可见版本更正同一部分预留，旧版本失败不改变用量和费用', async () => {
    const s = await setup(), prepared = inpatientSurgerySchema.parse(await readySurgery(s, false)), request = prepared.requests[0]!
    const reserved = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
      requestId: request.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成部分使用更正对照' })
    expect(reserved.status).toBe(200)
    const reservation = commandResponseSchema(inpatientMaterialReservationListSchema).parse(await reserved.json()).data.reservations[0]!
    const started = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: request.id, expectedRequestVersion: request.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始' })).json()).data
    const recorded = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
      requestId: request.id, expectedRequestVersion: started.requests[0]!.version, executionId: started.inProgress[0]!.id, note: '合成第一枚',
      material: { materialId: reservation.materialId, catalogVersion: reservation.catalogVersion, quantity: 1,
        reservationId: reservation.id, expectedReservationVersion: reservation.version },
    })).json()).data
    const visible = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]!
    const input = { requestId: request.id, expectedRequestVersion: recorded.requests[0]!.version,
      executionId: recorded.inProgress[0]!.id, materialUseId: recorded.inProgress[0]!.materials[0]!.id, note: '核实并更正原使用说明',
      replacement: { materialId: visible.materialId, catalogVersion: visible.catalogVersion, quantity: 1,
        reservationId: visible.id, expectedReservationVersion: visible.version },
    }
    const stale = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, {
      ...input, replacement: { ...input.replacement, expectedReservationVersion: reservation.version },
    })
    expect(stale.status).toBe(409)
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]).toEqual(visible)
    const corrected = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, input)
    expect(corrected.status).toBe(200)
    const result = inpatientSurgeryResponseSchema.parse(await corrected.json()).data.inProgress[0]!
    expect(result.materials).toHaveLength(1)
    expect(result.materials[0]!.id).not.toBe(input.materialUseId)
    expect(result.materialHistory).toHaveLength(2)
    const after = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]!
    expect(after).toMatchObject({ status: 'reserved', quantity: 2, consumedQuantity: 1, remainingQuantity: 1 })
    expect(after.version).toBeGreaterThan(visible.version)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(80000)
  })
  it('术中单笔实际使用只记本笔费用，保留部分预留且不提前完成手术', async () => {
    const s = await setup(), prepared = inpatientSurgerySchema.parse(await readySurgery(s, false)), request = prepared.requests[0]!
    const reservation = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
      requestId: request.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成术前两枚预留' })
    expect(reservation.status).toBe(200)
    const reserved = (await reservation.json()).data.reservations[0]
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成开始逐笔登记' })
    expect(started.status).toBe(200)
    const running = await started.json(), progress = running.data.inProgress[0]
    expect(running.data.executions).toEqual([])
    const recorded = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { requestId: request.id,
      expectedRequestVersion: running.data.requests[0].version, executionId: progress.id, note: '合成确认第一枚实际使用',
      material: { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1,
        reservationId: reserved.id, expectedReservationVersion: reserved.version } })
    expect(recorded.status).toBe(200)
    const result = await recorded.json()
    expect(result.data.requests[0].status).toBe('ready')
    expect(result.data.executions).toEqual([])
    expect(result.data.inProgress[0].materials).toEqual([expect.objectContaining({ quantity: 1, amountFen: 80000 })])
    const remaining = (await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]
    expect(remaining).toMatchObject({ status: 'reserved', quantity: 2, consumedQuantity: 1, remainingQuantity: 1, version: 2 })
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(charges.chargesFen).toBe(80000)
    expect(charges.charges.map(charge => charge.kind)).toEqual(['material'])
    const procedure = await (await s.request(s.doctor, `/fhir/R5/Procedure/${progress.id}`)).json()
    expect(procedure.status).toBe('in-progress')
  })

  it('耗材记录更正追加原费用冲正并保留原记录，仅当前使用参与临床事实', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), request = prepared.requests[0]
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成更正病例开始' })
    expect(started.status).toBe(200)
    const running = (await started.json()).data, executionId = running.inProgress[0].id
    const used = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { requestId: request.id,
      expectedRequestVersion: running.requests[0].version, executionId, note: '合成误录支架',
      material: { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1 } })
    expect(used.status).toBe(200)
    const previous = (await used.json()).data, originalUseId = previous.inProgress[0].materials[0].id
    const corrected = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, { requestId: request.id,
      expectedRequestVersion: previous.requests[0].version, executionId, materialUseId: originalUseId, note: '原记录错误，实际为球囊',
      replacement: { materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 1 } })
    expect(corrected.status).toBe(200)
    const result = (await corrected.json()).data.inProgress[0]
    expect(result.materials).toEqual([expect.objectContaining({ item: expect.objectContaining({ id: 'hospital-material-balloon' }), quantity: 1, amountFen: 40000 })])
    expect(result.materialHistory).toHaveLength(2)
    expect(result.materialHistory.find((item: { id: string }) => item.id === originalUseId)).toMatchObject({
      quantity: 1, amountFen: 80000, correction: { note: '原记录错误，实际为球囊', replacementMaterialUseId: result.materials[0].id } })
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(charges.charges.map(charge => charge.amountFen)).toEqual([80000, -80000, 40000])
    expect(charges.chargesFen).toBe(40000)
    expect(charges.charges[1]?.reversalOf).toBe(charges.charges[0]?.id)
  })

  it('旧完成输入只追加一次术式费并保留全部未选预留，同键重放保持兼容', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), request = prepared.requests[0]
    for (const [materialId, requestId] of [['hospital-material-stent', request.id], ['hospital-material-balloon', undefined]] as const) {
      expect((await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
        ...(requestId === undefined ? {} : { requestId }), materialId, catalogVersion: 1, quantity: 2, reason: '合成手术及后续治疗预留' })).status).toBe(200)
    }
    const reservations = (await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations
    const reserved = reservations.find((item: { materialId: string }) => item.materialId === 'hospital-material-stent')
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成完成病例开始' })
    expect(started.status).toBe(200)
    const running = (await started.json()).data, executionId = running.inProgress[0].id
    const used = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { requestId: request.id,
      expectedRequestVersion: running.requests[0].version, executionId, note: '合成实际使用一枚',
      material: { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1, reservationId: reserved.id, expectedReservationVersion: reserved.version } })
    expect(used.status).toBe(200)
    const previous = (await used.json()).data, key = randomUUID(), input = { requestId: request.id,
      expectedRequestVersion: previous.requests[0].version, executionId, note: '合成手术结束，未用绑定预留收拢' }
    const completed = await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)
    expect(completed.status).toBe(200)
    const receipt = await completed.json()
    expect(receipt.data.inProgress).toEqual([])
    expect(receipt.data.executions[0]).toMatchObject({ id: executionId, materials: [expect.objectContaining({ quantity: 1, amountFen: 80000 })] })
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/complete`, input, key)).json()).toEqual(receipt)
    expect((await s.request(s.doctor, `${s.path}/surgeries/complete`, input)).status).toBe(409)
    const fees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(fees.chargesFen).toBe(280000)
    expect(fees.charges.filter(charge => charge.kind === 'surgery')).toHaveLength(1)
    expect(fees.charges.filter(charge => charge.kind === 'material')).toHaveLength(1)
    const after = (await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations
    expect(after.find((item: { id: string }) => item.id === reserved.id)).toMatchObject({ status: 'reserved', consumedQuantity: 1, remainingQuantity: 1 })
    expect(after.find((item: { materialId: string }) => item.materialId === 'hospital-material-balloon')).toMatchObject({ status: 'reserved', consumedQuantity: 0, remainingQuantity: 2 })
    expect((await (await s.request(s.doctor, `/fhir/R5/Procedure/${executionId}`)).json()).status).toBe('completed')
  })

  it.each([1, 2])('术后沿用原预留更正 %i 件使用，保留原关闭边界与费用历史', async quantity => {
    const s = await setup(), prepared = inpatientSurgerySchema.parse(await readySurgery(s, false)), request = prepared.requests[0]!
    for (const materialId of ['hospital-material-stent', 'hospital-material-balloon']) {
      expect((await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
        requestId: request.id, materialId, catalogVersion: 1, quantity: 2, reason: '合成术后同预留更正' })).status).toBe(200)
    }
    const reserved = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
      .reservations.find(item => item.materialId === 'hospital-material-stent')!
    const otherRequest = inpatientSurgerySchema.parse(await readySurgery(s, false)).requests.find(item => item.id !== request.id)!
    const otherReserved = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
      requestId: otherRequest.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 2, reason: '合成其他手术专用预留' })
    expect(otherReserved.status).toBe(200)
    const started = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
      requestId: request.id, expectedRequestVersion: request.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成手术开始' })).json()).data
    const recorded = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, {
      requestId: request.id, expectedRequestVersion: started.requests[0]!.version, executionId: started.inProgress[0]!.id,
      material: { materialId: reserved.materialId, catalogVersion: reserved.catalogVersion, quantity,
        reservationId: reserved.id, expectedReservationVersion: reserved.version }, note: '合成原实际使用' })).json()).data
    const common = { requestId: request.id, expectedRequestVersion: recorded.requests[0]!.version, executionId: recorded.inProgress[0]!.id, note: '合成明确关闭原预留' }
    const currentReservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    const visibleReservation = currentReservations.reservations.find(item => item.id === reserved.id)!
    const draft = { finalMaterials: [{ materialId: reserved.materialId, catalogVersion: 1, quantity, materialUseIds: recorded.inProgress[0]!.materials.map(item => item.id),
      reservationId: reserved.id, expectedReservationVersion: visibleReservation.version }],
      releaseReservations: currentReservations.reservations.filter(item => item.requestId === request.id).map(item => ({ reservationId: item.id, expectedReservationVersion: item.version })) }
    const preview = await previewCompletion(s, { ...common, ...draft })
    const completed = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/complete`, {
      ...common, reconciliation: { ...draft, expectedFingerprint: preview.fingerprint } })).json()).data
    const beforeReservations = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    const visible = beforeReservations.reservations.find(item => item.id === reserved.id)!
    const unrelated = beforeReservations.reservations.find(item => item.materialId === 'hospital-material-balloon')!
    const otherReservation = beforeReservations.reservations.find(item => item.requestId === otherRequest.id)!
    expect(unrelated.status).toBe('released')
    const execution = completed.executions[0]!, original = execution.materials[0]!, key = randomUUID()
    const input = { requestId: request.id, expectedRequestVersion: completed.requests[0]!.version, executionId: execution.id,
      materialUseId: original.id, note: '合成核实原使用说明', replacement: { materialId: visible.materialId,
        catalogVersion: visible.catalogVersion, quantity, reservationId: visible.id, expectedReservationVersion: visible.version } }
    const beforeFees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    for (const replacement of [
      { ...input.replacement, expectedReservationVersion: reserved.version },
      { ...input.replacement, quantity: 3 },
      { ...input.replacement, reservationId: otherReservation.id, expectedReservationVersion: otherReservation.version },
      { materialId: unrelated.materialId, catalogVersion: unrelated.catalogVersion, quantity: 1,
        reservationId: unrelated.id, expectedReservationVersion: unrelated.version },
    ]) {
      const rejected = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, { ...input, replacement })
      expect(rejected.status).toBe(409)
      expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    }
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(beforeFees)
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(completed)
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())).toEqual(beforeReservations)
    const corrected = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, input, key)
    expect(corrected.status).toBe(200)
    const receipt = inpatientSurgeryResponseSchema.parse(await corrected.json()), result = receipt.data.executions[0]!
    expect(inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/correct-material`, input, key)).json())).toEqual(receipt)
    expect(result.materials).toHaveLength(1)
    expect(result.materials[0]).toMatchObject({ quantity, amountFen: quantity * 80000 })
    expect(result.materials[0]!.id).not.toBe(original.id)
    expect(result.materialHistory).toHaveLength(2)
    expect(result.materialHistory.find(item => item.id === result.materials[0]!.id)?.reservationId).toBe(reserved.id)
    expect(result.materialHistory.find(item => item.id === original.id)?.correction?.replacementMaterialUseId).toBe(result.materials[0]!.id)
    const after = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
    expect(after.reservations.find(item => item.id === reserved.id)).toMatchObject({ status: quantity === 2 ? 'replaced' : 'released',
      consumedQuantity: quantity, remainingQuantity: 0, version: visible.version + 2 })
    expect(after.reservations.find(item => item.id === unrelated.id)).toEqual(unrelated)
    const fees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(fees.chargesFen).toBe(200000 + quantity * 80000)
    expect(fees.charges.filter(item => item.kind === 'surgery')).toHaveLength(1)
    expect(fees.charges.filter(item => item.kind !== 'surgery').map(item => item.amountFen)).toEqual([quantity * 80000, -quantity * 80000, quantity * 80000])
    const removed = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/correct-material`, {
      requestId: request.id, expectedRequestVersion: receipt.data.requests[0]!.version, executionId: execution.id,
      materialUseId: result.materials[0]!.id, note: '合成核实该使用应取消' })).json()).data
    expect(removed.executions[0]!.materials).toEqual([])
    expect(inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json())
      .reservations.find(item => item.id === reserved.id)).toMatchObject({ status: 'released', consumedQuantity: 0, remainingQuantity: 0 })
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(200000)
  })

  it('术后纠错复用已经存在的现金冲正，原使用不能再次更正', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), request = prepared.requests[0]
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成术后更正开始' })
    const running = (await started.json()).data, executionId = running.inProgress[0].id
    const use = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { requestId: request.id, expectedRequestVersion: running.requests[0].version,
      executionId, note: '合成原材料记录', material: { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1 } })
    const used = (await use.json()).data
    const ended = await s.request(s.doctor, `${s.path}/surgeries/complete`, { requestId: request.id, expectedRequestVersion: used.requests[0].version,
      executionId, note: '合成结束后发现录入错误' })
    expect(ended.status).toBe(200)
    const completed = (await ended.json()).data, original = completed.executions[0].materialHistory[0]
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    const charge = charges.charges.find(item => item.sourceId === original.id)!
    expect((await s.request(s.cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成收费员先完成精确冲正' })).status).toBe(200)
    const input = { requestId: request.id, expectedRequestVersion: completed.requests[0].version, executionId, materialUseId: original.id,
      note: '术后核实原记录应为球囊', replacement: { materialId: 'hospital-material-balloon', catalogVersion: 1, quantity: 1 } }
    const corrected = await s.request(s.doctor, `${s.path}/surgeries/correct-material`, input)
    expect(corrected.status).toBe(200)
    const current = (await corrected.json()).data
    expect(current.executions[0].materials[0].item.id).toBe('hospital-material-balloon')
    const fees = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(fees.charges.filter(item => item.reversalOf === charge.id)).toHaveLength(1)
    expect(fees.chargesFen).toBe(240000)
    expect((await s.request(s.doctor, `${s.path}/surgeries/correct-material`, { ...input, expectedRequestVersion: current.requests[0].version })).status).toBe(409)
  })

  it('逐笔登记拒绝越岗、旧版本、缺单位和超预留，原意图重放不重复计费', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), request = prepared.requests[0]
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId: request.id, expectedRequestVersion: request.version,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成边界检查开始' })
    expect(started.status).toBe(200)
    const running = (await started.json()).data, executionId = running.inProgress[0].id
    const common = { requestId: request.id, expectedRequestVersion: running.requests[0].version, executionId, note: '合成使用边界' }
    const material = { materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1 }
    expect((await s.request(s.nurse, `${s.path}/surgeries/record-material`, { ...common, material })).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, expectedRequestVersion: request.version, material })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, material: { ...material, materialId: 'hospital-material-cv-60' } })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: request.id, expectedRequestVersion: common.expectedRequestVersion,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '拒绝已开始手术被一口气重做', materials: [] })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, { requestId: request.id, expectedRequestVersion: common.expectedRequestVersion, note: '不能取消实际已开始手术' })).status).toBe(409)
    const reserved = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: running.encounterVersion, requestId: request.id,
      materialId: material.materialId, catalogVersion: 1, quantity: 1, reason: '合成有界预留' })
    const reservation = (await reserved.json()).data.reservations[0]
    const selected = { ...material, reservationId: reservation.id, expectedReservationVersion: reservation.version }
    expect((await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, material: { ...selected, quantity: 2 } })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, material: { ...selected, expectedReservationVersion: 99 } })).status).toBe(409)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(0)
    const key = randomUUID(), first = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, material: selected }, key)
    expect(first.status).toBe(200)
    const receipt = await first.json()
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/record-material`, { ...common, material: selected }, key)).json()).toEqual(receipt)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(80000)
    const currentReservation = (await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]
    expect(currentReservation).toMatchObject({ status: 'replaced', consumedQuantity: 1, remainingQuantity: 0, version: 2 })
    for (const action of ['start', 'record-material', 'correct-material', 'complete']) {
      expect((await s.runtime.app.request(`${s.path}/surgeries/${action}`, { method: 'POST', headers: {
        cookie: s.doctor, origin: 'https://untrusted.example', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input: common }) })).status).toBe(403)
    }
  })

  it('手术目录保留231条心血管来源、表价及未知单位，不伪造可收费定义', async () => {
    const s = await setup()
    const response = await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')
    expect(response.status).toBe(200)
    const catalog = inpatientSurgeryCatalogSchema.parse(await response.json())
    expect(catalog.procedures).toHaveLength(8)
    expect(catalog.materials).toHaveLength(236)
    for (const [id, unit, priceFen] of [
      ['hospital-material-stent', '个', 80000],
      ['hospital-material-balloon', '个', 40000],
      ['hospital-material-guidewire', '根', 20000],
    ] as const) {
      const item = catalog.materials.find(item => item.id === id)
      expect(item).toMatchObject({ chargeDefinition: { unit, priceFen, synthetic: true } })
      expect(item).not.toHaveProperty('reference')
    }
    const imported = catalog.materials.filter((item: { reference?: unknown }) => item.reference !== undefined)
    expect(imported).toHaveLength(231)
    expect(imported.filter(item => 'chargeDefinition' in item)).toHaveLength(52)
    expect(imported.filter(item => 'unavailableReason' in item && item.unavailableReason === 'unit-unconfirmed')).toHaveLength(179)
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-8')).toMatchObject({
      chargeDefinition: { priceFen: 1199000, unit: '台', synthetic: true },
      reference: { category: '常规起搏类', specification: null, unit: '台', priceFen: 1199000,
        effectiveFrom: '2026-08-01', effectiveThrough: null, sourceId: 'HN-PACING-2026',
        workbookSha256: '76147edf46552c906750bb2a8697596cd47acf3450c322168f92a5b8e2348cc3', row: 8,
        original: { '中选价格（元）': '11990', '原表计价单位': '台' },
        source: { '原件 SHA-256': '20ff7320ba7c7f657a1bfa644e081e7f16c65be1885953da8c566c25dc53eee8' } },
    })
    const unknownUnit = imported.find((item: { id: string }) => item.id === 'hospital-material-cv-60')
    expect(unknownUnit).toMatchObject({ unavailableReason: 'unit-unconfirmed', reference: {
      unit: null, specification: null, priceFen: 20000, effectiveFrom: '2023-04-15', sourceId: 'TJ2023-1',
      applicability: '历史参考；原通知规定到期未接续品种继续执行，具体品种后续接续和现行状态未核实',
    } })
    expect(unknownUnit).not.toHaveProperty('chargeDefinition')
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-238')).toMatchObject({
      reference: { priceFen: 84600, effectiveThrough: '2025-12-31', sourceId: 'ZJ-STENT-2' },
    })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-19')).toMatchObject({
      chargeDefinition: { priceFen: 3200000 }, reference: { priceFen: 3200000, baseSupplyPriceFen: 2880000 },
    })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-108')).toMatchObject({ reference: { priceFen: 31740 } })
    expect(imported.find((item: { id: string }) => item.id === 'hospital-material-cv-120')).toMatchObject({ reference: { priceFen: 54720 } })
  })

  it('缺计价单位耗材拒绝实际使用且不产生Procedure或费用，明确单位按表价计费', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), row = prepared.requests[0]
    const input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      note: '按已确认表价记录合成耗材使用', materials: [{ materialId: 'hospital-material-cv-60', catalogVersion: 1, quantity: 2 }] }
    const rejected = await s.request(s.doctor, `${s.path}/surgeries/execute`, input)
    expect(rejected.status).toBe(409)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('CATALOG_CONFLICT')
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(prepared)
    expect(fhirBundleSchema.parse(await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()).total).toBe(0)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...input,
      materials: [{ materialId: 'hospital-material-cv-8', catalogVersion: 1, quantity: 2 }] })
    expect(executed.status).toBe(200)
    expect(inpatientSurgeryResponseSchema.parse(await executed.json()).data.executions[0]!.materials[0]).toMatchObject({ quantity: 2, amountFen: 2398000,
      item: { id: 'hospital-material-cv-8', chargeDefinition: { priceFen: 1199000, unit: '台' }, reference: { sourceId: 'HN-PACING-2026' } } })
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges
    expect(charges.map(item => item.amountFen)).toEqual([200000, 2398000])
  })

  it.each(['request','check-preop','confirm-consent','cancel','execute'])('手术%s拒绝缺失或恶意Origin且不写入，可信Origin正常', async action => {
    const s = await setup(), cookie = action === 'check-preop' ? s.nurse : s.doctor
    let input: Record<string,unknown> = { encounterVersion:s.admission.versionId,procedureId:'hospital-surgery-4',catalogVersion:1,
      plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成Origin门禁验证' }
    if (action === 'execute') {
      const state = await readySurgery(s, false), row = state.requests[0]
      input = { requestId:row.id,expectedRequestVersion:row.version,procedureId:'hospital-surgery-4',catalogVersion:1,materials:[],note:'合成实际实施' }
    } else if (action !== 'request') {
      const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, input)
      expect(requested.status).toBe(200)
      const row = (await requested.json()).data.requests[0]
      input = { requestId:row.id,expectedRequestVersion:row.version,note:'合成准备或取消' }
    }
    const before = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    for (const origin of [undefined,'https://untrusted.example']) {
      const rejected = await s.runtime.app.request(`${s.path}/surgeries/${action}`, { method:'POST',headers:{cookie,
        'content-type':'application/json','idempotency-key':randomUUID(),...(origin === undefined ? {} : {origin})},body:JSON.stringify({input}) })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('CSRF_REJECTED')
    }
    expect(await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).toEqual(before)
    expect((await s.request(cookie, `${s.path}/surgeries/${action}`, input)).status).toBe(200)
  })

  it('纯Agent Bearer的手术写入沿用现有无Origin例外', async () => {
    const s = await setup(), admin = await s.login('admin')
    const control = (path:string,input:unknown) => s.runtime.app.request(path,{method:'POST',headers:{cookie:admin,origin:'http://localhost',
      'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(input)})
    const clientResponse = await control('/api/agent/v1/clients',{name:'合成手术Agent'})
    expect(clientResponse.status).toBe(200)
    const client = await clientResponse.json()
    const grantResponse = await control('/api/agent/v1/grants',{agentClientId:client.agentClientId,operationIds:['inpatient.surgery.request'],
      practitionerRoleId:'practitioner-role-inpatient-doctor',ttlSeconds:3600})
    expect(grantResponse.status).toBe(200)
    const grant = await grantResponse.json()
    const requested = await s.runtime.app.request(`${s.path}/surgeries/request`, { method:'POST',headers:{authorization:`Bearer ${grant.token}`,
      'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({input:{encounterVersion:s.admission.versionId,
        procedureId:'hospital-surgery-4',catalogVersion:1,plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成Bearer手术申请'}}) })
    expect(requested.status).toBe(200)
    expect((await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests).toHaveLength(1)
  })

  it('混合时区的申请及实际执行按时间点排序，保留毫秒与稳定顺序', async () => {
    const s = await setup(), admin = await s.login('admin')
    const first = await readySurgery(s)
    const firstRequest = first.requests[0], firstExecution = first.executions[0]
    expect(first.virtualTime).toBe('2026-08-24T09:00:00+08:00')
    const requestIds = [firstRequest.id], executionIds = [firstExecution.id]
    let current = first.virtualTime
    for (const target of ['2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z']) {
      const advanced = await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: current, targetVirtualTime: target })
      expect(advanced.status).toBe(200)
      const next = await readySurgery(s)
      requestIds.push(next.requests.find((row: { id: string }) => !requestIds.includes(row.id)).id)
      executionIds.push(next.executions.find((row: { id: string }) => !executionIds.includes(row.id)).id)
      current = target
    }
    const actual = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect.soft(actual.requests.map((row: { id: string }) => row.id)).toEqual(requestIds)
    expect.soft(actual.executions.map((row: { id: string }) => row.id)).toEqual(executionIds)
    expect.soft(actual.requests.map((row: { requestedAt: string }) => row.requestedAt)).toEqual([
      '2026-08-24T09:00:00+08:00','2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z',
    ])
    expect(actual.executions.map((row: { performedAt: string }) => row.performedAt)).toEqual([
      '2026-08-24T09:00:00+08:00','2026-08-24T01:00:00.001Z','2026-08-24T01:00:00.002Z',
    ])
  })

  it('两个准备回执与公开审计关联真实申请版本，旧key重放不增加事件', async () => {
    const s = await setup()
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
      procedureId:'hospital-surgery-4',catalogVersion:1,plannedFor:'2026-08-25T01:00:00.000Z',reason:'合成准备审计验证' })
    expect(requested.status).toBe(200)
    const id = (await requested.json()).data.requests[0].id
    const auditCount = async () => (await (await s.request(s.doctor, '/fhir/R5/AuditEvent?_total=accurate&_count=100')).json()).total
    const initialCount = await auditCount()
    const replays: Array<{ cookie:string; action:string; input:{requestId:string;expectedRequestVersion:number;note:string}; key:string; response:unknown }> = []
    for (const [cookie,action,version] of [[s.nurse,'check-preop',2],[s.doctor,'confirm-consent',3]] as const) {
      const input = { requestId:id,expectedRequestVersion:version-1,note:'合成准备责任确认' }, key = randomUUID()
      const prepared = await s.request(cookie, `${s.path}/surgeries/${action}`, input, key)
      expect(prepared.status).toBe(200)
      const response = await prepared.json(), reference = `InpatientSurgeryRequest/${id}`
      const effects = [{ kind:'updated',reference,versionId:String(version) }]
      expect.soft(response.effects).toEqual(effects)
      expect(response.data.requests[0].version).toBe(version)
      const receipt = await (await s.request(cookie, `/api/his/v1/command-receipts?operationId=inpatient.surgery.${action}&idempotencyKey=${key}`)).json()
      expect.soft(receipt.response.effects).toEqual(effects)
      const audit = await (await s.request(cookie, `/fhir/R5/AuditEvent/${response.auditId}`)).json()
      expect.soft(audit.entity).toEqual([{ role:{text:'updated'},what:{identifier:{
        system:'https://caizongyuan.github.io/clinmesh/identifier/command-effect-reference',value:reference,
      }} }])
      replays.push({cookie,action,input,key,response})
    }
    const requestResource = await (await s.request(s.doctor, `/fhir/R5/ServiceRequest/${id}`)).json()
    expect(requestResource.meta.versionId).toBe('1')
    expect(await auditCount()).toBe(initialCount + 2)
    for (const replay of replays) expect(await (await s.request(replay.cookie, `${s.path}/surgeries/${replay.action}`, replay.input, replay.key)).json()).toEqual(replay.response)
    expect(await auditCount()).toBe(initialCount + 2)
  })

  it('双准备门禁，计划与实际独立，执行和费用原子且原键重放', async () => {
    const s = await setup()
    const catalogResponse = await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')
    expect(catalogResponse.status).toBe(200)
    const catalog = await catalogResponse.json()
    expect(catalog.procedures.map((item: { coding: { code: string } }) => item.coding.code)).toContain('00.6600x008')
    const planned = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '47.0100')
    const actual = catalog.procedures.find((item: { coding: { code: string } }) => item.coding.code === '51.2300')
    const material = catalog.materials.find((item: { id: string }) => item.id === 'hospital-material-suture')
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
      procedureId: planned.id, catalogVersion: planned.version, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成示教手术申请' })
    expect(requested.status).toBe(200)
    let state = (await requested.json()).data
    const id = state.requests[0].id
    const execute = () => ({ requestId: id, expectedRequestVersion: state.requests[0].version, procedureId: actual.id,
      catalogVersion: actual.version, note: '实际实施术式与计划不同', materials: [{ materialId: material.id, catalogVersion: material.version, quantity: 2 }] })
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    expect(state.executions).toEqual([])
    const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '已核对术前检查' })
    expect(checked.status).toBe(200)
    state = (await checked.json()).data
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execute())).status).toBe(409)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '确认已签署知情同意书' })
    expect(consent.status).toBe(200)
    state = (await consent.json()).data
    expect(state.requests[0].status).toBe('ready')
    const key = randomUUID(), input = execute()
    const completed = await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)
    expect(completed.status).toBe(200)
    const body = await completed.json()
    expect(await (await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).json()).toEqual(body)
    state = body.data
    expect(state.executions).toHaveLength(1)
    expect(state.requests[0].plannedProcedure.coding.code).toBe('47.0100')
    expect(state.executions[0]).toMatchObject({ requestId: id, actualProcedure: { coding: { code: '51.2300' } }, materials: [{ quantity: 2 }] })
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(1)
    const metadata = await (await s.request(s.doctor, '/fhir/R5/metadata')).json()
    const capability = metadata.rest[0].resource.find((item: { type: string }) => item.type === 'Procedure')
    expect(capability.interaction.map((item: { code: string }) => item.code)).toEqual(['read','vread','history-instance','search-type'])
    expect(capability.searchParam.map((item: { name: string }) => item.name)).toEqual(['patient','encounter'])
    expect((await s.request(s.doctor, '/fhir/R5/Procedure?status=completed')).status).toBe(400)
    expect((await (await s.request(s.doctor, `/fhir/R5/Procedure?patient=Patient/${s.patient.id}&_total=accurate`)).json()).total).toBe(1)
    expect(procedures.entry[0].resource).toMatchObject({ status: 'completed', code: { coding: [{ code: '51.2300' }] },
      subject: { reference: `Patient/${s.patient.id}` }, basedOn: [{ reference: `ServiceRequest/${id}` }] })
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    expect(ledger.charges.map((charge: { kind: string; amountFen: number }) => ({ kind: charge.kind, amountFen: charge.amountFen }))).toEqual([
      { kind: 'surgery', amountFen: actual.chargeDefinition.priceFen }, { kind: 'material', amountFen: material.chargeDefinition.priceFen * 2 }])
    expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, { requestId: id, expectedRequestVersion: state.requests[0].version, note: '不能取消已实施事实' })).status).toBe(409)
  })

  it('岗位、当前病区、目录身份、旧版本和取消竞争均受门禁', async () => {
    const s = await setup()
    const request = { encounterVersion: s.admission.versionId, procedureId: 'hospital-surgery-1', catalogVersion: 1,
      plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成申请' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/request`, request)).status).toBe(403)
    expect((await s.request(s.cashier, `${s.path}/surgeries`)).status).toBe(403)
    for (const value of [{ ...request, procedureId: '00.6600' }, { ...request, catalogVersion: 999 }, { ...request, plannedFor: '2026-01-01T00:00:00Z' }]) {
      expect((await s.request(s.doctor, `${s.path}/surgeries/request`, value)).status).toBe(409)
    }
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, request)
    expect(requested.status).toBe(200)
    const row = (await requested.json()).data.requests[0]
    const action = { requestId: row.id, expectedRequestVersion: row.version, note: '确认已签署' }
    expect((await s.request(s.nurse, `${s.path}/surgeries/confirm-consent`, action)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/surgeries/check-preop`, action)).status).toBe(403)
    const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, action)
    expect(consent.status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...action, expectedRequestVersion: 2, ...request, materials: [] })).status).toBe(400)
    const execution = { requestId: row.id, expectedRequestVersion: 2, procedureId: 'hospital-surgery-1', catalogVersion: 1, materials: [], note: '仅同意未核对不能执行' }
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, execution)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/surgeries/check-preop`, action)).status).toBe(409)
    await addSecondaryInpatientWard(s.runtime)
    const switched = await s.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.nurse, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }) })
    expect(switched.status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/surgeries`)).status).toBe(403)
    const cancelInput = { requestId: row.id, expectedRequestVersion: 2, note: '取消合成未实施计划' }
    const race = await Promise.all([s.request(s.doctor, `${s.path}/surgeries/cancel`, cancelInput), s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, cancelInput)])
    expect(race.map(result => result.status).sort()).toEqual([200,409])
    const cancelled = await race.find(result => result.status === 200)!.json()
    expect(cancelled.effects).toEqual([
      {kind:'updated',reference:`InpatientSurgeryRequest/${row.id}`,versionId:'3'},
      {kind:'updated',reference:`ServiceRequest/${row.id}`,versionId:'2'},
    ])
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, { ...execution, expectedRequestVersion: 3 })).status).toBe(409)
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(final.executions).toEqual([])
    expect(final.requests[0]).toMatchObject({ status: 'cancelled', consentConfirmation: { note: '确认已签署' }, cancellation: { note: '取消合成未实施计划' } })
  })

  it.each(['projection','billing'])('%s 写入失败回滚实施、耗材和费用，原键可安全重试', async failure => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const input = { requestId: row.id, expectedRequestVersion: row.version, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      materials: [{ materialId: 'hospital-material-suture', catalogVersion: 1, quantity: 2 }], note: '失败后不留部分事实' }
    const key = randomUUID()
    s.runtime.database.driver.exec(failure === 'projection'
      ? "CREATE TRIGGER fail_surgery BEFORE INSERT ON fhir_resource WHEN NEW.resource_type='Procedure' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;"
      : "CREATE TRIGGER fail_surgery BEFORE INSERT ON inpatient_charge WHEN NEW.kind='material' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;")
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(500)
    const failed = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    expect(failed.executions).toEqual([])
    expect(failed.requests[0].status).toBe('ready')
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual([])
    const procedures = await (await s.request(s.doctor, `/fhir/R5/Procedure?encounter=Encounter/${s.admission.id}&_total=accurate`)).json()
    expect(procedures.total).toBe(0)
    s.runtime.database.driver.exec('DROP TRIGGER fail_surgery')
    expect((await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)).status).toBe(200)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(204000)
  })

  it('已就绪申请的取消与实施竞争只提交一个结局', async () => {
    const s = await setup(), state = await readySurgery(s, false), row = state.requests[0]
    const common = { requestId: row.id, expectedRequestVersion: row.version, note: '合成取消与实施竞争' }
    const responses = await Promise.all([
      s.request(s.doctor, `${s.path}/surgeries/execute`, { ...common, procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [] }),
      s.request(s.doctor, `${s.path}/surgeries/cancel`, common),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200,409])
    const final = await (await s.request(s.doctor, `${s.path}/surgeries`)).json()
    const ledger = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    if (final.requests[0].status === 'completed') {
      expect(final.executions).toHaveLength(1)
      expect(ledger.chargesFen).toBe(200000)
    } else {
      expect(final.requests[0].status).toBe('cancelled')
      expect(final.executions).toEqual([])
      expect(ledger.charges).toEqual([])
    }
  })

  it('已有Epoch重启只补缺失目录，不覆盖已冻结的院内配置', async () => {
    const s = await setup()
    s.runtime.database.driver.exec("DELETE FROM inpatient_surgery_catalog WHERE item_id='hospital-material-catheter'")
    s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',123456) WHERE item_id='hospital-surgery-4'")
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const response = await reopened.app.request('/api/his/v1/inpatient/surgery-catalog', { headers: { cookie:s.doctor } })
    expect(response.status).toBe(200)
    const catalog = await response.json()
    expect(catalog.procedures).toHaveLength(8)
    expect(catalog.materials).toHaveLength(236)
    expect(catalog.procedures.find((item: { id: string }) => item.id === 'hospital-surgery-4').chargeDefinition.priceFen).toBe(123456)
  })

  it('心血管目录重启补缺不调旧价，旧耗材实施快照与原receipt仍可恢复，新Epoch重新安装全量', async () => {
    const s = await setup(), prepared = await readySurgery(s, false), key = randomUUID()
    const input = { requestId: prepared.requests[0].id, expectedRequestVersion: 3, procedureId: 'hospital-surgery-4', catalogVersion: 1,
      note: '保留旧格式耗材实施', materials: [{ materialId: 'hospital-material-suture', catalogVersion: 1, quantity: 2 }] }
    const completed = await s.request(s.doctor, `${s.path}/surgeries/execute`, input, key)
    expect(completed.status).toBe(200)
    const original = inpatientSurgeryResponseSchema.parse(await completed.json()), admin = await s.login('admin')
    expect(original.data.executions[0]!.materials[0]!.item).not.toHaveProperty('reference')
    s.runtime.database.driver.prepare("DELETE FROM inpatient_surgery_catalog WHERE item_id='hospital-material-cv-238'").run()
    s.runtime.database.driver.prepare("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',123) WHERE item_id='hospital-material-cv-8'").run()
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const request = (cookie: string, path: string, body?: unknown, idempotencyKey = randomUUID()) => reopened.app.request(path, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    expect(catalog.materials).toHaveLength(236)
    expect(new Set(catalog.materials.map((item: { id: string }) => item.id)).size).toBe(236)
    const retained = catalog.materials.find(item => item.id === 'hospital-material-cv-8')!
    expect('chargeDefinition' in retained && retained.chargeDefinition.priceFen).toBe(123)
    expect(inpatientSurgeryResponseSchema.parse(await (await request(s.doctor, `${s.path}/surgeries/execute`, { input }, key)).json())).toEqual(original)
    expect(inpatientSurgerySchema.parse(await (await request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(original.data)
    expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', {})).status).toBe(200)
    const resetCatalog = inpatientSurgeryCatalogSchema.parse(await (await request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    expect(resetCatalog.materials).toHaveLength(236)
    const installed = resetCatalog.materials.find(item => item.id === 'hospital-material-cv-8')!
    expect('chargeDefinition' in installed && installed.chargeDefinition.priceFen).toBe(1199000)
  })

  it('术后医嘱只接受本次已实施事实并仍须护士校对', async () => {
    const s = await setup()
    const input = { encounterVersion: s.admission.versionId, duration: 'temporary', surgeryExecutionId: 'missing',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } }
    const rejected = await s.request(s.doctor, `${s.path}/orders/issue`, input)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const state = await readySurgery(s)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.requests[0].id })).status).toBe(409)
    const createdOther = await s.runtime.app.request('/api/his/v1/patients', { method:'POST', headers:{cookie:s.registrar,origin:'http://localhost','content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({expectedVersions:{},input:{name:'合成其他住院患者',gender:'male',birthDate:'1980-01-01',identifier:`SYN-${randomUUID()}`}}) })
    expect(createdOther.status).toBe(200)
    const otherPatient = (await createdOther.json()).data.patient
    const registeredOther = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch:'epoch-1',patientId:otherPatient.id,
      patientVersion:otherPatient.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:0 })
    const other = (await registeredOther.json()).data.admission
    const receivedOther = await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${other.id}/receive`, { encounterVersion:other.versionId,bedId:'bed-general-2' })
    expect(receivedOther.status).toBe(200)
    const foreign = await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${other.id}/orders/issue`, { ...input,
      encounterVersion:(await receivedOther.json()).data.admission.versionId,surgeryExecutionId:state.executions[0].id })
    expect(foreign.status).toBe(409)
    expect((await foreign.json()).error.code).toBe('INPATIENT_SURGERY_EXECUTION_REQUIRED')
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, { ...input, surgeryExecutionId: state.executions[0].id })
    expect(issued.status).toBe(200)
    let clinical = (await issued.json()).data
    expect(clinical.orders[0]).toMatchObject({ surgeryExecutionId: state.executions[0].id, state: 'signed' })
    expect(clinical.executions).toEqual([])
    const requestResource = await (await s.request(s.doctor, `/fhir/R5/ServiceRequest/${clinical.orders[0].id}`)).json()
    expect(requestResource.supportingInfo).toEqual([{ reference: { reference: `Procedure/${state.executions[0].id}` } }])
    expect(requestResource).not.toHaveProperty('supportingInformation')
    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: clinical.orders[0].id, expectedOrderVersion: 1 })
    expect(verified.status).toBe(200)
    clinical = (await verified.json()).data
    expect(clinical.executions[0].status).toBe('pending')
    const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: s.admission.versionId, expectedRevision: 0,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary', admissionCondition: '1' }] })
    expect(diagnosis.status).toBe(200)
    const medication = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: (await diagnosis.json()).data.encounterVersion,
      duration: 'temporary', surgeryExecutionId: state.executions[0].id, selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1,
        doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(medication.status).toBe(200)
    const medicationOrder = (await medication.json()).data.orders.find((item: { kind: string }) => item.kind === 'medication')
    const medicationRequest = await (await s.request(s.doctor, `/fhir/R5/MedicationRequest/${medicationOrder.id}`)).json()
    expect(medicationRequest.supportingInformation).toEqual([{ reference: `Procedure/${state.executions[0].id}` }])
    const checkedMedication = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: medicationOrder.id, expectedOrderVersion: 1 })
    expect(checkedMedication.status).toBe(200)
    const execution = (await checkedMedication.json()).data.executions.find((item: { orderId: string }) => item.orderId === medicationOrder.id)
    expect((await s.request(s.nurse, `${s.path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status).toBe(409)
  })

})

async function readySurgery(s: Awaited<ReturnType<typeof setup>>, complete = true) {
  const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: s.admission.versionId,
    procedureId: 'hospital-surgery-4', catalogVersion: 1, plannedFor: '2026-08-25T01:00:00.000Z', reason: '合成手术测试' })
  expect(requested.status).toBe(200)
  const requestedBody = await requested.json()
  let state = requestedBody.data
  const id = requestedBody.effects[0].reference.split('/')[1]
  const checked = await s.request(s.nurse, `${s.path}/surgeries/check-preop`, { requestId: id, expectedRequestVersion: 1, note: '已核对检查' })
  expect(checked.status).toBe(200)
  const consent = await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, { requestId: id, expectedRequestVersion: 2, note: '确认同意已签署' })
  expect(consent.status).toBe(200)
  state = (await consent.json()).data
  if (complete) {
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: id, expectedRequestVersion: 3,
      procedureId: 'hospital-surgery-4', catalogVersion: 1, materials: [], note: '合成实际实施' })
    expect(executed.status).toBe(200)
    state = (await executed.json()).data
  }
  return state
}

async function surgeryWithDistinctReservationSnapshots(quantity = 5) {
  const s = await setup(), prepared = await readySurgery(s, false), request = prepared.requests[0]
  const reserved = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: prepared.encounterVersion,
    requestId: request.id, materialId: 'hospital-material-stent', catalogVersion: 1, quantity, reason: '合成分次消耗预留' })
  expect(reserved.status).toBe(200)
  let reservation = inpatientMaterialReservationListSchema.parse((await reserved.json()).data).reservations[0]!
  let state = inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/start`, {
    requestId: request.id, expectedRequestVersion: request.version, procedureId: 'hospital-surgery-4', catalogVersion: 1, note: '合成分次使用开始',
  })).json()).data
  for (const used of [1, 2]) {
    if (used === 2) s.runtime.database.driver.exec("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.display','合成支架目录新显示名') WHERE item_id='hospital-material-stent'")
    const response = await s.request(s.doctor, `${s.path}/surgeries/record-material`, { requestId: request.id,
      expectedRequestVersion: state.requests[0]!.version, executionId: state.inProgress[0]!.id, note: '合成各时点逐笔使用',
      material: { materialId: reservation.materialId, catalogVersion: 1, quantity: used,
        reservationId: reservation.id, expectedReservationVersion: reservation.version } })
    expect(response.status).toBe(200)
    state = inpatientSurgeryResponseSchema.parse(await response.json()).data
    reservation = inpatientMaterialReservationListSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]!
  }
  expect(state.inProgress[0]!.materials.map(use => use.quantity)).toEqual([1, 2])
  expect(state.inProgress[0]!.materials[0]!.item.display).not.toBe(state.inProgress[0]!.materials[1]!.item.display)
  return { s, state, reservation }
}
