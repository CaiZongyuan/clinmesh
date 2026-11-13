import { afterEach, expect, it } from 'vitest'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const prepared = await preparePciPaymentDrgFixture()
  const fixture = await createPciPaymentDrgFixture(prepared)
  cleanups.push(() => fixture.close())
  const stay = await fixture.preparePciAdmission()
  const simulate = async () => {
    const response = await fixture.request('inpatient-doctor', `${stay.path}/drg/simulation`, {})
    expect(response.status).toBe(200)
    return inpatientDrgSimulationSchema.parse(await response.json())
  }
  return { fixture, stay, simulate, modelCalls: () => prepared.modelCalls }
}

it('新完成PCI主操作尚未确认时重算术后预计，保留正式造影分组且不写主操作', async () => {
  const s = await setup()
  const angiography = await s.fixture.executeAngiography(s.stay)
  await s.fixture.confirmMainProcedure(s.stay, angiography.id)
  const execution = await s.fixture.executePci(s.stay)
  const before = await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)
  const result = await s.simulate()
  expect(result.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FM59' })
  expect(result.paymentReference).toMatchObject({ referenceFen: 400000 })
  expect(result.grouping.projected).toBeNull()
  expect(result.postoperativeEstimate).toMatchObject({ pendingExecutionIds: [execution.id],
    grouping: { status: 'grouped', drgCode: 'FM39' }, paymentReference: { drgCode: 'FM39', referenceFen: 1200000 } })
  expect(result.formal.chargesFen).toBe(394298)
  expect(await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)).toEqual(before)
  expect((await s.simulate()).postoperativeEstimate).toEqual(result.postoperativeEstimate)
  const wire = s.stay.catalog.materials.find(item => item.id === 'hospital-material-pci-guidewire')!
  if (!('chargeDefinition' in wire)) throw new Error('Synthetic guidewire must have a known charge')
  const surgery = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/supplement-material`, {
    requestId: s.stay.requestId, expectedRequestVersion: surgery.requests.find(request => request.id === s.stay.requestId)!.version,
    executionId: execution.id, note: '合成术后补记一根导丝', material: { materialId: wire.id, catalogVersion: wire.version, quantity: 1 },
    expectedCharge: { id: wire.chargeDefinition.id, priceFen: wire.chargeDefinition.priceFen, unit: wire.chargeDefinition.unit },
  })).status).toBe(200)
  const updated = await s.simulate()
  expect(updated.formal.chargesFen).toBe(414298)
  expect(updated.fingerprint).not.toBe(result.fingerprint)
  expect(updated.postoperativeEstimate).toEqual(result.postoperativeEstimate)
  await s.fixture.confirmMainProcedure(s.stay, execution.id)
  const confirmed = await s.simulate()
  expect(confirmed.fingerprint).not.toBe(result.fingerprint)
  expect(confirmed.postoperativeEstimate).toBeNull()
  expect(confirmed.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'FM39' })
  expect(confirmed.paymentReference).toMatchObject({ referenceFen: 1200000 })
  expect(s.modelCalls()).toBe(0)
})

it('多个新完成操作产生不同假想病组时保留待确认，不取最新或支付参考最高的结果', async () => {
  const s = await setup()
  const angiography = await s.fixture.executeAngiography(s.stay)
  const pci = await s.fixture.executePci(s.stay)
  const result = await s.simulate()
  expect(result.postoperativeEstimate).toEqual({ pendingExecutionIds: expect.arrayContaining([angiography.id, pci.id]),
    grouping: null, paymentReference: null })
  expect(result.postoperativeEstimate?.pendingExecutionIds).toHaveLength(2)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)).revision).toBeUndefined()
  expect(s.modelCalls()).toBe(0)
})

it('多个新完成操作的假想病组与支付参考一致时给共同预计，仍不自动确认主操作', async () => {
  const s = await setup()
  const first = await s.fixture.executePci(s.stay)
  const admission = await s.fixture.read('inpatient-doctor', s.stay.path, inpatientDetailSchema)
  expect((await s.fixture.request('inpatient-doctor', `${s.stay.path}/surgeries/request`, {
    encounterVersion: admission.admission.versionId, procedureId: s.stay.procedure.id, catalogVersion: s.stay.procedure.version,
    plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成第二台同术式PCI',
  })).status).toBe(200)
  const requested = await s.fixture.read('inpatient-doctor', `${s.stay.path}/surgeries`, inpatientSurgerySchema)
  const request = requested.requests.find(item => item.id !== s.stay.requestId)!
  const second = await s.fixture.executePci({ ...s.stay, requestId: request.id, reservations: [] })
  const result = await s.simulate()
  expect(result.postoperativeEstimate).toMatchObject({ pendingExecutionIds: expect.arrayContaining([first.id, second.id]),
    grouping: { status: 'grouped', drgCode: 'FM39' }, paymentReference: { drgCode: 'FM39', referenceFen: 1200000 } })
  expect(result.postoperativeEstimate?.pendingExecutionIds).toHaveLength(2)
  expect((await s.fixture.read('inpatient-doctor', `${s.stay.path}/record`, inpatientRecordSchema)).revision).toBeUndefined()
  expect(s.modelCalls()).toBe(0)
})
