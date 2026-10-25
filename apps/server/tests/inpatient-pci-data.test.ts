import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientFullCatalogSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import { InpatientPciData } from '../src/application/inpatient-pci-data.ts'
import { InpatientService } from '../src/application/inpatient-service.ts'
import { CommandExecutor, type ActorContext } from '../src/application/command-executor.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-data-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'] }
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
  return { runtime, owner, data, login, options }
}

describe('固定 PCI 数据公开 Command 与目录回读', () => {
  it('准备后药品能从现有住院目录读到，底稿不创建任何就诊或费用', async () => {
    const s = await setup(), admin = await s.login('admin'), doctor = await s.login('inpatient-doctor')
    const patients = await s.runtime.app.request('/fhir/R5/Patient?_summary=count', { headers: { cookie: admin.cookie } })
    const beforePatients = await patients.json()
    const admissionsBefore = await (await s.runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: doctor.cookie } })).json()
    const prepared = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-data-first-prepare')
    expect(prepared.data.package.caseDraft).toMatchObject({ intendedUse: 'authoring-only', plannedStentCount: 1 })
    const catalog = inpatientFullCatalogSchema.parse(await (await s.runtime.app.request('/api/his/v1/inpatient/clinical-catalog', { headers: { cookie: doctor.cookie } })).json())
    expect(catalog.medications.find(item => item.id === 'medication-pci-clopidogrel')).toMatchObject({ priceFen: 80, unit: '片', lots: [{ quantityOnHand: 1000 }] })
    expect(await (await s.runtime.app.request('/fhir/R5/Patient?_summary=count', { headers: { cookie: admin.cookie } })).json()).toEqual(beforePatients)
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
  })

  it('复用精确产品的院内ID和价格，首次仅补住院范围并报告已有规则冲突', async () => {
    const s = await setup(), admin = await s.login('admin')
    const definition = s.data.read(admin.context).package.medications.find(item => item.id === 'medication-pci-clopidogrel')!
    // 已发布的院内目录旧数据；assertions 只通过公开 prepare/read 检查保真与补缺。
    s.runtime.database.driver.prepare(`INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
      VALUES(?,?,?,'medication',?,?,?,321,7,1,?)`)
      .run(admin.context.workspaceId, admin.context.epoch, 'existing-clopidogrel', definition.product.code, definition.product.genericName, definition.product.genericName,
        JSON.stringify({ product: definition.product, unit: '片', availableScopes: ['outpatient'], allowedCombinationIds: [] }))
    const prepared = s.data.prepare(admin.context, { expectedEpoch: admin.context.epoch }, 'pci-reuse-existing')
    const medication = prepared.data.installed.medications.find(item => item.definitionId === definition.id)!
    expect(medication).toMatchObject({ catalogItemId: 'existing-clopidogrel', priceFen: 321, unit: '片', availableScopes: ['outpatient', 'inpatient'], conflicts: ['combination-restricted'] })
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
})
