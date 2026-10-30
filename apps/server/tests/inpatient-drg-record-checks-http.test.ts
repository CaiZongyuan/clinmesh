import { afterEach, describe, expect, it } from 'vitest'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema, inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { syntheticDrgSource, syntheticDrgIdentity } from './fixtures/drg-synthetic-program.ts'
import { confirmPrimary, setupDrgReview } from './fixtures/inpatient-drg-review.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('独立分组记录核对公共 HTTP', () => {
  it('无需跟进和手术即可读取缺项；确认诊断后明确无本范围差异且指纹稳定', async () => {
    const s = await setupDrgReview(cleanups)
    const read = async () => {
      const response = await s.request(s.doctor, `${s.path}/drg/record-checks`)
      expect(response.status).toBe(200)
      return inpatientDrgRecordChecksSchema.parse(await response.json())
    }
    const missing = await read()
    expect(missing.status).toBe('incomplete')
    expect(missing.issues).toContainEqual(expect.objectContaining({ kind: 'grouping-incomplete' }))
    expect(missing.paymentStatus).toBe('grouping-incomplete')
    expect((await confirmPrimary(s)).status).toBe(200)
    const grouped = await read()
    expect(grouped.status).toBe('complete')
    expect(grouped.issues).toEqual([])
    expect(grouped.simulation?.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    expect(grouped.paymentStatus).toBe('available')
    expect(grouped.fingerprint).not.toBe(missing.fingerprint)
    expect((await read()).fingerprint).toBe(grouped.fingerprint)
    const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect((await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion,
      expectedRevision: clinical.diagnosis.revision, entries: [{ catalogItemId: 'diagnosis-hyperthyroidism', role: 'primary', admissionCondition: '1' }] })).status).toBe(200)
    const incompatible = await read()
    expect(incompatible.simulation?.grouping.formal.status).toBe('ungroupable')
    expect(incompatible.issues).toContainEqual(expect.objectContaining({ kind: 'grouping-incomplete', explanation: expect.any(String) }))
    expect(incompatible.sources).toContainEqual(expect.objectContaining({ target: 'orders', display: expect.stringContaining('E05.90') }))
    const followup = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json())
    expect(followup.task).toBeNull()
  })

  it('分组成功但无该病组支付参数时单独说明金额暂不可估，规则缺失也不冒充无差异', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const groups = [
      { level: 'MDC', code: 'MDCR', name: '合成循环组', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA16', name: '合成未配置支付组', parentCode: 'RA1' },
    ]
    const jsText = syntheticDrgSource('I10.x09', 'RA16'), tables = { CC: {}, MCC: {}, CCE: {} }
    const directory = join(s.directory, 'missing-payment-rules')
    await mkdir(directory)
    const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: tables,
      input: syntheticDrgIdentity(jsText, groups, tables), releaseId: 'synthetic-missing-payment', sourceVersion: 'synthetic-missing-payment-1' })
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content)
    await s.restart({ drgRulesDirectory: directory })
    const grouped = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(grouped.simulation?.grouping.formal.drgCode).toBe('RA16')
    expect(grouped.paymentStatus).toBe('missing')
    expect(grouped.paymentMessage).toBe('分组成功，金额暂不可估：缺少适用的医院支付参数。')
    expect(grouped.issues).toEqual([])
    delete s.options.drgRulesDirectory
    await s.restart()
    const unavailable = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(unavailable.status).toBe('incomplete')
    expect(unavailable.simulation).toBeNull()
    expect(unavailable.issues[0]?.kind).toBe('grouping-incomplete')
    expect(unavailable.missing.join()).toContain('分组规则数据包未配置')
  })

  it('实际 PCI、首页主操作与计划分组分别展示原依据，读取不修改正式事实或费用', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    const pci = catalog.procedures.find(item => item.coding.code === '00.6600')!
    const current = inpatientDetailSchema.parse(await (await s.request(s.doctor, s.path)).json()).admission
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: current.versionId,
      procedureId: pci.id, catalogVersion: pci.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '独立核对合成 PCI 计划' })
    expect(requested.status).toBe(200)
    let surgery = inpatientSurgeryResponseSchema.parse(await requested.json()).data
    const plan = surgery.requests[0]!
    const planned = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(planned.issues.map(item => item.kind)).toEqual(['grouping-difference'])
    expect(planned.simulation?.grouping.formal.drgCode).toBe('RA15')
    expect(planned.simulation?.grouping.projected?.drgCode).toBe('RA25')
    expect(planned.sources).toContainEqual(expect.objectContaining({ target: 'surgery', display: expect.stringContaining('计划操作') }))
    for (const [actor, action] of [[s.nurse, 'check-preop'], [s.doctor, 'confirm-consent']] as const) {
      const response = await s.request(actor, `${s.path}/surgeries/${action}`, { requestId: plan.id,
        expectedRequestVersion: surgery.requests[0]!.version, note: '合成核对准备' })
      expect(response.status).toBe(200)
      surgery = inpatientSurgeryResponseSchema.parse(await response.json()).data
    }
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: plan.id,
      expectedRequestVersion: surgery.requests[0]!.version, procedureId: pci.id, catalogVersion: pci.version, materials: [], note: '合成 PCI 实际完成' })
    expect(executed.status).toBe(200)
    const before = {
      record: inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json()),
      clinical: inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json()),
      surgery: inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json()),
      charges: inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()),
    }
    const actual = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(actual.issues).toContainEqual(expect.objectContaining({ kind: 'primary-procedure-difference', evidence: expect.arrayContaining([`Procedure/${before.surgery.executions[0]!.id}`]) }))
    expect(actual.fingerprint).not.toBe(planned.fingerprint)
    expect(inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())).toEqual(before.record)
    expect(inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())).toEqual(before.clinical)
    expect(inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())).toEqual(before.surgery)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())).toEqual(before.charges)
    expect(inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task).toBeNull()
    expect((await s.request(s.cashier, `${s.path}/drg/record-checks`)).status).toBe(403)
    expect((await s.request(s.registrar, `${s.path}/drg/record-checks`)).status).toBe(403)
    const records = await s.login('medical-records')
    for (const [operation, suffix] of [['inpatient.drg.record-checks.read', ''], ['inpatient.drg.record-checks.explanation.read', '/explanation']] as const) {
      expect(getHisOperation(operation).roles).toEqual(['inpatient-doctor', 'medical-records'])
      expect((await s.request(s.nurse, `${s.path}/drg/record-checks${suffix}`)).status).toBe(403)
      expect((await s.request(records, `${s.path}/drg/record-checks${suffix}`)).status).toBe(200)
    }
  })

  it('原计划造影改为术中 PCI 时，推演与来源同时反映术中实际操作且不改正式分组', async () => {
    const s = await setupDrgReview(cleanups)
    expect((await confirmPrimary(s)).status).toBe(200)
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    const angiography = catalog.procedures.find(item => item.coding.code === '88.5500')!
    const pci = catalog.procedures.find(item => item.coding.code === '00.6600')!
    const admission = inpatientDetailSchema.parse(await (await s.request(s.doctor, s.path)).json()).admission
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: admission.versionId,
      procedureId: angiography.id, catalogVersion: angiography.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成原计划造影' })
    expect(requested.status).toBe(200)
    let surgery = inpatientSurgeryResponseSchema.parse(await requested.json()).data
    const requestId = surgery.requests[0]!.id
    for (const [actor, action] of [[s.nurse, 'check-preop'], [s.doctor, 'confirm-consent']] as const) {
      const response = await s.request(actor, `${s.path}/surgeries/${action}`, { requestId,
        expectedRequestVersion: surgery.requests[0]!.version, note: '合成术前核实' })
      expect(response.status).toBe(200)
      surgery = inpatientSurgeryResponseSchema.parse(await response.json()).data
    }
    const before = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(before.simulation?.grouping.projected?.status).toBe('ungroupable')
    const started = await s.request(s.doctor, `${s.path}/surgeries/start`, { requestId,
      expectedRequestVersion: surgery.requests[0]!.version, procedureId: pci.id, catalogVersion: pci.version, note: '合成术中改为 PCI' })
    expect(started.status).toBe(200)
    surgery = inpatientSurgeryResponseSchema.parse(await started.json()).data
    const current = inpatientDrgRecordChecksSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json())
    expect(current.simulation?.grouping.formal.drgCode).toBe('RA15')
    expect(current.simulation?.grouping.projected?.drgCode).toBe('RA25')
    const reference = `Procedure/${surgery.inProgress[0]!.id}`
    expect(current.sources).toContainEqual(expect.objectContaining({ reference, target: 'surgery', display: expect.stringContaining('00.6600') }))
    expect(current.sources).toContainEqual(expect.objectContaining({ reference: expect.stringContaining(`ServiceRequest/${requestId}/`), display: expect.stringContaining('88.5500') }))
    expect(current.issues).toContainEqual(expect.objectContaining({ kind: 'grouping-difference', evidence: expect.arrayContaining([reference]) }))
    expect(current.issues.some(item => item.kind === 'primary-procedure-difference')).toBe(false)
    expect(current.fingerprint).not.toBe(before.fingerprint)
  })
})
