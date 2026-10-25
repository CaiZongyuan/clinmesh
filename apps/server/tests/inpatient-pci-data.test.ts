import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientPharmacyResponseSchema, inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientCatalogSearchSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import { InpatientPciData } from '../src/application/inpatient-pci-data.ts'
import { InpatientService } from '../src/application/inpatient-service.ts'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { pciDataPackage } from '../src/application/scenario-data/pci-data.ts'
import { AuditQuery } from '../src/application/audit-query.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup(withReference = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-data-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  if (withReference) {
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ ...pciDataPackage.diagnosis, domain: 'diagnosis', status: 'active' }],
      medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory, 'reference.json'), artifact)
    await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-pci-clinical', schemaVersion: '1', createdAt: '2026-10-25T00:00:00.000Z',
      sources: [{ sourceId: 'synthetic-pci-test', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
        retrievedAt: '2026-10-25T00:00:00.000Z', sourceUrl: 'https://example.test/pci-test', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  }
  const options = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    ...(withReference ? { referenceDatabasePath, activeReferenceReleaseId: 'synthetic-pci-clinical' } : {}) }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  const owner = new InpatientService(runtime.database, runtime.fhir, new CommandExecutor(runtime.database, runtime.fhir), runtime.referenceData, runtime.workflow)
  const data = new InpatientPciData(owner)
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    const { locationId, organizationId, practitionerId, practitionerRoleId, ...binding } = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie } })).json()).actor
    const context: ActorContext = { ...binding,
      ...(locationId === undefined ? {} : { locationId }), ...(organizationId === undefined ? {} : { organizationId }),
      ...(practitionerId === undefined ? {} : { practitionerId }), ...(practitionerRoleId === undefined ? {} : { practitionerRoleId }) }
    return { cookie, context }
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  return { runtime, owner, data, login, request, options }
}

