import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiErrorSchema, clinicalCatalogSchema } from '@clinmesh/contracts/his'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { fhirBundleSchema, fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  inpatientCatalogSearchSchema,
  inpatientChargesSchema,
  inpatientChargesResponseSchema,
  inpatientFullCatalogSchema,
  inpatientFullClinicalResponseSchema,
  inpatientFullClinicalSchema,
} from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import {
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryCompletionPreviewSchema,
  inpatientSurgeryResponseSchema,
  inpatientSurgerySchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { inpatientPciDataResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { preparePciAcceptanceData } from './fixtures/pci-payment-drg.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(withDrgRules = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-surgery-meds-nursing-'))
  const drgData = withDrgRules ? await preparePciAcceptanceData(directory) : undefined
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = {
    authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'),
    demoPassword: password,
    migrationMode: 'apply',
    trustedOrigins: ['http://localhost'],
    ...(drgData
      ? {
          ...drgData,
          activeReferenceReleaseId: 'synthetic-pci-acceptance-reference',
        }
      : {}),
  }
  const runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }),
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }

  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
    })
  }

  const admin = await login('admin')
  const outpatientDoctor = await login('doctor')
  const registrar = await login('registrar')
  const doctor = await login('inpatient-doctor')
  const nurse = await login('ward-nurse')
  const cashier = await login('cashier')
  const medicalRecords = await login('medical-records')

  const created = await runtime.app.request('/api/his/v1/patients', {
    method: 'POST',
    headers: {
      cookie: registrar,
      origin: 'http://localhost',
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      expectedVersions: {},
      input: {
        name: '合成台内药与专科护理患者',
        gender: 'male',
        birthDate: '1966-05-20',
        identifier: `SYN-${randomUUID()}`,
      },
    }),
  })
  const patient = (await created.json()).data.patient
  const registered = (
    await (
      await request(registrar, '/api/his/v1/inpatient/admissions', {
        expectedEpoch: 'epoch-1',
        patientId: patient.id,
        patientVersion: patient.versionId,
        admissionRoute: 'direct',
        wardId: 'ward-general',
        depositFen: 100000,
      })
    ).json()
  ).data.admission
  const admission = (
    await (
      await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
        encounterVersion: registered.versionId,
        bedId: 'bed-general-1',
      })
    ).json()
  ).data.admission

  return {
    runtime,
    request,
    admin,
    outpatientDoctor,
    registrar,
    doctor,
    nurse,
    cashier,
    medicalRecords,
    patient,
    admission,
    path: `/api/his/v1/inpatient/admissions/${admission.id}`,
  }
}

