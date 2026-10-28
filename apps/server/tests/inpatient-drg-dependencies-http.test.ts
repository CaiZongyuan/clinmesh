import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { inpatientChargesSchema, inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'
import { createPciPaymentDrgFixture, preparePciPaymentDrgFixture } from './fixtures/pci-payment-drg.ts'
import { confirmPrimary, setupDrgReview } from './fixtures/inpatient-drg-review.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Scope = Pick<Awaited<ReturnType<typeof setupDrgReview>>, 'doctor' | 'cashier' | 'path'> & {
  request: (actor: string, path: string, input?: unknown) => Response | Promise<Response>
}
const clinical = async (s: Scope) => inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
const charges = async (s: Scope) => inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())

async function review(s: Scope) {
  const catalog = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
  const service = catalog.services[0]!
  const selection = { kind: 'service' as const, serviceId: service.id, serviceVersion: service.version, quantity: 1 }
  const response = await s.request(s.doctor, `${s.path}/drg/simulation`, {
    medications: [], services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 1 }],
  })
  expect(response.status).toBe(200)
  const simulation = inpatientDrgSimulationSchema.parse(await response.json())
  // No cost-input owner exists yet. This verifies the missing-data contract, not cost-change invalidation.
  expect(simulation.incompleteness.costMissing).toBe(true)
  return { selection, simulation }
}

/** Supply the current Encounter version so this proves DRG revalidation, rather than an earlier version guard. */
async function rejectOldReviewAndRecover(s: Scope, old: Awaited<ReturnType<typeof review>>) {
  const before = await clinical(s), beforeCharges = await charges(s)
  const response = await s.request(s.doctor, `${s.path}/orders/issue`, {
    encounterVersion: before.encounterVersion, duration: 'temporary', selection: old.selection,
    expectedDrgFingerprint: old.simulation.fingerprint,
  })
  expect(response.status).toBe(409)
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INPATIENT_DRG_EVALUATION_STALE')
  expect((await clinical(s)).orders).toEqual(before.orders)
  expect(await charges(s)).toEqual(beforeCharges)

  const fresh = await review(s)
  expect(fresh.simulation.fingerprint).not.toBe(old.simulation.fingerprint)
  const issued = await s.request(s.doctor, `${s.path}/orders/issue`, {
    encounterVersion: (await clinical(s)).encounterVersion, duration: 'temporary', selection: fresh.selection,
    expectedDrgFingerprint: fresh.simulation.fingerprint,
  })
  expect(issued.status).toBe(200)
  expect((await clinical(s)).orders).toHaveLength(before.orders.length + 1)
  expect(await charges(s)).toEqual(beforeCharges)
  return fresh.simulation
}

