import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema,
  inpatientPharmacyResponseSchema, inpatientPharmacySchema,
} from '@clinmesh/contracts/inpatient-clinical'
import {
  createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture, type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

describe('护士三类集中办理沿原 Command 的真实事实与恢复', () => {
  let s: PciPaymentDrgFixture
  let prepared: Awaited<ReturnType<typeof preparePciPaymentDrgFixture>>
  let stay: Awaited<ReturnType<PciPaymentDrgFixture['preparePciAdmission']>>
  beforeAll(async () => { prepared = await preparePciPaymentDrgFixture() })
  beforeAll(async () => { s = await createPciPaymentDrgFixture(prepared) })
  beforeAll(async () => {
    stay = await s.preparePciAdmission([])
    let clinical = await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const catalog = await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
    for (const [suffix, doseText, doseQuantity, frequencyCode] of [
      ['aspirin', '100 mg', 1, 'QD'], ['clopidogrel', '75 mg', 1, 'QD'],
      ['heparin', '1 mL', 1, 'PRN'], ['iohexol', '50 mL', 50, 'PRN'],
    ] as const) {
      clinical = (await parsePciResponse(inpatientFullClinicalResponseSchema, await s.request('inpatient-doctor', `${stay.path}/orders/issue`, {
        encounterVersion: clinical.encounterVersion, duration: 'temporary', selection: {
          kind: 'medication', catalogItemId: `medication-pci-${suffix}`,
          catalogVersion: catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!.version,
          doseText, doseQuantity, frequencyCode,
        },
      }))).data
    }
    for (let index = 0; index < 2; index += 1) {
      clinical = (await parsePciResponse(inpatientFullClinicalResponseSchema, await s.request('inpatient-doctor', `${stay.path}/orders/issue`, {
        encounterVersion: clinical.encounterVersion, duration: 'temporary',
        selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
      }))).data
    }
    for (const order of clinical.orders) {
      clinical = (await parsePciResponse(inpatientFullClinicalResponseSchema, await s.request('ward-nurse', `${stay.path}/orders/verify`, {
        orderId: order.id, expectedOrderVersion: order.version,
      }))).data
    }
    for (const execution of clinical.executions) {
      const order = clinical.orders.find(item => item.id === execution.orderId)!
      if (order.kind !== 'medication') continue
      const pharmacy = await s.read('pharmacist', `${stay.path}/pharmacy`, inpatientPharmacySchema)
      const lot = pharmacy.medications.find(item => item.id === order.catalogItemId)!.lots[0]!
      await parsePciResponse(inpatientPharmacyResponseSchema, await s.request('pharmacist', `${stay.path}/executions/dispense`, {
        executionId: execution.id, expectedExecutionVersion: execution.version,
        lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }],
      }))
    }
  })
  afterAll(async () => { await s?.close() })

  it('各两项给药、教育和 PRN 独立生效，拒绝不生成事实，重启只恢复原六次尝试', async () => {
    const before = await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    const catalogBefore = await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
    expect(before.orders).toHaveLength(6)
    expect(before.executions.filter(item => item.status === 'dispensed')).toHaveLength(2)
    expect(before.executions.filter(item => item.status === 'pending')).toHaveLength(2)
    expect(before.chargesFen).toBe(130)
    expect(before.charges).toHaveLength(2)

    const attempts: Array<{ operation: string; action: string; key: ReturnType<typeof randomUUID>; input: unknown;
      response: z.infer<typeof inpatientFullClinicalResponseSchema> }> = []
    const send = async (action: string, input: unknown) => {
      const key = randomUUID()
      const response = await parsePciResponse(inpatientFullClinicalResponseSchema,
        await s.request('ward-nurse', `${stay.path}/executions/${action}`, input, key))
      attempts.push({ operation: `inpatient.execution.${action}`, action, key, input, response })
      return response
    }
    const dose = before.executions.filter(item => item.status === 'dispensed')
    expect((await s.request('ward-nurse', `${stay.path}/executions/administer`, {
      executionId: dose[0]!.id, expectedExecutionVersion: dose[0]!.version + 1,
    })).status).toBe(409)
    expect((await s.request('inpatient-doctor', `${stay.path}/executions/administer`, {
      executionId: dose[0]!.id, expectedExecutionVersion: dose[0]!.version,
    })).status).toBe(403)
    expect(await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)).toEqual(before)
    for (const execution of dose) {
      const result = await send('administer', { executionId: execution.id, expectedExecutionVersion: execution.version })
      const completed = result.data.executions.find(item => item.id === execution.id)!
      expect(completed).toMatchObject({ status: 'completed', version: execution.version + 1 })
      expect(completed.administrationId).toBeTruthy()
      expect(result.effects.filter(effect => effect.kind === 'created' && effect.reference.startsWith('MedicationAdministration/')))
        .toEqual([{ kind: 'created', reference: `MedicationAdministration/${completed.administrationId}`, versionId: '1' }])
      expect(result.data.charges).toEqual(before.charges)
      const administration = await s.read('inpatient-doctor', `/fhir/R5/MedicationAdministration/${completed.administrationId}`, fhirResourceSchema)
      expect(administration).toMatchObject({ status: 'completed', encounter: { reference: `Encounter/${stay.admissionId}` } })
    }
    for (const execution of before.executions.filter(item => item.status === 'pending')) {
      const result = await send('complete', { executionId: execution.id, expectedExecutionVersion: execution.version })
      expect(result.data.executions.find(item => item.id === execution.id)).toMatchObject({ status: 'completed', version: execution.version + 1 })
      expect(result.data.charges.filter(item => item.sourceId === execution.id)).toEqual([
        expect.objectContaining({ kind: 'service', amountFen: 3000 }),
      ])
    }
    const actual = await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    expect(actual.chargesFen).toBe(6130)
    expect(actual.charges).toHaveLength(4)
    const prnOrders = before.orders.filter(item => item.frequencyCode === 'PRN')
    const reasons = ['合成患者本次术中抗凝需要', '合成患者本次造影需要']
    for (const [index, order] of prnOrders.entries()) {
      const result = await send('request-prn', { orderId: order.id, expectedOrderVersion: order.version, reason: reasons[index]! })
      const created = result.effects.filter(effect => effect.kind === 'created' && effect.reference.startsWith('Task/'))
      expect(created).toHaveLength(1)
      const taskId = created[0]!.reference.slice('Task/'.length)
      expect(result.data.executions.find(item => item.id === taskId)).toMatchObject({ orderId: order.id, status: 'pending', reason: reasons[index] })
      expect(result.data.orders.find(item => item.id === order.id)).toMatchObject({ state: 'verified', version: order.version })
      expect(result.data.charges).toEqual(actual.charges)
      expect(result.effects.some(effect => effect.reference.startsWith('MedicationAdministration/'))).toBe(false)
      expect(await s.read('inpatient-doctor', `/fhir/R5/Task/${taskId}`, fhirResourceSchema))
        .toMatchObject({ status: 'ready', focus: { reference: `MedicationRequest/${order.id}` } })
      expect((await s.request('ward-nurse', `${stay.path}/executions/request-prn`, {
        orderId: order.id, expectedOrderVersion: order.version, reason: '不能重复发起临时 PRN',
      })).status).toBe(409)
    }
    const final = await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)
    expect(final.executions.filter(item => item.status === 'completed')).toHaveLength(4)
    expect(final.executions.filter(item => item.status === 'pending')).toHaveLength(2)
    expect(final.dispenses).toEqual(before.dispenses)
    expect(final.charges).toEqual(actual.charges)
    expect(await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)).toEqual(catalogBefore)

    await s.restart()
    for (const attempt of attempts) {
      const receipt = await s.read('ward-nurse', `/api/his/v1/command-receipts?operationId=${attempt.operation}&idempotencyKey=${attempt.key}`,
        z.object({ response: inpatientFullClinicalResponseSchema }))
      expect(receipt.response).toEqual(attempt.response)
      expect(await parsePciResponse(inpatientFullClinicalResponseSchema,
        await s.request('ward-nurse', `${stay.path}/executions/${attempt.action}`, attempt.input, attempt.key))).toEqual(attempt.response)
    }
    expect(await s.read('ward-nurse', `${stay.path}/clinical`, inpatientFullClinicalSchema)).toEqual(final)
    expect(await s.read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)).toEqual(catalogBefore)
    const administrations = await s.read('inpatient-doctor', `/fhir/R5/MedicationAdministration?encounter=Encounter/${stay.admissionId}&_total=accurate`, fhirBundleSchema)
    expect(administrations.total).toBe(2)
    expect(new Set(administrations.entry?.map(item => item.resource?.id)).size).toBe(2)
    expect(prepared.modelCalls).toBe(0)
  })
})