async function prepareReadyRequest(
  s: Awaited<ReturnType<typeof setup>>,
  procedureId: string,
  locationId: 'location-catheterization-lab' | 'location-operating-center' = 'location-catheterization-lab',
) {
  const current = inpatientSurgerySchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries`)).json())
  const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
  const requested = inpatientSurgeryResponseSchema.parse(
    await (
      await s.request(s.doctor, `${s.path}/surgeries/request`, {
        encounterVersion: current.encounterVersion,
        surgeryType: 'elective',
        procedureId,
        catalogVersion: 1,
        plannedFor: '2026-08-26T10:00:00+08:00',
        locationId,
        surgeonPractitionerId: 'practitioner-inpatient-doctor',
        anesthesiaMethod: 'local-infiltration', preopOrderPolicy: 'continue-active',
        reason: `合成准备手术 ${procedureId}`,
      })
    ).json(),
  ).data
  const row = requested.requests.at(-1)!
  const checked = inpatientSurgeryResponseSchema.parse(
    await (
      await s.request(s.nurse, `${s.path}/surgeries/check-preop`, {
        requestId: row.id,
        expectedRequestVersion: row.version,
        note: '术前核对完成',
      })
    ).json(),
  ).data
  const ready = inpatientSurgeryResponseSchema.parse(
    await (
      await s.request(s.doctor, `${s.path}/surgeries/confirm-consent`, {
        requestId: row.id,
        expectedRequestVersion: checked.requests.find(item => item.id === row.id)!.version,
        expectedDiagnosisRevision: clinical.diagnosis.revision,
        signerRole: 'patient',
        signerName: s.patient.name,
        patientChoice: 'agree',
        note: '患者本人已签署知情同意书',
      })
    ).json(),
  ).data
  return ready.requests.find(item => item.id === row.id)!
}

describe('导管室与手术室台内基数药记账及术中专科护理自动联动计费', () => {
  it('手术目录暴露台内基数药、一键套餐与专科护理绑定，且不污染门诊 22 药或病房常规医嘱目录', async () => {
    const s = await setup()

    const outpatientCatalog = clinicalCatalogSchema.parse(
      await (await s.request(s.outpatientDoctor, '/api/his/v1/catalogs/clinical')).json(),
    )
    expect(outpatientCatalog.medications).toHaveLength(22)
    expect(outpatientCatalog.medications.some(item => item.id === 'medication-surgical-lidocaine')).toBe(false)

    const wardCatalog = inpatientFullCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/clinical-catalog')).json(),
    )
    expect(wardCatalog.medications.some(item => item.id === 'medication-surgical-lidocaine')).toBe(false)
    expect(wardCatalog.services.map(item => item.id)).toEqual([
      'hospital-service-diabetes-education',
      'hospital-service-postop-ecg-monitoring',
      'hospital-service-postop-puncture-immobilization',
      'hospital-service-postop-wound-vital-nursing',
    ])

    const wardSearch = inpatientCatalogSearchSchema.parse(
      await (
        await s.request(s.doctor, '/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&page=1&pageSize=50')
      ).json(),
    )
    expect(wardSearch.total).toBe(22)
    expect(wardSearch.items.some(item => item.id === 'medication-surgical-lidocaine')).toBe(false)
    expect(wardSearch.items.every(item => item.status === 'available')).toBe(true)

    const beforePci = inpatientSurgeryCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    expect(beforePci.baseStockMedications.map(item => item.id)).toEqual([
      'medication-nitroglycerin',
      'medication-pci-heparin',
      'medication-sodium-chloride',
      'medication-surgical-lidocaine',
    ])
    expect(beforePci.baseStockMedications.every(item => item.packageInsert !== undefined)).toBe(true)
    const lidocaine = beforePci.baseStockMedications.find(item => item.id === 'medication-surgical-lidocaine')!
    expect(lidocaine).toMatchObject({
      display: '盐酸利多卡因注射液',
      unit: 'mL',
      priceFen: 120,
      defaultRouteCode: 'IH',
      allowedRouteCodes: ['IH', 'IM', 'IV'],
      doseBasis: { amount: 20, unit: 'mg' },
      maxDoseQuantity: 20,
    })

    const contrastPkgBefore = beforePci.medicationPackages.find(
      pkg => pkg.id === 'catheterization-contrast-anticoagulation',
    )!
    expect(contrastPkgBefore.items).toEqual([
      expect.objectContaining({
        medicationId: 'medication-pci-iohexol',
        available: false,
        unavailableReason: 'not-installed',
      }),
      expect.objectContaining({
        medicationId: 'medication-pci-heparin',
        available: true,
        priceFen: 200,
      }),
    ])

    expect(beforePci.nursingBindings).toEqual([
      {
        serviceId: 'hospital-service-intraoperative-interventional-nursing',
        serviceVersion: 1,
        display: '术中介入专科护理',
        unit: '次',
        priceFen: 8000,
        procedureIds: [
          'hospital-surgery-1',
          'hospital-surgery-2',
          'hospital-surgery-3',
          'hospital-surgery-7',
          'hospital-surgery-8',
        ],
      },
      {
        serviceId: 'hospital-service-intraoperative-surgical-nursing',
        serviceVersion: 1,
        display: '术中手术室专科护理',
        unit: '次',
        priceFen: 10000,
        procedureIds: ['hospital-surgery-5'],
      },
    ])

    const prepared = inpatientPciDataResponseSchema.parse(
      await (await s.request(s.admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })).json(),
    )
    expect(prepared.data.installed.medications.map(item => item.catalogItemId)).toContain('medication-pci-iohexol')
    const rePrepared = inpatientPciDataResponseSchema.parse(
      await (await s.request(s.admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })).json(),
    )
    expect(rePrepared.effects).toEqual([])

    const afterPci = inpatientSurgeryCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    expect(afterPci.baseStockMedications.map(item => item.id)).toContain('medication-pci-iohexol')
    const contrastPkgAfter = afterPci.medicationPackages.find(
      pkg => pkg.id === 'catheterization-contrast-anticoagulation',
    )!
    expect(contrastPkgAfter.items.every(item => item.available)).toBe(true)
  })

  it('整台补录 execute 支持一键套餐台内基数药免填常规备注，并按术式配置自动联动或跳过专科护理费', async () => {
    const s = await setup()
    await s.request(s.admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })
    const catalog = inpatientSurgeryCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    const contrastPkg = catalog.medicationPackages.find(pkg => pkg.id === 'catheterization-contrast-anticoagulation')!

    // 1. 88.5500 冠脉造影：登记台内对比剂与肝素、省略常规 note，自动联动 8000 分介入专科护理
    const angioReq = await prepareReadyRequest(s, 'hospital-surgery-7', 'location-catheterization-lab')
    const angioKey = randomUUID()
    const angioInput = {
      requestId: angioReq.id,
      expectedRequestVersion: angioReq.version,
      procedureId: 'hospital-surgery-7',
      catalogVersion: 1,
      materials: [],
      medications: contrastPkg.items.map(item => ({
        medicationId: item.medicationId,
        catalogVersion: item.catalogVersion!,
        doseText: item.doseText,
        quantity: item.quantity,
        routeCode: item.routeCode,
      })),
    }
    const angioResp = await s.request(s.doctor, `${s.path}/surgeries/execute`, angioInput, angioKey)
    expect(angioResp.status, await angioResp.clone().text()).toBe(200)
    const angioReceipt = inpatientSurgeryResponseSchema.parse(await angioResp.json())
    expect(
      inpatientSurgeryResponseSchema.parse(
        await (await s.request(s.doctor, `${s.path}/surgeries/execute`, angioInput, angioKey)).json(),
      ),
    ).toEqual(angioReceipt)

    const angioExec = angioReceipt.data.executions.find(item => item.requestId === angioReq.id)!
    expect(angioExec.medications).toHaveLength(2)
    expect(angioExec.medications).toEqual([
      expect.objectContaining({
        medicationId: 'medication-pci-iohexol',
        doseText: '50 mL',
        quantity: 50,
        routeCode: 'IV',
        amountFen: 7500,
        chargeId: expect.any(String),
      }),
      expect.objectContaining({
        medicationId: 'medication-pci-heparin',
        doseText: '1 mL',
        quantity: 1,
        routeCode: 'IV',
        amountFen: 200,
        chargeId: expect.any(String),
      }),
    ])
    expect(angioExec.linkedNursing).toEqual({
      serviceId: 'hospital-service-intraoperative-interventional-nursing',
      serviceVersion: 1,
      display: '术中介入专科护理',
      unit: '次',
      amountFen: 8000,
      chargeId: expect.any(String),
    })

    // FHIR MedicationAdministration 关联 Procedure/<executionId> 且无病房 MedicationRequest / 发药记录
    const clinicalAfterAngio = inpatientFullClinicalSchema.parse(
      await (await s.request(s.doctor, `${s.path}/clinical`)).json(),
    )
    expect(clinicalAfterAngio.orders).toEqual([])
    expect(clinicalAfterAngio.executions).toEqual([])
    expect(clinicalAfterAngio.dispenses).toEqual([])
    expect(clinicalAfterAngio.chargesFen).toBe(80000 + 7500 + 200 + 8000)

    const adminBundle = fhirBundleSchema.parse(
      await (await s.request(s.doctor, `/fhir/R5/MedicationAdministration?encounter=Encounter/${s.admission.id}`)).json(),
    )
    expect(adminBundle.entry).toHaveLength(2)
    for (const entry of adminBundle.entry ?? []) {
      const resource = fhirResourceSchema.parse(entry.resource)
      expect(resource).toMatchObject({
        resourceType: 'MedicationAdministration',
        status: 'completed',
        partOf: [{ reference: `Procedure/${angioExec.id}` }],
      })
      expect(resource).not.toHaveProperty('request')
    }

    // 2. 47.0100 腹腔镜阑尾切除术（未绑定专科护理对照术式）：登记台内基础液体套餐，不产生 linkedNursing
    const generalPkg = catalog.medicationPackages.find(pkg => pkg.id === 'general-surgery-perioperative-fluid')!
    const appendectomyReq = await prepareReadyRequest(s, 'hospital-surgery-4', 'location-operating-center')
    const appendectomyResp = await s.request(s.doctor, `${s.path}/surgeries/execute`, {
      requestId: appendectomyReq.id,
      expectedRequestVersion: appendectomyReq.version,
      procedureId: 'hospital-surgery-4',
      catalogVersion: 1,
      materials: [],
      medications: generalPkg.items.map(item => ({
        medicationId: item.medicationId,
        catalogVersion: item.catalogVersion!,
        doseText: item.doseText,
        quantity: item.quantity,
        routeCode: item.routeCode,
      })),
    })
    expect(appendectomyResp.status, await appendectomyResp.clone().text()).toBe(200)
    const appendectomyExec = inpatientSurgeryResponseSchema
      .parse(await appendectomyResp.json())
      .data.executions.find(item => item.requestId === appendectomyReq.id)!
    expect(appendectomyExec.linkedNursing).toBeUndefined()
    expect(appendectomyExec.medications?.reduce((sum, item) => sum + item.amountFen, 0)).toBe(100 + 600)

    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(charges.chargesFen).toBe(95700 + 200000 + 700)
  })

  it('分步术中 start -> record-medication -> preview-completion -> complete 实时记账、完术差额含专科护理且三岗位只读可见', async () => {
    const s = await setup()
    const catalog = inpatientSurgeryCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    const lidocaine = catalog.baseStockMedications.find(item => item.id === 'medication-surgical-lidocaine')!
    const heparin = catalog.baseStockMedications.find(item => item.id === 'medication-pci-heparin')!

    const req = await prepareReadyRequest(s, 'hospital-surgery-5', 'location-operating-center')
    const started = inpatientSurgeryResponseSchema.parse(
      await (
        await s.request(s.doctor, `${s.path}/surgeries/start`, {
          requestId: req.id,
          expectedRequestVersion: req.version,
          procedureId: 'hospital-surgery-5',
          catalogVersion: 1,
        })
      ).json(),
    ).data
    const running = started.inProgress[0]!
    expect(running.medications).toBeUndefined()
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(0)

    // 护士越岗登记台内药须 403 拒绝
    const forbidden = await s.request(s.nurse, `${s.path}/surgeries/record-medication`, {
      requestId: req.id,
      expectedRequestVersion: started.requests[0]!.version,
      executionId: running.id,
      medication: {
        medicationId: lidocaine.id,
        catalogVersion: lidocaine.version,
        doseText: '100 mg',
        quantity: 5,
        routeCode: 'IH',
      },
    })
    expect(forbidden.status).toBe(403)

    // 医生逐笔登记利多卡因 100 mg (5 mL = 600 分) 与肝素钠 12500 IU (2 mL = 400 分)，支持幂等重放与回执查询
    const medKey = randomUUID()
    const medInput = {
      requestId: req.id,
      expectedRequestVersion: started.requests[0]!.version,
      executionId: running.id,
      medication: {
        medicationId: lidocaine.id,
        catalogVersion: lidocaine.version,
        doseText: '100 mg',
        quantity: 5,
        routeCode: 'IH',
      },
    }
    const firstMedResp = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, medInput, medKey)
    expect(firstMedResp.status, await firstMedResp.clone().text()).toBe(200)
    const firstMedReceipt = inpatientSurgeryResponseSchema.parse(await firstMedResp.json())
    expect(
      inpatientSurgeryResponseSchema.parse(
        await (await s.request(s.doctor, `${s.path}/surgeries/record-medication`, medInput, medKey)).json(),
      ),
    ).toEqual(firstMedReceipt)
    const lookup = commandReceiptLookupSchema.parse(
      await (
        await s.request(
          s.doctor,
          `/api/his/v1/command-receipts?operationId=inpatient.surgery.record-medication&idempotencyKey=${medKey}`,
        )
      ).json(),
    )
    expect(lookup.status).toBe('completed')

    const secondMedResp = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, {
      requestId: req.id,
      expectedRequestVersion: firstMedReceipt.data.requests[0]!.version,
      executionId: running.id,
      note: '术中追加静脉抗凝',
      medication: {
        medicationId: heparin.id,
        catalogVersion: heparin.version,
        doseText: '12500 IU',
        quantity: 2,
        routeCode: 'IV',
      },
    })
    expect(secondMedResp.status, await secondMedResp.clone().text()).toBe(200)
    const afterMeds = inpatientSurgeryResponseSchema.parse(await secondMedResp.json()).data
    expect(afterMeds.inProgress[0]!.medications).toHaveLength(2)
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).chargesFen).toBe(
      1000,
    )

    // 完术预览包含术式费 250000 + 手术室专科护理 10000 = 260000，不重复计入已记账的 1000 分台内药
    const previewResp = await s.request(s.doctor, `${s.path}/surgeries/preview-completion`, {
      requestId: req.id,
      expectedRequestVersion: afterMeds.requests[0]!.version,
      executionId: running.id,
      finalMaterials: [],
      releaseReservations: [],
    })
    expect(previewResp.status, await previewResp.clone().text()).toBe(200)
    const preview = inpatientSurgeryCompletionPreviewSchema.parse(await previewResp.json())
    expect(preview).toMatchObject({
      materialDeltaFen: 0,
      procedureAmountFen: 250000,
      nursingAmountFen: 10000,
      linkedNursing: {
        serviceId: 'hospital-service-intraoperative-surgical-nursing',
        serviceVersion: 1,
        display: '术中手术室专科护理',
        unit: '次',
        amountFen: 10000,
      },
      totalDeltaFen: 260000,
    })

    const completedResp = await s.request(s.doctor, `${s.path}/surgeries/complete`, {
      requestId: req.id,
      expectedRequestVersion: afterMeds.requests[0]!.version,
      executionId: running.id,
      reconciliation: {
        finalMaterials: [],
        releaseReservations: [],
        expectedFingerprint: preview.fingerprint,
      },
    })
    expect(completedResp.status, await completedResp.clone().text()).toBe(200)
    const completed = inpatientSurgeryResponseSchema.parse(await completedResp.json()).data
    expect(completed.inProgress).toEqual([])
    expect(completed.executions[0]).toMatchObject({
      id: running.id,
      medications: [
        expect.objectContaining({ medicationId: 'medication-surgical-lidocaine', amountFen: 600 }),
        expect.objectContaining({ medicationId: 'medication-pci-heparin', amountFen: 400 }),
      ],
      linkedNursing: {
        serviceId: 'hospital-service-intraoperative-surgical-nursing',
        amountFen: 10000,
        chargeId: expect.any(String),
      },
    })

    for (const cookie of [s.doctor, s.nurse, s.medicalRecords]) {
      const readBack = inpatientSurgerySchema.parse(await (await s.request(cookie, `${s.path}/surgeries`)).json())
      expect(readBack.executions[0]!.medications).toHaveLength(2)
      expect(readBack.executions[0]!.linkedNursing?.amountFen).toBe(10000)
    }

    const finalCharges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    expect(finalCharges.chargesFen).toBe(1000 + 250000 + 10000)
  })

  it('严格拦截过敏红线、非法途径与超单次极量并整笔回滚，同时豁免病房在用医嘱重复开立冲突', async () => {
    const s = await setup()
    const catalog = inpatientSurgeryCatalogSchema.parse(
      await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json(),
    )
    const lidocaine = catalog.baseStockMedications.find(item => item.id === 'medication-surgical-lidocaine')!
    const heparin = catalog.baseStockMedications.find(item => item.id === 'medication-pci-heparin')!

    // 确认诊断并开立病房在用肝素 PRN 医嘱，验证台内追加肝素不会被 MEDICATION_COMBINATION_NOT_ALLOWED 误拦
    const diagnosed = inpatientFullClinicalResponseSchema.parse(
      await (
        await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
          encounterVersion: s.admission.versionId,
          expectedRevision: 0,
          entries: [{ catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary', admissionCondition: '1' }],
        })
      ).json(),
    ).data
    const issuedOrder = await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: diagnosed.encounterVersion,
      duration: 'temporary',
      selection: {
        kind: 'medication',
        catalogItemId: 'medication-pci-heparin',
        catalogVersion: heparin.version,
        doseText: '1 mL',
        doseQuantity: 1,
        frequencyCode: 'PRN',
        routeCode: 'IV',
      },
    })
    expect(issuedOrder.status, await issuedOrder.clone().text()).toBe(200)

    // 写入对利多卡因（SURGICAL-LIDOCAINE）的有效确认药物过敏
    s.runtime.fhir.create(
      { workspaceId: 'workspace-demo', epoch: 'epoch-1' },
      {
        resourceType: 'AllergyIntolerance',
        id: `allergy-${randomUUID()}`,
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
        },
        verificationStatus: {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' },
          ],
        },
        category: ['medication'],
        code: {
          coding: [{ code: 'SURGICAL-LIDOCAINE', display: '盐酸利多卡因注射液' }],
          text: '盐酸利多卡因注射液',
        },
        patient: { reference: `Patient/${s.patient.id}` },
      },
    )

    const req = await prepareReadyRequest(s, 'hospital-surgery-7')

    // 1. 过敏红线在 execute 中整笔拦截回滚（不落地 Procedure 或 ChargeItem）
    const allergyExecute = await s.request(s.doctor, `${s.path}/surgeries/execute`, {
      requestId: req.id,
      expectedRequestVersion: req.version,
      procedureId: 'hospital-surgery-7',
      catalogVersion: 1,
      materials: [],
      medications: [
        {
          medicationId: lidocaine.id,
          catalogVersion: lidocaine.version,
          doseText: '5 mL',
          quantity: 5,
          routeCode: 'IH',
        },
      ],
    })
    expect(allergyExecute.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyExecute.json())).toMatchObject({
      error: {
        code: 'CATALOG_CONFLICT',
        reason: 'MEDICATION_ALLERGY_CONFLICT',
        clinicalQuality: {
          status: 'blocked',
          redLines: [expect.objectContaining({ code: 'MEDICATION_ALLERGY_CONFLICT' })],
        },
      },
    })
    expect(inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json()).charges).toEqual(
      [],
    )

    // 2. 开始手术后验证非法途径、超极量拦截，以及病房已有肝素医嘱时台内肝素正常放行
    const started = inpatientSurgeryResponseSchema.parse(
      await (
        await s.request(s.doctor, `${s.path}/surgeries/start`, {
          requestId: req.id,
          expectedRequestVersion: req.version,
          procedureId: 'hospital-surgery-7',
          catalogVersion: 1,
        })
      ).json(),
    ).data
    const running = started.inProgress[0]!
    const baseRecord = {
      requestId: req.id,
      expectedRequestVersion: started.requests[0]!.version,
      executionId: running.id,
    }

    const badRoute = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, {
      ...baseRecord,
      medication: {
        medicationId: heparin.id,
        catalogVersion: heparin.version,
        doseText: '1 mL',
        quantity: 1,
        routeCode: 'PO',
      },
    })
    expect(badRoute.status).toBe(409)
    expect(apiErrorSchema.parse(await badRoute.json()).error.reason).toBe('MEDICATION_ROUTE_NOT_ALLOWED')

    const overDose = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, {
      ...baseRecord,
      medication: {
        medicationId: heparin.id,
        catalogVersion: heparin.version,
        doseText: '3 mL',
        quantity: 3,
        routeCode: 'IV',
      },
    })
    expect(overDose.status).toBe(409)
    expect(apiErrorSchema.parse(await overDose.json()).error.reason).toBe('MEDICATION_DOSAGE_NOT_ALLOWED')

    const allergyRecord = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, {
      ...baseRecord,
      medication: {
        medicationId: lidocaine.id,
        catalogVersion: lidocaine.version,
        doseText: '5 mL',
        quantity: 5,
        routeCode: 'IH',
      },
    })
    expect(allergyRecord.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyRecord.json()).error.reason).toBe('MEDICATION_ALLERGY_CONFLICT')

    // 病房已有肝素 PRN 医嘱，台内仍可正常登记肝素 1 mL IV
    const allowedHeparin = await s.request(s.doctor, `${s.path}/surgeries/record-medication`, {
      ...baseRecord,
      medication: {
        medicationId: heparin.id,
        catalogVersion: heparin.version,
        doseText: '1 mL',
        quantity: 1,
        routeCode: 'IV',
      },
    })
    expect(allowedHeparin.status, await allowedHeparin.clone().text()).toBe(200)
  })

  it('DRG 推演与术后核查纳入联动专科护理与台内药品，收费员冲正后准确识别 billing-mismatch', async () => {
    const s = await setup(true)
    const diagnosed = inpatientFullClinicalResponseSchema.parse(
      await (
        await s.request(s.doctor, `${s.path}/diagnoses/confirm`, {
          encounterVersion: s.admission.versionId,
          expectedRevision: 0,
          entries: [
            {
              catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103',
              role: 'primary',
              admissionCondition: '1',
            },
          ],
        })
      ).json(),
    ).data
    expect(diagnosed.diagnosis.revision).toBe(1)

    const req = await prepareReadyRequest(s, 'hospital-surgery-3', 'location-catheterization-lab')
    const beforeExecSim = inpatientDrgSimulationSchema.parse(
      await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json(),
    )
    expect(beforeExecSim.committed.items).toEqual([
      { kind: 'surgery', id: req.id, display: '药物洗脱冠状动脉支架置入', quantity: 1, estimatedFen: 180000 },
      { kind: 'surgery', id: `${req.id}.nursing`, display: '术中介入专科护理', quantity: 1, estimatedFen: 8000 },
    ])
    expect(beforeExecSim.coverage.estimatedTotalFen).toBe(188000)

    const executed = inpatientSurgeryResponseSchema.parse(
      await (
        await s.request(s.doctor, `${s.path}/surgeries/execute`, {
          requestId: req.id,
          expectedRequestVersion: req.version,
          procedureId: 'hospital-surgery-3',
          catalogVersion: 1,
          materials: [],
          medications: [
            {
              medicationId: 'medication-surgical-lidocaine',
              catalogVersion: 1,
              doseText: '5 mL',
              quantity: 5,
              routeCode: 'IH',
            },
          ],
        })
      ).json(),
    ).data
    const exec = executed.executions[0]!

    const afterExecSim = inpatientDrgSimulationSchema.parse(
      await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json(),
    )
    expect(afterExecSim.committed.items).toEqual([])
    expect(afterExecSim.formal.chargesFen).toBe(188600)
    expect(afterExecSim.formal.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'medication',
          display: '盐酸利多卡因注射液（药物洗脱冠状动脉支架置入 · 5 mL）',
          quantity: 5,
          estimatedFen: 600,
        }),
        expect.objectContaining({
          kind: 'service',
          display: '术中介入专科护理（药物洗脱冠状动脉支架置入）',
          quantity: 1,
          estimatedFen: 8000,
        }),
      ]),
    )

    const recordBeforeReverse = inpatientRecordSchema.parse(
      await (await s.request(s.doctor, `${s.path}/record`)).json(),
    )
    expect(recordBeforeReverse.snapshot.clinical.operations[0]!.medications).toHaveLength(1)
    expect(recordBeforeReverse.snapshot.clinical.operations[0]!.linkedNursing?.amountFen).toBe(8000)

    // 收费员冲正术中联动护理费与台内药品费后，record-checks 暴露 cashier 侧 billing-mismatch
    const charges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${s.path}/charges`)).json())
    const nursingCharge = charges.charges.find(item => item.id === exec.linkedNursing!.chargeId)!
    const medCharge = charges.charges.find(item => item.id === exec.medications![0]!.chargeId)!
    for (const target of [nursingCharge, medCharge]) {
      const reversed = await s.request(s.cashier, `${s.path}/charges/reverse`, {
        chargeId: target.id,
        expectedChargeVersion: target.version,
        reason: '合成测试冲正验证术后核查',
      })
      expect(reversed.status).toBe(200)
      inpatientChargesResponseSchema.parse(await reversed.json())
    }

    const checks = inpatientDrgRecordChecksSchema.parse(
      await (await s.request(s.doctor, `${s.path}/drg/record-checks`)).json(),
    )
    expect(checks.issues.filter(issue => issue.kind === 'billing-mismatch')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerRole: 'cashier',
          display: '术中介入专科护理',
          expectedChargeFen: 8000,
          actualChargeFen: 0,
        }),
        expect.objectContaining({
          ownerRole: 'cashier',
          display: '盐酸利多卡因注射液',
          expectedChargeFen: 600,
          actualChargeFen: 0,
        }),
      ]),
    )
  })

  it('0121 迁移无损兼容升级前已完成手术，linked_nursing_json 保持空值且外键完整', async () => {
    const migrationDir = await mkdtemp(join(tmpdir(), 'clinmesh-0121-migration-'))
    const migrationFile = '0121_surgery-medications-and-nursing.sql'
    const db = openClinMeshDatabase({ databasePath: join(migrationDir, 'hospital.sqlite'), busyTimeoutMs: 5000 })
    try {
      const preMigrations = join(migrationDir, 'pre-0121')
      await mkdir(preMigrations)
      await Promise.all(
        (await readdir('drizzle'))
          .filter(file => file.endsWith('.sql') && file < migrationFile)
          .map(file => copyFile(join('drizzle', file), join(preMigrations, file))),
      )
      applyMigrations(db, preMigrations)
      const scope = { workspaceId: 'synthetic-0121', epoch: 'epoch-1', scenarioRunId: 'run-1' }
      const now = '2026-11-24T09:00:00.000Z'
      new WorkspaceRepository(db).install({ ...scope, scenarioId: 'synthetic-0121', workspaceName: '合成0121迁移验证' })
      db.driver
        .prepare("INSERT INTO scenario_definition(scenario_id,version,kind,schema_version) VALUES('synthetic-0121','1','candidate','1')")
        .run()
      db.driver
        .prepare(
          "INSERT INTO scenario_epoch_state(workspace_id,epoch,scenario_run_id,scenario_id,deterministic_seed,virtual_time,initial_state_hash) VALUES(?,?,'run-1','synthetic-0121',1,?,?)",
        )
        .run(scope.workspaceId, scope.epoch, now, '0'.repeat(64))
      db.driver
        .prepare("INSERT INTO inpatient_ward(workspace_id,epoch,ward_id,organization_id,name) VALUES(?,?,'ward-1','org-1','合成病区')")
        .run(scope.workspaceId, scope.epoch)
      db.driver
        .prepare(
          `INSERT INTO inpatient_admission(workspace_id,epoch,admission_id,patient_id,inpatient_number,admission_route,ward_id,organization_id,status,financial_status,record_status,registered_at,admitted_at)
           VALUES(?,?,'adm-1','pat-1','ZY-0121','direct','ward-1','org-1','admitted','open','open',?,?)`,
        )
        .run(scope.workspaceId, scope.epoch, now, now)
      const procJson = JSON.stringify({
        id: 'hospital-surgery-7',
        version: 1,
        coding: {
          system: 'urn:clinmesh:classification:icd-9-cm-3-clinical',
          version: '3.0',
          code: '88.5500',
          display: '单根导管的冠状动脉造影术',
          category: '诊断性操作',
          releaseId: 'clinmesh-surgery-subset-2026-10-20',
          sourceUrl: 'https://example.com/s',
          sourceSha256: 'a'.repeat(64),
          sourceLocator: 's',
        },
        chargeDefinition: { id: 'c-7', priceFen: 80000, unit: '次', synthetic: true, trigger: 'execution' },
      })
      db.driver
        .prepare(
          `INSERT INTO inpatient_surgery_request(workspace_id,epoch,request_id,admission_id,version,status,planned_procedure_json,planned_for,reason,requested_at,requested_by,organization_id)
           VALUES(?,?,'req-legacy','adm-1',3,'completed',?,?,'升级前已完成手术',?,'doctor','org-1')`,
        )
        .run(scope.workspaceId, scope.epoch, procJson, now, now)
      db.driver
        .prepare(
          `INSERT INTO inpatient_surgery_execution(workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at)
           VALUES(?,?,'exec-legacy','req-legacy','adm-1',?,?,'doctor','role-doctor','org-1','旧版执行','completed',?)`,
        )
        .run(scope.workspaceId, scope.epoch, procJson, now, now)

      expect(applyMigrations(db).applied).toEqual([migrationFile, '0122_surgery-ad-hoc-pci.sql', '0123_surgery-preop-policy-and-postop-investigations.sql', '0124_clinical-fact-verification.sql', '0125_local-source-ingestion.sql', '0126_disease-pack-runtime.sql', '0127_bedside-questionnaire-answers.sql', '0128_clinical-prompt-cards.sql'])
      expect(db.driver.pragma('foreign_key_check')).toEqual([])
      const row = z
        .object({ execution_id: z.string(), linked_nursing_json: z.null() })
        .parse(db.driver.prepare('SELECT execution_id, linked_nursing_json FROM inpatient_surgery_execution').get())
      expect(row.execution_id).toBe('exec-legacy')
      expect(db.driver.prepare('SELECT COUNT(*) AS c FROM inpatient_surgery_medication').get()).toEqual({ c: 0 })
    } finally {
      db.close()
      await rm(migrationDir, { recursive: true, force: true })
    }
  })
})