describe('DRG 审阅的依赖变化公共 HTTP 验证', () => {
  it('正式诊断新增合并症后，最新 Encounter 版本也不能提交旧审阅，重新审阅可恢复', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const old = await review(s)
    const before = await clinical(s)
    const confirmed = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
      encounterVersion: before.encounterVersion, expectedRevision: before.diagnosis.revision,
      entries: [
        { catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1' },
        { catalogItemId: 'diagnosis-hyperthyroidism', role: 'secondary', admissionCondition: '1', note: '合成新增合并症' },
      ],
    })
    expect(confirmed.status).toBe(200)
    const changed = await clinical(s)
    expect(changed.diagnosis.revision).toBe(before.diagnosis.revision + 1)
    expect(changed.diagnosis.entries.map(entry => entry.coding.code)).toContain('E05.90')
    await rejectOldReviewAndRecover(s, old)
  })

  it('护士在医生审阅后完成既有执行单并记费，旧审阅被拒且不重复医嘱或费用', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const selected = await review(s)
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: (await clinical(s)).encounterVersion, duration: 'temporary', selection: selected.selection,
    })).status).toBe(200)
    const signed = (await clinical(s)).orders[0]!
    expect((await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: signed.id, expectedOrderVersion: signed.version })).status).toBe(200)
    const pending = (await clinical(s)).executions[0]!
    const old = await review(s)
    expect(old.simulation.formal.chargesFen).toBe(0)
    expect(old.simulation.committed.items).toHaveLength(1)
    expect((await s.request(s.nurse, `${s.path}/executions/complete`, {
      executionId: pending.id, expectedExecutionVersion: pending.version,
    })).status).toBe(200)
    expect((await clinical(s)).executions).toContainEqual(expect.objectContaining({ id: pending.id, status: 'completed' }))
    const after = await charges(s)
    expect(after.charges).toHaveLength(1)
    expect(after.charges[0]).toMatchObject({ kind: 'service', sourceId: pending.id, amountFen: old.simulation.committed.items[0]!.estimatedFen })
    const fresh = await rejectOldReviewAndRecover(s, old)
    expect(fresh.formal.chargesFen).toBe(after.chargesFen)
    expect(fresh.committed.items).toEqual([])
  })

  it.each(['药品', '服务', '手术', '耗材'] as const)('%s价目更新后，旧审阅在最新就诊版本下仍被拒绝，刷新目录并审阅后可签发', async kind => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const old = await review(s)
    // There is no public price-maintenance Command. Change only this test's catalog input,
    // then observe the price/version and all clinical effects through public HTTP.
    if (kind === '药品') {
      const item = s.clinicalCatalog.medications[0]!
      s.runtime.database.driver.prepare('UPDATE outpatient_catalog SET price_fen=?,version=version+1 WHERE item_id=?')
        .run(item.priceFen + 100, item.id)
      const changed = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
      expect(changed.medications.find(value => value.id === item.id)).toMatchObject({ priceFen: item.priceFen + 100, version: item.version + 1 })
    } else if (kind === '服务') {
      const item = s.clinicalCatalog.services[0]!
      s.runtime.database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_set(config_json,'$.chargeDefinition.priceFen',?),version=version+1 WHERE service_id=?")
        .run(item.priceFen + 100, item.id)
      const changed = inpatientFullCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
      expect(changed.services.find(value => value.id === item.id)).toMatchObject({ priceFen: item.priceFen + 100, version: item.version + 1 })
    } else {
      const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
      const item = kind === '手术' ? catalog.procedures[0]! : catalog.materials.find(value => 'chargeDefinition' in value)!
      if (!('chargeDefinition' in item)) throw new Error('Expected a priced synthetic catalog item')
      s.runtime.database.driver.prepare("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.version',?,'$.chargeDefinition.priceFen',?) WHERE item_id=?")
        .run(item.version + 1, item.chargeDefinition.priceFen + 100, item.id)
      const changed = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
      expect([...changed.procedures, ...changed.materials].find(value => value.id === item.id)).toMatchObject({
        version: item.version + 1, chargeDefinition: { priceFen: item.chargeDefinition.priceFen + 100 },
      })
    }
    await rejectOldReviewAndRecover(s, old)
  })

  it('实际重启加载新的有效合成规则包后，旧审阅被拒并可按新分组重新审阅', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const old = await review(s)
    expect(old.simulation.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    const nextDirectory = join(s.directory, 'next-rules')
    await mkdir(nextDirectory)
    const groups = [
      { level: 'MDC', code: 'MDCR', name: '合成循环系统疾病', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA16', name: '合成更换规则后的病组', parentCode: 'RA1' },
    ]
    const jsText = syntheticDrgSource('I10.x09', 'RA16'), complicationTables = { CC: {}, MCC: {}, CCE: {} }
    const files = prepareDrgRulesPackage({ groups, jsText, complicationTables,
      input: syntheticDrgIdentity(jsText, groups, complicationTables),
      releaseId: 'chs-drg-review-next', sourceVersion: 'synthetic-reviewed-rules-2',
    })
    for (const [name, content] of Object.entries(files)) await writeFile(join(nextDirectory, name), content)
    await s.restart({ drgRulesDirectory: nextDirectory })
    const fresh = await rejectOldReviewAndRecover(s, old)
    expect(fresh.rulesVersion).toBe('synthetic-reviewed-rules-2')
    expect(fresh.rulesVersion).not.toBe(old.simulation.rulesVersion)
    expect(fresh.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA16' })
  })

  it('检验科异步完成本次住院检查并记费后，费用进入当前评估并阻断旧审阅', async () => {
    const prepared = await preparePciPaymentDrgFixture()
    cleanups.push(async () => { await rm(prepared.directory, { recursive: true, force: true }) })
    const pci = await createPciPaymentDrgFixture(prepared)
    cleanups.push(async () => { await pci.runtime.close() })
    const stay = await pci.preparePciAdmission()
    const s: Scope = { path: stay.path, request: pci.request, doctor: 'inpatient-doctor', cashier: 'cashier' }
    const catalog = inpatientInvestigationCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')).json())
    const item = catalog.items.find(value => value.id.startsWith('hospital-lab-pci-'))!
    expect(item).toMatchObject({ available: true, priceFen: 1000 })
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, {
      encounterVersion: (await clinical(s)).encounterVersion, catalogVersion: item.version,
      selection: { kind: 'laboratory', catalogItemId: item.id, indicationCode: 'clinical-assessment' },
    })
    expect(issued.status).toBe(200)
    const investigation = inpatientInvestigationResponseSchema.parse(await issued.json()).data.laboratoryRequests[0]!
    expect((await s.request('ward-nurse', `${s.path}/investigations/send`, {
      requestId: investigation.id, expectedRequestVersion: investigation.version,
      serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion,
    })).status).toBe(200)
    const old = await review(s)
    expect(old.simulation.formal.chargesFen).toBe(0)
    // Execute only the bounded queued synthetic LIS work; the fixture forbids model access.
    for (let index = 0; index < 12; index += 1) if (await pci.runtime.dispatcher.dispatchOnce() === undefined) break
    const reported = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())
    expect(reported.laboratoryRequests.find(value => value.id === investigation.id)?.report).toBeDefined()
    expect((await charges(s)).charges).toEqual([expect.objectContaining({ kind: 'laboratory', sourceId: investigation.id, amountFen: 1000 })])
    const fresh = await rejectOldReviewAndRecover(s, old)
    expect(fresh.formal.chargesFen).toBe(1000)
    expect(fresh.formal.items).toContainEqual(expect.objectContaining({ kind: 'laboratory', estimatedFen: 1000 }))
    expect(prepared.modelCalls).toBe(0)
  })
})