describe('固定 PCI 数据公开 Command 与目录回读', () => {
  it('单位为空的既有产品首次准备即补齐单位、含量和基础批次，新键不再补写', async () => {
    const s = await setup(), admin = await s.login('admin'), doctor = await s.login('inpatient-doctor')
    const definition = pciDataPackage.medications.find(item => item.id === 'medication-pci-aspirin')!
    const { workspaceId, epoch } = admin.context
    s.runtime.database.driver.prepare(`INSERT INTO outpatient_catalog
      (workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
      VALUES(?,?,?,'medication',?,?,?,?,1,1,?)`).run(workspaceId, epoch, 'existing-null-unit-aspirin', definition.product.code,
        '合成待补单位阿司匹林', 'synthetic-null-unit-aspirin', 321,
        JSON.stringify({ product: definition.product, availableScopes: ['outpatient'], unit: null }))
    const first = s.data.prepare(admin.context, { expectedEpoch: epoch }, 'pci-null-unit-first')
    const installed = first.data.installed.medications.find(item => item.definitionId === definition.id)!
    expect(installed).toMatchObject({ catalogItemId: 'existing-null-unit-aspirin', unit: '片', priceFen: 321,
      lots: [{ quantityOnHand: 1000 }] })
    expect(installed.conflicts).toEqual([])
    const catalog = inpatientFullCatalogSchema.parse(await (await s.request(doctor.cookie, '/api/his/v1/inpatient/clinical-catalog')).json())
    expect(catalog.medications.find(item => item.id === 'existing-null-unit-aspirin')).toMatchObject({ doseBasis: { amount: 100, unit: 'mg' } })
    const second = s.data.prepare(admin.context, { expectedEpoch: epoch }, 'pci-null-unit-second')
    expect(second.effects).toEqual([])
    expect(second.data.installed).toEqual(first.data.installed)
  })

  it('已有产品按盒计量时不套入按片的剂量和上限，目录保持待补', async () => {
    const s = await setup(), admin = await s.login('admin'), doctor = await s.login('inpatient-doctor')
    const definition = pciDataPackage.medications.find(item => item.id === 'medication-pci-aspirin')!
    const { workspaceId, epoch } = admin.context
    s.runtime.database.driver.prepare(`INSERT INTO outpatient_catalog
      (workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
      VALUES(?,?,?,'medication',?,?,?,?,1,1,?)`).run(workspaceId, epoch, 'existing-box-aspirin', definition.product.code,
        '合成既有盒装阿司匹林', 'synthetic-box-aspirin', 321,
        JSON.stringify({ product: definition.product, availableScopes: ['outpatient'], unit: '盒' }))
    s.runtime.database.driver.prepare(`INSERT INTO inventory_lot
      (workspace_id,epoch,lot_id,medication_id,location_id,lot_number,expires_on,quantity_on_hand,version)
      VALUES(?,?,?,'existing-box-aspirin','location-pharmacist','SYN-BOX','2028-12-31',10,1)`)
      .run(workspaceId, epoch, 'lot-existing-box-aspirin')
    s.data.prepare(admin.context, { expectedEpoch: epoch }, 'pci-existing-box-prepare')
    const installed = s.data.read(admin.context).installed.medications.find(item => item.definitionId === definition.id)!
    expect(installed).toMatchObject({ catalogItemId: 'existing-box-aspirin', unit: '盒', priceFen: 321, lots: [{ quantityOnHand: 10 }] })
    expect(installed.conflicts).toContain('unit-mismatch')
    const response = await s.request(doctor.cookie, `/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=${encodeURIComponent('合成既有盒装阿司匹林')}`)
    expect(response.status).toBe(200)
    const candidate = inpatientCatalogSearchSchema.parse(await response.json()).items[0]!
    expect(candidate).toMatchObject({ status: 'incomplete', missingFields: expect.arrayContaining(['dose-limit']) })
    expect(candidate.catalogItemId).toBeUndefined()
  })

  it('准备后药品能从现有住院目录读到，底稿不创建任何就诊或费用', async () => {
    const s = await setup(), admin = await s.login('admin'), doctor = await s.login('inpatient-doctor')
    const unchangedResources = ['Patient', 'Encounter', 'ChargeItem']
    async function businessResources() {
      const result: Record<string, string[]> = {}
      for (const type of unchangedResources) {
        const response = await s.request(admin.cookie, `/fhir/R5/${type}?_count=100`)
        expect(response.status).toBe(200)
        result[type] = (fhirBundleSchema.parse(await response.json()).entry ?? []).map(entry => entry.resource?.id ?? '').sort()
      }
      return result
    }
    const beforeBusiness = await businessResources()
    const admissionsBefore = await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: doctor.cookie } })).json()
    const prepared = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-data-first-prepare')
    expect(prepared.data.package.caseDraft).toMatchObject({ intendedUse: 'authoring-only', plannedStentCount: 1 })
    const catalog = inpatientFullCatalogSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/clinical-catalog', { headers: { cookie: doctor.cookie } })).json())
    expect(catalog.medications.find(item => item.id === 'medication-pci-clopidogrel')).toMatchObject({ priceFen: 80, unit: '片', lots: [{ quantityOnHand: 1000 }] })
    expect(await businessResources()).toEqual(beforeBusiness)
    expect(await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: doctor.cookie } })).json()).toEqual(admissionsBefore)
    expect(s.data.read(admin.context).package.medications.find(item => item.id === 'medication-pci-clopidogrel')?.sourceQuotation)
      .toMatchObject({ priceFen: 700, unit: null, basis: 'denominator_unverified', original: { price: { amount: '7', unit: null } } })
  })

  it('检查与耗材进入现有目录，原报价未知单位仍保留，院内补充有独立身份', async () => {
    const s = await setup(), admin = await s.login('admin'), doctor = await s.login('inpatient-doctor')
    s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-catalog-prepare')
    const investigations = inpatientInvestigationCatalogSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/investigation-catalog', { headers: { cookie: doctor.cookie } })).json())
    expect(investigations.items.find(item => item.id === 'hospital-lab-pci-creatinine')).toMatchObject({ kind: 'laboratory', available: true, priceFen: 1000 })
    const surgery = inpatientSurgeryCatalogSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/surgery-catalog', { headers: { cookie: doctor.cookie } })).json())
    expect(surgery.materials.find(item => item.id === 'hospital-material-cv-223')).toMatchObject({ unavailableReason: 'unit-unconfirmed', reference: { specification: null, unit: null, priceFen: 73000 } })
    expect(surgery.materials.find(item => item.id === 'hospital-material-pci-stent')).toMatchObject({ chargeDefinition: { priceFen: 73000, unit: '枚', synthetic: true }, reference: { specification: null, unit: null } })
    expect(s.data.read(admin.context).installed.laboratories).toHaveLength(9)
    expect(s.data.read(admin.context).installed.materialIds).toHaveLength(4)
    const shared = await s.request(doctor.cookie, '/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=hospital-lab-pci&page=1&pageSize=20')
    expect(shared.status).toBe(200)
    const candidates = inpatientCatalogSearchSchema.parse(await shared.json())
    expect(candidates.items).toHaveLength(9)
    expect(candidates.items.every(item => item.status === 'available')).toBe(true)
  })

  it('复用精确产品的院内ID和价格，首次仅补住院范围并报告已有规则冲突', async () => {
    const s = await setup(), admin = await s.login('admin')
    const definition = s.data.read(admin.context).package.medications.find(item => item.id === 'medication-pci-clopidogrel')!
    // 已发布的院内目录旧数据；assertions 只通过公开 prepare/read 检查保真与补缺。
    s.runtime.database.driver.prepare(`INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
      VALUES(?,?,?,'medication',?,?,?,321,7,1,?)`)
      .run(admin.context.workspaceId, admin.context.epoch, 'existing-clopidogrel', definition.product.code, definition.product.genericName, definition.product.genericName,
        JSON.stringify({ product: definition.product, unit: '片', availableScopes: ['outpatient'], allowedCombinationIds: [],
          inpatientIndications: [{ ...pciDataPackage.diagnosis, code: 'I20.900' }] }))
    const prepared = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-reuse-existing')
    const medication = prepared.data.installed.medications.find(item => item.definitionId === definition.id)!
    expect(medication).toMatchObject({ catalogItemId: 'existing-clopidogrel', priceFen: 321, unit: '片', availableScopes: ['outpatient', 'inpatient'], conflicts: ['indication-restricted', 'combination-restricted'] })
    expect(prepared.data.installed.medications.filter(item => item.definitionId === definition.id)).toHaveLength(1)
    const again = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-reuse-another-key')
    expect(again.effects).toEqual([])
    expect(again.data.installed).toEqual(prepared.data.installed)
  })

  it('新增住院药品后门诊已有的独立处方能力继续可用', async () => {
    const s = await setup(), admin = await s.login('admin'), outpatient = await s.login('doctor')
    const before = s.runtime.workflow.clinicalCatalog(outpatient.context)
    expect(before.prescriptionConclusionSupported).toBe(true)
    s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-outpatient-compatibility')
    expect(s.runtime.workflow.clinicalCatalog(outpatient.context).prescriptionConclusionSupported).toBe(true)
    expect(s.runtime.workflow.doctorRecommendationMedications(outpatient.context).length).toBeGreaterThan(0)
  })

  it('单项旧配置非法时仍能回读其他资料，并明确标记该项配置问题', async () => {
    const s = await setup(), admin = await s.login('admin')
    s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-invalid-config-initial')
    s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.unit',17) WHERE workspace_id=? AND epoch=? AND item_id='medication-pci-aspirin'")
      .run(admin.context.workspaceId, admin.context.epoch)
    const response = await s.request(admin.cookie, '/api/his/v1/inpatient/pci-data')
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.installed.medications.find((item: { catalogItemId: string }) => item.catalogItemId === 'medication-pci-aspirin').conflicts).toContain('invalid-configuration')
    expect(data.installed.medications.find((item: { catalogItemId: string }) => item.catalogItemId === 'medication-pci-clopidogrel').conflicts).toEqual([])
  })

  it('独立读取成功与拒绝均留审计，prepare事务内回读只记一次共享Command审计', async () => {
    const s = await setup(), admin = await s.login('admin'), cashier = await s.login('cashier')
    expect((await s.request(admin.cookie, '/api/his/v1/inpatient/pci-data')).status).toBe(200)
    expect((await s.request(cashier.cookie, '/api/his/v1/inpatient/pci-data')).status).toBe(403)
    const query = new AuditQuery(s.runtime.database)
    expect(query.list(admin.context).filter(item => item.operation === 'inpatient.pci-data.read'))
      .toMatchObject([{ actorId: admin.context.actorId, outcome: 'success' }, { actorId: cashier.context.actorId, outcome: 'failed' }])
    const before = query.list(admin.context).length
    s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-data-audited-prepare')
    const events = query.list(admin.context).slice(before)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation: 'inpatient.pci-data.prepare', outcome: 'success' })
  })

  it('首次准备后保留用户主动停用及移除住院范围的设置，不重新激活或补库存', async () => {
    const s = await setup(), admin = await s.login('admin')
    const original = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-inactive-initial')
    s.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET active=0,config_json=json_set(config_json,'$.availableScopes',json('["outpatient"]'))
      WHERE workspace_id=? AND epoch=? AND item_id='medication-pci-aspirin'`).run(admin.context.workspaceId, admin.context.epoch)
    const preserved = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-inactive-preserve')
    expect(preserved.effects).toEqual([])
    const aspirin = preserved.data.installed.medications.find(item => item.definitionId === 'medication-pci-aspirin')!
    expect(aspirin).toMatchObject({ active: false, availableScopes: ['outpatient'], conflicts: ['inactive', 'scope-disabled'] })
    expect(aspirin.lots).toEqual(original.data.installed.medications.find(item => item.definitionId === 'medication-pci-aspirin')!.lots)
  })

  it('药品与单枚支架耗材经正式动作逐项计费，重复操作及重新准备不重记费或补库存，重启保留回执', async () => {
    const s = await setup(true), admin = await s.login('admin'), registrar = await s.login('registrar'), doctor = await s.login('inpatient-doctor')
    const nurse = await s.login('ward-nurse'), pharmacist = await s.login('pharmacist'), cashier = await s.login('cashier')
    const prepared = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-business-prepare')
    const created = await s.runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar.cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: {}, input: { name: '合成PCI局部发药患者', gender: 'male', birthDate: '1965-04-12', identifier: `SYN-PCI-${randomUUID()}` } }) })
    expect(created.status).toBe(200)
    const patient = z.object({ data: z.object({ patient: z.object({ id: z.string(), versionId: z.string() }) }) }).parse(await created.json()).data.patient
    const registered = await s.request(registrar.cookie, '/api/his/v1/inpatient/admissions', { expectedEpoch: admin.context.epoch, patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })
    expect(registered.status).toBe(200)
    let admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const received = await s.request(nurse.cookie, `${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })
    expect(received.status).toBe(200)
    admission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
    const diagnosed = await s.request(doctor.cookie, `${path}/diagnoses/confirm`, { encounterVersion: admission.versionId, expectedRevision: 0, entries: [{ catalogItemId: pciDataPackage.diagnosis.id, role: 'primary', admissionCondition: '1' }] })
    expect(diagnosed.status).toBe(200)
    const clinical = inpatientFullClinicalResponseSchema.parse(await diagnosed.json()).data
    const issued = await s.request(doctor.cookie, `${path}/orders/issue`, { encounterVersion: clinical.encounterVersion, duration: 'temporary', selection: {
      kind: 'medication', catalogItemId: 'medication-pci-clopidogrel', catalogVersion: 1, doseText: '75 mg', doseQuantity: 1, frequencyCode: 'QD' } })
    expect(issued.status).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
    const checked = await s.request(nurse.cookie, `${path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(checked.status).toBe(200)
    const execution = inpatientFullClinicalResponseSchema.parse(await checked.json()).data.executions[0]!
    const lot = s.data.read(admin.context).installed.medications.find(item => item.catalogItemId === 'medication-pci-clopidogrel')!.lots[0]!
    const dispenseInput = { executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }] }
    const dispensed = await s.request(pharmacist.cookie, `${path}/executions/dispense`, dispenseInput, 'pci-business-dispense')
    expect(dispensed.status).toBe(200)
    const receipt = inpatientPharmacyResponseSchema.parse(await dispensed.json())
    expect(await (await s.request(pharmacist.cookie, `${path}/executions/dispense`, dispenseInput, 'pci-business-dispense')).json()).toEqual(receipt)
    const dispensedExecution = receipt.data.executions.find(item => item.id === execution.id)!
    expect((await s.request(nurse.cookie, `${path}/executions/administer`, { executionId: execution.id, expectedExecutionVersion: dispensedExecution.version })).status).toBe(200)
    const chargeResponse = await s.request(cashier.cookie, `${path}/charges`)
    expect(chargeResponse.status).toBe(200)
    const charges = inpatientChargesSchema.parse(await chargeResponse.json())
    expect(charges.charges.filter(charge => charge.kind === 'medication')).toMatchObject([{ amountFen: 80 }])
    const currentClinical = inpatientFullClinicalResponseSchema.shape.data.parse(await (await s.request(doctor.cookie, `${path}/clinical`)).json())
    const requested = await s.request(doctor.cookie, `${path}/surgeries/request`, { encounterVersion: currentClinical.encounterVersion, procedureId: 'hospital-surgery-3', catalogVersion: 1,
      plannedFor: s.owner.virtualTime(admin.context), reason: '合成择期单枚支架局部接入验证' })
    expect(requested.status).toBe(200)
    const surgery = inpatientSurgeryResponseSchema.parse(await requested.json()).data.requests[0]!
    expect((await s.request(nurse.cookie, `${path}/surgeries/check-preop`, { requestId: surgery.id, expectedRequestVersion: 1, note: '人工核对本次术前资料' })).status).toBe(200)
    expect((await s.request(doctor.cookie, `${path}/surgeries/confirm-consent`, { requestId: surgery.id, expectedRequestVersion: 2, note: '人工确认本次同意书' })).status).toBe(200)
    const surgeryInput = { requestId: surgery.id, expectedRequestVersion: 3, procedureId: 'hospital-surgery-3', catalogVersion: 1,
      materials: ['guidewire', 'guiding-catheter', 'balloon', 'stent'].map(suffix => ({ materialId: `hospital-material-pci-${suffix}`, catalogVersion: 1, quantity: 1 })), note: '人工确认本次实际植入一枚合成支架及耗材使用' }
    const executed = await s.request(doctor.cookie, `${path}/surgeries/execute`, surgeryInput, 'pci-business-surgery')
    expect(executed.status).toBe(200)
    const surgeryReceipt = inpatientSurgeryResponseSchema.parse(await executed.json())
    expect(surgeryReceipt.data.executions[0]!.actualProcedure.coding.code).toBe('36.0700')
    expect(surgeryReceipt.data.executions[0]!.materials.find(item => item.item.id === 'hospital-material-pci-stent')).toMatchObject({ quantity: 1, amountFen: 73000 })
    expect(await (await s.request(doctor.cookie, `${path}/surgeries/execute`, surgeryInput, 'pci-business-surgery')).json()).toEqual(surgeryReceipt)
    const postSurgeryCharges = inpatientChargesSchema.parse(await (await s.request(cashier.cookie, `${path}/charges`)).json())
    expect(postSurgeryCharges.charges.filter(charge => charge.kind === 'material').map(charge => charge.amountFen).sort((a, b) => a - b)).toEqual([12298, 20000, 21300, 73000])
    expect(postSurgeryCharges.charges.filter(charge => charge.kind === 'surgery')).toMatchObject([{ amountFen: 180000 }])
    const refreshed = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-business-another-prepare')
    expect(refreshed.effects).toEqual([])
    expect(refreshed.data.installed.medications.find(item => item.catalogItemId === 'medication-pci-clopidogrel')!.lots[0]!.quantityOnHand).toBe(999)
    expect(inpatientChargesSchema.parse(await (await s.request(cashier.cookie, `${path}/charges`)).json())).toEqual(postSurgeryCharges)
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.options)
    cleanups.push(() => reopened.close())
    const data = new InpatientPciData(new InpatientService(reopened.database, reopened.fhir, new CommandExecutor(reopened.database, reopened.fhir), reopened.referenceData, reopened.workflow))
    expect(data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-business-prepare')).toEqual(prepared)
    expect(data.read(admin.context).installed.medications.find(item => item.catalogItemId === 'medication-pci-clopidogrel')!.lots[0]!.quantityOnHand).toBe(999)
  })
})
