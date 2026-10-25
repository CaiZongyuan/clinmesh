import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientTransferCatalogSchema, inpatientTransferResponseSchema } from '@clinmesh/contracts/inpatient-transfer'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { laboratoryServiceSnapshotSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import { acuteBronchitis, caseBundle, createImagingRuntime, generateCase, mutation, prepareImaging, signIn, snomed, startConsultation } from './fixtures/imaging-scenario.ts'
import { applyMigrations, canonicalStateHash, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { z } from 'zod'
import { repairImagingAssets } from '../src/infrastructure/imaging-assets/imaging-asset-store.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const base = caseBundle({ gender: 'male', index: [{ ...acuteBronchitis, resourceType: 'Condition' }], name: '合成住院检查患者' })
  const created = await createImagingRuntime([{ ...base, entry: [...base.entry, { fullUrl: 'urn:uuid:inpatient-wbc-source', resource: {
    resourceType: 'Observation', id: 'inpatient-wbc-source', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '6690-2', display: '白细胞计数' }] },
    subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:index-encounter' }, effectiveDateTime: '2026-06-01T10:10:00+08:00',
    valueQuantity: { value: 7.2, unit: '10^9/L', system: 'http://unitsofmeasure.org', code: '10*9/L' },
  } }] }], { persona: true })
  const { runtime } = created
  await addSecondaryInpatientWard(runtime)
  cleanups.push(async () => { await runtime.close(); await rm(created.directory, { recursive: true, force: true }) })
  await installSyntheticImagingAssets({ assetDirectory: created.assetDirectory, catalogDirectory: created.catalogDirectory,
    assets: [{ assetId: 'synthetic-inpatient-radiograph', examCode: 'chest-radiograph' }],
    matching: { schemaVersion: 1, ruleVersion: 1, codeSystem: snomed, sourceExamCodes: {}, uncoveredConditions: [], profiles: [{
      id: 'inpatient-negative', label: '合成住院胸片', finding: 'negative', ageRange: [18, 89], indexConditionCodes: [acuteBronchitis.code], assets: { 'chest-radiograph': 'synthetic-inpatient-radiograph' },
    }] } })
  const admin = await signIn(runtime)
  const context = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json()).actor
  const concept = { id: 'loinc:synthetic:6690-2', system: 'http://loinc.org', code: '6690-2', display: '白细胞计数', version: '2.83', sourceLocator: 'synthetic:loinc:6690-2' }
  const service = laboratoryServiceSnapshotSchema.parse({ id: 'synthetic-inpatient-wbc', version: 1, serviceKind: 'laboratory', doctorOrderable: true,
    localCode: 'SYN-IP-WBC', nameZh: '合成白细胞计数', referenceConcept: concept, referenceReleaseId: 'synthetic-laboratory-release', componentServiceIds: [], executingDepartmentId: 'department-laboratory',
    allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
    reportDefinition: { conclusionTemplate: '白细胞计数结果已完成。', results: [{ referenceConcept: concept, valueType: 'quantity', referenceRange: { low: 4, high: 10, text: '4.0-10.0 x10^9/L' }, unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10^9/L' } }] } })
  runtime.database.driver.prepare('INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)')
    .run(context.workspaceId, context.epoch, service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service, billingUnit: { display: '项目' }, availableScopes: ['outpatient','inpatient'], chargeDefinition: { id: 'synthetic-wbc-charge-definition', currency: 'CNY', priceFen: 800 } }))
  const unpriced = { ...service, id: 'synthetic-unpriced-wbc', localCode: 'SYN-UNPRICED-WBC', nameZh: '合成未计价白细胞', priceFen: 0 }
  runtime.database.driver.prepare('INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)')
    .run(context.workspaceId, context.epoch, unpriced.id, unpriced.localCode, unpriced.nameZh, unpriced.nameZh, JSON.stringify({ laboratoryService: unpriced, availableScopes: ['outpatient','inpatient'], chargeDefinition: { currency: 'CNY', priceFen: 0 } }))
  const sourceCase = await generateCase(runtime, admin)
  await prepareImaging(runtime, admin, [sourceCase])
  const visit = await startConsultation(runtime, admin, sourceCase)
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
  const doctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local')
  const nurse = await signIn(runtime, 'ward-nurse@demo.clinmesh.local')
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, input === undefined ? { headers: { cookie } } : {
      ...mutation(cookie, { input }), headers: { ...mutation(cookie, {}).headers, 'idempotency-key': key },
    })
  }
  const patient = fhirResourceSchema.parse(await (await request(registrar, `/fhir/R5/Patient/${visit.patientId}`)).json())
  const registration = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.meta!.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })
  expect(registration.status).toBe(200)
  const registered = inpatientCommandResponseSchema.parse(await registration.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const admission = inpatientCommandResponseSchema.parse(await (await request(nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { ...created, request, doctor, nurse, registrar, admission, path, visit }
}

async function dispatchAll(runtime: Awaited<ReturnType<typeof createImagingRuntime>>['runtime']) {
  const kinds: string[] = []
  for (;;) { const event = await runtime.dispatcher.dispatchOnce(); if (event === undefined) return kinds; kinds.push(event.kind) }
}

describe('住院检查检验 HTTP 合同', () => {
  it.each(['laboratory', 'imaging'] as const)('旧%s收费定义没有独立id时仍可开立，并按原冻结价格收费', async kind => {
    const s = await setup()
    const serviceId = kind === 'laboratory' ? 'synthetic-inpatient-wbc' : 'imaging-chest-radiograph'
    const priceFen = kind === 'laboratory' ? 1300 : 8000
    const billing = { display: '合成旧住院收费定义', currency: 'CNY', priceFen,
      trigger: 'execution-completed', source: 'synthetic-legacy-billing', availableScopes: ['inpatient'] }
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET config_json=json_set(config_json,
      '$.inpatientInvestigationBilling',json(?)) WHERE service_id=?`).run(JSON.stringify(billing), serviceId)
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')).json()
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: serviceId, available: true, priceFen }))
    if (kind === 'laboratory') {
      const candidates = await (await s.request(s.doctor, `/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=${serviceId}`)).json()
      expect(candidates.items).toEqual([expect.objectContaining({ status: 'available', catalogItemId: serviceId, missingFields: [] })])
    }
    const selection = kind === 'laboratory'
      ? { kind, catalogItemId: serviceId, indicationCode: 'clinical-assessment' }
      : { kind, serviceId, indication: '合成旧价目兼容回归' }
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, {
      encounterVersion: s.admission.versionId, catalogVersion: 1, selection })
    expect(issued.status).toBe(200)
    const facts = inpatientInvestigationsSchema.parse((await issued.json()).data)
    const request = (kind === 'laboratory' ? facts.laboratoryRequests : facts.imagingRequests)[0]!
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=version+1,
      config_json=json_set(config_json,'$.inpatientInvestigationBilling.priceFen',?) WHERE service_id=?`)
      .run(priceFen + 1000, serviceId)
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, { requestId: request.id,
      expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion,
      taskVersion: request.taskVersion })).status).toBe(200)
    await dispatchAll(s.runtime)
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    const charges = await (await s.request(cashier, `${s.path}/charges`)).json()
    expect(charges.charges).toMatchObject([{ kind, sourceId: request.id, amountFen: priceFen }])
  })

  it.each([{}, null])('有效住院收费定义不受损坏备用定义 %j 影响，并在开立时冻结价格', async chargeDefinition => {
    const s = await setup()
    const billing = { id: 'synthetic-inpatient-wbc-charge', version: 3, display: '住院合成白细胞计数', currency: 'CNY', priceFen: 1300,
      trigger: 'execution-completed', source: 'synthetic-read-write-regression', availableScopes: ['inpatient'], effectiveOn: '2026-10-25' }
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET config_json=json_set(config_json,
      '$.inpatientInvestigationBilling',json(?),'$.chargeDefinition',json(?)) WHERE service_id='synthetic-inpatient-wbc'`)
      .run(JSON.stringify(billing), JSON.stringify(chargeDefinition))
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')).json()
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: 'synthetic-inpatient-wbc', available: true, priceFen: 1300 }))
    const candidates = await (await s.request(s.doctor, '/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=synthetic-inpatient-wbc')).json()
    expect(candidates.items).toEqual([expect.objectContaining({ status: 'available', catalogItemId: 'synthetic-inpatient-wbc', laboratory: { indicationCodes: ['clinical-assessment'], priceFen: 1300 } })])
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } })
    expect(issued.status).toBe(200)
    const request = inpatientInvestigationsSchema.parse((await issued.json()).data).laboratoryRequests[0]!
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=version+1,
      config_json=json_set(config_json,'$.inpatientInvestigationBilling.priceFen',2300) WHERE service_id='synthetic-inpatient-wbc'`).run()
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, { requestId: request.id, expectedRequestVersion: request.version,
      serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })).status).toBe(200)
    await dispatchAll(s.runtime)
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    const charges = await (await s.request(cashier, `${s.path}/charges`)).json()
    expect(charges.charges).toMatchObject([{ kind: 'laboratory', sourceId: request.id, amountFen: 1300 }])
  })

  it.each(['missing-source', 'null', 'zero-price'])('住院收费定义 %s 非法时不回退到有效备用价目，也不能绕过目录开立', async invalid => {
    const s = await setup()
    const billing = { display: '住院合成白细胞计数', currency: 'CNY', priceFen: invalid === 'zero-price' ? 0 : 1300,
      id: 'synthetic-inpatient-wbc-charge', trigger: 'execution-completed', availableScopes: ['inpatient'],
      ...(invalid === 'missing-source' ? {} : { source: 'synthetic-read-write-regression' }) }
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET config_json=json_set(config_json,
      '$.inpatientInvestigationBilling',json(?)) WHERE service_id='synthetic-inpatient-wbc'`).run(JSON.stringify(invalid === 'null' ? null : billing))
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')).json()
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: 'synthetic-inpatient-wbc', available: false }))
    const candidates = await (await s.request(s.doctor, '/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=synthetic-inpatient-wbc')).json()
    expect(candidates.items).toEqual([expect.objectContaining({ status: 'incomplete', missingFields: expect.arrayContaining(['billing', 'price']) })])
    expect(candidates.items[0]).not.toHaveProperty('catalogItemId')
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } })
    expect(issued.status).toBe(409)
    expect((await issued.json()).error.code).toBe('INPATIENT_INVESTIGATION_UNAVAILABLE')
    const facts = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())
    expect(facts.laboratoryRequests).toEqual([])
  })

  it('单项缺单位或收费定义不阻断同页完整检验，写入拒绝绕过缺项', async () => {
    const s = await setup()
    s.runtime.database.driver.prepare(`INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json)
      SELECT workspace_id,epoch,'synthetic-complete-wbc','SYN-COMPLETE-WBC','合成完整白细胞','complete',1,1,
        json_set(config_json,'$.laboratoryService.id','synthetic-complete-wbc','$.billingUnit',json('{"display":"项目"}'))
      FROM hospital_service_catalog WHERE service_id='synthetic-inpatient-wbc'`).run()
    s.runtime.database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_set(config_json,'$.chargeDefinition',json('{}')) WHERE service_id='synthetic-unpriced-wbc'").run()
    s.runtime.database.driver.prepare("UPDATE hospital_service_catalog SET config_json=json_remove(config_json,'$.billingUnit') WHERE service_id='synthetic-inpatient-wbc'").run()
    const response = await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')
    expect(response.status).toBe(200)
    const catalog = await response.json()
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: 'synthetic-complete-wbc', available: true }))
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: 'synthetic-inpatient-wbc', available: false }))
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: 'synthetic-unpriced-wbc', available: false, unavailableReason: 'unpriced' }))
    const search = await s.request(s.doctor, `/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=${encodeURIComponent('白细胞')}`)
    expect(search.status).toBe(200)
    const candidates = (await search.json()).items
    expect(candidates).toContainEqual(expect.objectContaining({ id: 'synthetic-complete-wbc', status: 'available', catalogItemId: 'synthetic-complete-wbc' }))
    expect(candidates).toContainEqual(expect.objectContaining({ id: 'synthetic-inpatient-wbc', status: 'incomplete', missingFields: ['unit'] }))
    expect(candidates.find((item: { id: string }) => item.id === 'synthetic-unpriced-wbc').missingFields).toContain('price')
    const issue = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } })
    expect(issue.status).toBe(409)
    expect((await issue.json()).error.code).toBe('INPATIENT_INVESTIGATION_UNAVAILABLE')
  })

  it.each(['laboratory','imaging'] as const)('归档%s报告保持旧门诊入口责任403，正常住院确认原receipt仍无写重放',async kind=>{
    const s=await setup(),opDoctor=await signIn(s.runtime,'doctor@demo.clinmesh.local')
    const selection=kind==='laboratory'?{kind,catalogItemId:'synthetic-inpatient-wbc',indicationCode:'clinical-assessment'}:{kind,serviceId:'imaging-chest-radiograph',indication:'合成归档权限回归'}
    const issued=await s.request(s.doctor,`${s.path}/investigations/issue`,{encounterVersion:s.admission.versionId,catalogVersion:1,selection})
    expect(issued.status).toBe(200)
    const request=(await issued.json()).data[kind==='laboratory'?'laboratoryRequests':'imagingRequests'][0]
    expect((await s.request(s.nurse,`${s.path}/investigations/send`,{requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion})).status).toBe(200)
    await dispatchAll(s.runtime)
    const current=(await(await s.request(s.doctor,`${s.path}/investigations`)).json())[kind==='laboratory'?'laboratoryRequests':'imagingRequests'][0]
    const oldWrapper=()=>s.runtime.app.request(`/api/his/v1/${kind==='laboratory'?'laboratory':'imaging'}-requests/${current.id}/reports/${current.report.diagnosticReportId}/actions/acknowledge`,mutation(opDoctor,{expectedVersions:{[`DiagnosticReport/${current.report.diagnosticReportId}`]:current.report.diagnosticReportVersion},input:{expectedRequestVersion:current.version}}))
    const openDenied=await oldWrapper()
    expect(openDenied.status).toBe(403);expect((await openDenied.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    const input={requestId:current.id,expectedRequestVersion:current.version,serviceRequestVersion:current.serviceRequestVersion,taskVersion:current.taskVersion,diagnosticReportId:current.report.diagnosticReportId,diagnosticReportVersion:current.report.diagnosticReportVersion},key=randomUUID()
    const acknowledged=await s.request(s.doctor,`${s.path}/investigations/acknowledge`,input,key)
    expect(acknowledged.status).toBe(200)
    const receipt=await acknowledged.json()
    // 等价归档状态专测遗留公开入口；首页HTTP另行覆盖真实归档全过程。
    s.runtime.database.driver.prepare("UPDATE inpatient_admission SET record_status='archived' WHERE admission_id=?").run(s.admission.id)
    const archivedDenied=await oldWrapper()
    expect(archivedDenied.status).toBe(403);expect((await archivedDenied.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    expect(await(await s.request(s.doctor,`${s.path}/investigations/acknowledge`,input,key)).json()).toEqual(receipt)
    const newIntent=await s.request(s.doctor,`${s.path}/investigations/acknowledge`,input)
    expect(newIntent.status).toBe(409);expect((await newIntent.json()).error.code).toBe('INPATIENT_RECORD_ARCHIVED')
    expect((await(await s.request(s.doctor,`${s.path}/investigations`)).json())[kind==='laboratory'?'laboratoryRequests':'imagingRequests'][0].version).toBe(current.version+1)
  })

  it('病案来源指纹绑定完整报告修订链；无新增费用的管理员更正也受归档只读门禁', async () => {
    const s=await setup(),admin=await signIn(s.runtime)
    const issued=await s.request(s.doctor,`${s.path}/investigations/issue`,{encounterVersion:s.admission.versionId,catalogVersion:1,selection:{kind:'laboratory',catalogItemId:'synthetic-inpatient-wbc',indicationCode:'clinical-assessment'}})
    const request=(await issued.json()).data.laboratoryRequests[0]
    expect((await s.request(s.nurse,`${s.path}/investigations/send`,{requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion})).status).toBe(200)
    await dispatchAll(s.runtime)
    const before=await (await s.request(s.doctor,`${s.path}/record`)).json()
    expect((await s.request(s.doctor,`${s.path}/record/submit`,{expectedRevision:0,expectedSourcesHash:before.sourcesHash,mainProcedureExecutionId:null})).status).toBe(200)
    const reported=(await (await s.request(s.doctor,`${s.path}/investigations`)).json()).laboratoryRequests[0]
    const correct=async(current:typeof reported,key=randomUUID())=>s.runtime.app.request(`/api/his/v1/laboratory-requests/${current.id}/reports/${current.report.diagnosticReportId}/actions/correct`,{
      ...mutation(admin,{expectedVersions:{[`DiagnosticReport/${current.report.diagnosticReportId}`]:current.report.diagnosticReportVersion},input:{expectedRequestVersion:current.version,conclusion:'复核后白细胞计数在参考范围内',reason:'核对合成仪器结果',results:[{code:'6690-2',value:9.4}]}}),
      headers:{...mutation(admin,{}).headers,'idempotency-key':key},
    })
    expect((await correct(reported)).status).toBe(200)
    const after=await (await s.request(s.doctor,`${s.path}/record`)).json()
    expect(after.sourcesHash).not.toBe(before.sourcesHash)
    expect(after.snapshot.fees.chargesFen).toBe(before.snapshot.fees.chargesFen)
    expect(after.revision.sourcesHash).toBe(before.sourcesHash)
    const coder=await signIn(s.runtime,'medical-records@demo.clinmesh.local')
    expect((await s.request(coder,`${s.path}/record/review`,{expectedRevision:1,expectedSourcesHash:before.sourcesHash,outcome:'returned',reason:'旧来源不可继续审核'})).status).toBe(409)
    const current=(await (await s.request(s.doctor,`${s.path}/investigations`)).json()).laboratoryRequests[0]
    // 等价归档状态fixture专测已存在报告的非计费真实写入口；完整归档流程由record HTTP测试覆盖。
    s.runtime.database.driver.prepare("UPDATE inpatient_admission SET record_status='archived' WHERE admission_id=?").run(s.admission.id)
    const rejected=await correct(current)
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('INPATIENT_RECORD_ARCHIVED')
    const final=(await (await s.request(s.doctor,`${s.path}/investigations`)).json()).laboratoryRequests[0]
    expect(final).toEqual(current)
    expect((await s.request(s.doctor,`${s.path}/investigations/acknowledge`,{requestId:current.id,expectedRequestVersion:current.version,serviceRequestVersion:current.serviceRequestVersion,taskVersion:current.taskVersion,diagnosticReportId:current.report.diagnosticReportId,diagnosticReportVersion:current.report.diagnosticReportVersion})).status).toBe(409)
  })

  it('混合时区Virtual Time的多次住院检验与影像申请由复用owner按真实时点排序', async () => {
    const s = await setup(), admin = await signIn(s.runtime)
    const clock = await (await s.request(admin, '/api/sim/v1/scenario-runs/current')).json()
    const issue = async (kind: 'laboratory' | 'imaging') => {
      const selection = kind === 'laboratory' ? { kind, catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } : { kind, serviceId: 'imaging-chest-radiograph', indication: '合成申请时序评估' }
      const response = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1, selection })
      expect(response.status).toBe(200)
      const facts = inpatientInvestigationsSchema.parse((await response.json()).data)
      return (kind === 'laboratory' ? facts.laboratoryRequests : facts.imagingRequests).find(request => request.status === 'issued')!
    }
    const firstLab = await issue('laboratory'), firstImage = await issue('imaging')
    for (const request of [firstLab, firstImage]) expect((await s.request(s.doctor, `${s.path}/investigations/cancel`, { requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })).status).toBe(200)
    const laterTime = new Date(Date.parse(clock.virtualTime) + 1).toISOString()
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: laterTime })).status).toBe(200)
    const laterLab = await issue('laboratory'), laterImage = await issue('imaging')
    const before = canonicalStateHash(s.runtime.database)
    const facts = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())
    expect.soft(facts.laboratoryRequests.map(request => request.id)).toEqual([firstLab.id, laterLab.id])
    expect.soft(facts.imagingRequests.map(request => request.id)).toEqual([firstImage.id, laterImage.id])
    for (const requests of [facts.laboratoryRequests, facts.imagingRequests]) {
      expect(requests.find(request => request.status === 'cancelled')?.authoredAt).toBe(clock.virtualTime)
      expect(requests.find(request => request.status === 'issued')?.authoredAt).toBe(laterTime)
    }
    expect(canonicalStateHash(s.runtime.database)).toBe(before)
  })

  it('混合时区Virtual Time的转科历史与目标incoming按真实时点排序且读取不改事实', async () => {
    const s = await setup(), admin = await signIn(s.runtime)
    const clock = await (await s.request(admin, '/api/sim/v1/scenario-runs/current')).json()
    expect(clock.virtualTime).toMatch(/\+08:00$/)
    const second = inpatientCommandResponseSchema.parse(await (await s.request(s.registrar, '/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: s.visit.patientId, patientVersion: '1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
    })).json()).data.admission
    const requested = async (admissionId: string, encounterVersion: string) => {
      const response = await s.request(s.doctor, `/api/his/v1/inpatient/admissions/${admissionId}/transfers/request`, { encounterVersion, targetWardId: 'ward-surgery', reason: '合成时序转科' })
      expect(response.status).toBe(200)
      return inpatientTransferResponseSchema.parse(await response.json()).data.transfers.find(transfer => transfer.status === 'requested')!
    }
    const first = await requested(s.admission.id, s.admission.versionId)
    expect((await s.request(s.doctor, `${s.path}/transfers/cancel`, { encounterVersion: s.admission.versionId, transferId: first.id, expectedTransferVersion: first.version })).status).toBe(200)
    const tied = await requested(s.admission.id, s.admission.versionId)
    expect((await s.request(s.doctor, `${s.path}/transfers/cancel`, { encounterVersion: s.admission.versionId, transferId: tied.id, expectedTransferVersion: tied.version })).status).toBe(200)
    expect((await s.request(s.nurse, `/api/his/v1/inpatient/admissions/${second.id}/receive`, { encounterVersion: second.versionId, bedId: 'bed-general-2' })).status).toBe(200)
    const secondIncoming = await requested(second.id, '2')
    const laterTime = new Date(Date.parse(clock.virtualTime) + 1).toISOString()
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: laterTime })).status).toBe(200)
    const later = await requested(s.admission.id, s.admission.versionId)
    const targetNurse = await signIn(s.runtime, 'ward-nurse@demo.clinmesh.local')
    expect((await s.runtime.app.request('/api/auth/role', mutation(targetNurse, { practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }))).status).toBe(200)
    const before = canonicalStateHash(s.runtime.database)
    const history = inpatientTransferResponseSchema.shape.data.parse(await (await s.request(s.doctor, `${s.path}/transfers`)).json()).transfers
    const incoming = await (await s.request(targetNurse, '/api/his/v1/inpatient/transfers/incoming')).json()
    expect.soft(history.map(transfer => transfer.id)).toEqual([...[first.id, tied.id].sort(), later.id])
    expect.soft(incoming.items.map((item: { transfer: { id: string } }) => item.transfer.id)).toEqual([secondIncoming.id, later.id])
    expect(history.find(transfer => transfer.id === first.id)?.requestedAt).toBe(clock.virtualTime)
    expect(history.find(transfer => transfer.id === later.id)?.requestedAt).toBe(laterTime)
    expect(canonicalStateHash(s.runtime.database)).toBe(before)
  })

  it('混合时区Virtual Time的送检事实按真实时点排序并保留原始毫秒时间', async () => {
    const s = await setup(), admin = await signIn(s.runtime)
    const clock = await (await s.request(admin, '/api/sim/v1/scenario-runs/current')).json()
    const issueAndSend = async (selection: { kind: 'laboratory'; catalogItemId: string; indicationCode: string } | { kind: 'imaging'; serviceId: string; indication: string }) => {
      const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1, selection })
      expect(issued.status).toBe(200)
      const body = (await issued.json()).data, request = selection.kind === 'laboratory' ? body.laboratoryRequests[0] : body.imagingRequests[0]
      expect((await s.request(s.nurse, `${s.path}/investigations/send`, { requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })).status).toBe(200)
      return request.id
    }
    const first = await issueAndSend({ kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' })
    const laterTime = new Date(Date.parse(clock.virtualTime) + 1).toISOString()
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: clock.virtualTime, targetVirtualTime: laterTime })).status).toBe(200)
    const later = await issueAndSend({ kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '合成时序检查' })
    const before = canonicalStateHash(s.runtime.database)
    const facts = await (await s.request(s.nurse, `${s.path}/investigations`)).json()
    expect(facts.sent).toMatchObject([{ requestId: first, sentAt: clock.virtualTime }, { requestId: later, sentAt: laterTime }])
    expect(canonicalStateHash(s.runtime.database)).toBe(before)
  })

  it('未收口手术阻止转科交接，接收事务重查中途新申请并保留原床', async () => {
    const s = await setup()
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await s.request(s.doctor, '/api/his/v1/inpatient/surgery-catalog')).json())
    const procedure = catalog.procedures[0]!
    const requestSurgery = async () => {
      const response = await s.request(s.doctor, `${s.path}/surgeries/request`, {
        encounterVersion: s.admission.versionId, procedureId: procedure.id, catalogVersion: procedure.version,
        plannedFor: s.admission.admittedAt!, reason: '合成转科前待收口手术',
      })
      expect(response.status).toBe(200)
      return inpatientSurgeryResponseSchema.parse(await response.json()).data.requests.find(row => row.status === 'requested')!
    }
    const cancelSurgery = async (request: Awaited<ReturnType<typeof requestSurgery>>) => {
      expect((await s.request(s.doctor, `${s.path}/surgeries/cancel`, {
        requestId: request.id, expectedRequestVersion: request.version, note: '转科前明确取消待实施计划',
      })).status).toBe(200)
    }
    const firstSurgery = await requestSurgery()
    const requested = await s.request(s.doctor, `${s.path}/transfers/request`, {
      encounterVersion: s.admission.versionId, targetWardId: 'ward-surgery', reason: '合成外科评估',
    })
    expect(requested.status).toBe(200)
    const transfer = inpatientTransferResponseSchema.parse(await requested.json()).data.transfers[0]!
    const handover = { encounterVersion: s.admission.versionId, transferId: transfer.id, expectedTransferVersion: transfer.version }
    const blockedHandover = await s.request(s.nurse, `${s.path}/transfers/handover`, handover)
    expect(blockedHandover.status).toBe(409)
    expect(await blockedHandover.json()).toMatchObject({ error: { code: 'INPATIENT_SURGERY_PENDING' } })
    await cancelSurgery(firstSurgery)
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, handover)).status).toBe(200)

    const laterSurgery = await requestSurgery()
    const targetNurse = await signIn(s.runtime, 'ward-nurse@demo.clinmesh.local')
    expect((await s.runtime.app.request('/api/auth/role', mutation(targetNurse, { practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }))).status).toBe(200)
    const receive = { ...handover, expectedTransferVersion: transfer.version + 1, bedId: 'bed-surgery-1' }
    const blockedReceive = await s.request(targetNurse, `${s.path}/transfers/receive`, receive)
    expect(blockedReceive.status).toBe(409)
    expect(await blockedReceive.json()).toMatchObject({ error: { code: 'INPATIENT_SURGERY_PENDING' } })
    expect(inpatientDetailSchema.parse(await (await s.request(s.doctor, s.path)).json()).admission).toMatchObject({
      wardId: 'ward-general', organizationId: s.admission.organizationId, bedId: 'bed-general-1', versionId: s.admission.versionId,
    })
    const targetBeds = inpatientTransferCatalogSchema.parse(await (await s.request(targetNurse, '/api/his/v1/inpatient/transfer-catalog')).json()).beds
    expect(targetBeds.find(bed => bed.id === 'bed-surgery-1')?.available).toBe(true)
    await cancelSurgery(laterSurgery)
    expect((await s.request(targetNurse, `${s.path}/transfers/receive`, receive)).status).toBe(200)
    expect(inpatientDetailSchema.parse(await (await s.request(targetNurse, s.path)).json()).admission).toMatchObject({
      wardId: 'ward-surgery', organizationId: 'organization-inpatient-surgery', bedId: 'bed-surgery-1',
    })
    expect((await s.request(s.doctor, s.path)).status).toBe(403)
  })

  it('已送检影像缺失素材时不造报告，修复后按原申请重试且只收一次执行费', async () => {
    const s = await setup()
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '合成住院影像复查' } })
    const request = (await issued.json()).data.imagingRequests[0]
    const action = { requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion }
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, action)).status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/investigations/cancel`, action)).status).toBe(409)
    await rm(join(s.assetDirectory, 'installed', 'synthetic-inpatient-radiograph'), { recursive: true })
    await dispatchAll(s.runtime)
    const failed = (await (await s.request(s.doctor, `${s.path}/investigations`)).json()).imagingRequests[0]
    expect(failed.status).toBe('generation-failed')
    expect(failed).not.toHaveProperty('report')
    await repairImagingAssets({ assetDirectory: s.assetDirectory, catalogDirectory: s.catalogDirectory, assetIds: ['synthetic-inpatient-radiograph'] })
    expect((await s.request(s.doctor, `${s.path}/investigations/retry`, { requestId: failed.id, expectedRequestVersion: failed.version, serviceRequestVersion: failed.serviceRequestVersion, taskVersion: failed.taskVersion })).status).toBe(200)
    await dispatchAll(s.runtime)
    const reported = (await (await s.request(s.doctor, `${s.path}/investigations`)).json()).imagingRequests[0]
    expect(reported).toMatchObject({ id: request.id, status: 'reported' })
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    expect((await (await s.request(cashier, `${s.path}/charges`)).json()).charges).toMatchObject([{ kind: 'imaging', amountFen: 8000, sourceId: request.id }])
  })

  it('无合成来源的手工患者不能开立住院检查，不使用Scenario正常结果兜底', async () => {
    const s = await setup()
    const created = await s.runtime.app.request('/api/his/v1/patients', mutation(s.registrar, { expectedVersions: {}, input: { name: '合成无来源住院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }))
    expect(created.status).toBe(200)
    const patient = (await created.json()).data.patient
    const registered = inpatientCommandResponseSchema.parse(await (await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })).json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${registered.id}`
    const admitted = inpatientCommandResponseSchema.parse(await (await s.request(s.nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-2' })).json()).data.admission
    for (const selection of [{ kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' }, { kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '合成住院评估' }]) {
      expect((await s.request(s.doctor, `${path}/investigations/issue`, { encounterVersion: admitted.versionId, catalogVersion: 1, selection })).status).toBe(409)
    }
    await dispatchAll(s.runtime)
    expect(await (await s.request(s.doctor, `${path}/investigations`)).json()).toMatchObject({ laboratoryRequests: [], imagingRequests: [] })
  })

  it('全部住院检查与转科Cookie写入口拒绝缺失或恶意Origin且不产生事实', async () => {
    const s = await setup()
    for (const action of ['investigations/issue','investigations/send','investigations/cancel','investigations/retry','investigations/acknowledge','transfers/request','transfers/handover','transfers/receive','transfers/cancel']) {
      for (const origin of [undefined, 'https://evil.example']) {
        const response = await s.runtime.app.request(`${s.path}/${action}`, { method: 'POST', headers: { cookie: s.doctor,
          'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(origin === undefined ? {} : { origin }) }, body: JSON.stringify({ input: {} }) })
        expect(response.status, action).toBe(403)
      }
    }
    expect(await (await s.request(s.doctor, `${s.path}/investigations`)).json()).toMatchObject({ laboratoryRequests: [], imagingRequests: [], sent: [] })
    expect(await (await s.request(s.doctor, `${s.path}/transfers`)).json()).toMatchObject({ transfers: [] })
  })

  it('未计价不等于免费：未声明住院价格的零价服务不可开立', async () => {
    const s = await setup()
    const catalog = await (await s.request(s.doctor, '/api/his/v1/inpatient/investigation-catalog')).json()
    expect(catalog.items.find((item: { id: string }) => item.id === 'synthetic-unpriced-wbc')).toMatchObject({ available: false, unavailableReason: 'unpriced' })
    expect((await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-unpriced-wbc', indicationCode: 'clinical-assessment' } })).status).toBe(409)
  })

  it('未送检申请与未核停医嘱阻断交接，显式取消和核停后可交接，接收再次核对阻塞和床位', async () => {
    const s = await setup()
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } })
    const investigation = (await issued.json()).data.laboratoryRequests[0]
    const orderResponse = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    const order = (await orderResponse.json()).data.orders[0]
    const requested = await s.request(s.doctor, `${s.path}/transfers/request`, { encounterVersion: s.admission.versionId, targetWardId: 'ward-surgery', reason: '转外科评估' })
    const transfer = (await requested.json()).data.transfers[0]
    const handover = { encounterVersion: s.admission.versionId, transferId: transfer.id, expectedTransferVersion: transfer.version }
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, handover)).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/orders/request-stop`, { orderId: order.id, expectedOrderVersion: order.version, reason: '转科前停止' })).status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, handover)).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/orders/verify-stop`, { orderId: order.id, expectedOrderVersion: order.version + 1 })).status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, handover)).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/investigations/cancel`, { requestId: investigation.id, expectedRequestVersion: investigation.version,
      serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion })).status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, handover)).status).toBe(200)
    const targetNurse = await signIn(s.runtime, 'ward-nurse@demo.clinmesh.local')
    await s.runtime.app.request('/api/auth/role', mutation(targetNurse, { practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }))
    const receive = { ...handover, expectedTransferVersion: transfer.version + 1, bedId: 'bed-general-2' }
    expect((await s.request(targetNurse, `${s.path}/transfers/receive`, receive)).status).toBe(409)
    const later = await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary', selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 } })
    expect(later.status).toBe(200)
    expect((await s.request(targetNurse, `${s.path}/transfers/receive`, { ...receive, bedId: 'bed-surgery-1' })).status).toBe(409)
    expect((await (await s.request(s.doctor, s.path)).json()).admission.bedId).toBe('bed-general-1')
  })

  it('78旧库非空申请、草稿、报告确认、快照、回执与outbox保真迁移，失败回滚并恢复外键', async () => {
    const s = await setup(), opDoctor = s.visit.doctor
    const save = await s.runtime.app.request(`/api/his/v1/encounters/${s.visit.encounterId}/imaging-request/draft`, mutation(opDoctor, { expectedVersions: { [`Encounter/${s.visit.encounterId}`]: '3' }, input: { expectedDraftVersion: 0, serviceId: 'imaging-chest-radiograph', indication: '合成门诊存量检查' } }, 'PUT'))
    expect(save.status).toBe(200)
    const issue = await s.runtime.app.request(`/api/his/v1/encounters/${s.visit.encounterId}/imaging-request/actions/issue`, mutation(opDoctor, { expectedVersions: { [`Encounter/${s.visit.encounterId}`]: '3' }, input: { expectedDraftVersion: 1 } }))
    expect(issue.status).toBe(200)
    await dispatchAll(s.runtime)
    const detail = await (await s.request(opDoctor, `/api/his/v1/doctor/cases/${s.visit.outpatientCaseId}`)).json()
    const request = detail.imagingRequests.requests[0]
    expect((await s.runtime.app.request(`/api/his/v1/imaging-requests/${request.id}/reports/${request.report.diagnosticReportId}/actions/acknowledge`, mutation(opDoctor, { expectedVersions: { [`DiagnosticReport/${request.report.diagnosticReportId}`]: '1' }, input: { expectedRequestVersion: request.version } }))).status).toBe(200)
    const labDraft = await s.runtime.app.request(`/api/his/v1/encounters/${s.visit.encounterId}/laboratory-request/draft`, mutation(opDoctor, { expectedVersions: { [`Encounter/${s.visit.encounterId}`]: '3' }, input: { expectedDraftVersion: 0, catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } }, 'PUT'))
    expect(labDraft.status).toBe(200)
    expect((await s.runtime.app.request(`/api/his/v1/encounters/${s.visit.encounterId}/laboratory-request/actions/issue`, mutation(opDoctor, { expectedVersions: { [`Encounter/${s.visit.encounterId}`]: '3' }, input: { expectedDraftVersion: 1 } }))).status).toBe(200)
    await dispatchAll(s.runtime)
    expect(await (await s.request(opDoctor, `/api/his/v1/doctor/cases/${s.visit.outpatientCaseId}`)).json()).toMatchObject({ laboratoryRequests: { requests: [{ status: 'reported', report: { results: [{ value: 7.2 }] } }] } })
    await s.runtime.close()
    const directory = join(s.directory, 'migration-copy'); await mkdir(directory)
    for (const file of (await readdir('drizzle')).filter(file => /^\d{4}_.+\.sql$/.test(file) && file < '0071_' && !['0069_registration-numbering.sql', '0070_doctor-recommendation-consolidation-stage.sql'].includes(file))) await copyFile(join('drizzle', file), join(directory, file))
    const database = openClinMeshDatabase({ databasePath: join(s.directory, 'old.sqlite'), busyTimeoutMs: 5000 })
    try {
      expect(applyMigrations(database, directory).schemaVersion).toBe(78)
      database.driver.pragma('foreign_keys=OFF'); database.driver.prepare('ATTACH DATABASE ? AS captured').run(join(s.directory, 'clinmesh.sqlite'))
      const tables = z.array(z.object({ name: z.string() })).parse(database.driver.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migration' ORDER BY name").all())
      database.driver.exec('BEGIN')
      for (const { name } of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`
        const columns = z.array(z.object({ name: z.string() })).parse(database.driver.pragma(`table_info(${quoted})`))
        const list = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(',')
        // 医保办岗位是 81 迁移新增，78 旧枚举不容纳；升级回归只搬 78 已有岗位行。
        const source = name === 'practitioner_role_binding' ? "(SELECT * FROM captured.practitioner_role_binding WHERE role_code NOT IN ('medical-insurance'))" : `captured.${quoted}`
        database.driver.exec(`INSERT OR REPLACE INTO ${quoted}(${list}) SELECT ${list} FROM ${source}`)
      }
      // 成员引用跟着岗位走：清掉指向未搬入岗位（81 新增枚举外）的成员行，保持旧库引用完整。
      database.driver.prepare(`DELETE FROM membership_practitioner_role WHERE (workspace_id,practitioner_role_id) NOT IN (SELECT workspace_id,practitioner_role_id FROM practitioner_role_binding)`).run()
      database.driver.exec('COMMIT'); database.driver.exec('DETACH DATABASE captured'); database.driver.pragma('foreign_keys=ON')
      const before = tables.map(({ name }) => ({ name, rows: database.driver.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }))
      const file = '0071_inpatient-investigations-transfer.sql', sql = await readFile(join('drizzle', file), 'utf8')
      await writeFile(join(directory, file), `${sql}\nSELECT * FROM missing_inpatient_migration_table;\n`)
      expect(() => applyMigrations(database, directory)).toThrow('missing_inpatient_migration_table')
      expect(database.diagnostics().foreignKeys).toBe(true)
      expect(database.driver.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get('clinical_request_context')).toBeUndefined()
      await writeFile(join(directory, file), sql)
      expect(applyMigrations(database, directory)).toEqual({ applied: [file], schemaVersion: 79 })
      for (const { name, rows } of before) expect(database.driver.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).toEqual(rows)
      expect(database.driver.pragma('foreign_key_check')).toEqual([])
      expect(database.driver.prepare('SELECT outpatient_case_id,admission_id FROM clinical_request_context WHERE case_id=?').get(s.visit.outpatientCaseId)).toEqual({ outpatient_case_id: s.visit.outpatientCaseId, admission_id: null })
      expect(() => database.driver.prepare('DELETE FROM clinical_request_context WHERE case_id=?').run(s.visit.outpatientCaseId)).toThrow(/FOREIGN KEY/)
    } finally { database.close() }
  })

  it('检验只读取固定来源事实，报告与标本归本次住院，目录价格在申请时冻结', async () => {
    const s = await setup()
    const candidates = await (await s.request(s.doctor, '/api/his/v1/inpatient/catalog-search?kind=laboratory&source=hospital&query=synthetic-inpatient-wbc')).json()
    expect(candidates.items).toEqual([expect.objectContaining({ status: 'available', laboratory: { indicationCodes: ['clinical-assessment'], priceFen: 800 } })])
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'laboratory', catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' } })
    expect(issued.status).toBe(200)
    const request = (await issued.json()).data.laboratoryRequests[0]
    s.runtime.database.driver.prepare(`UPDATE hospital_service_catalog SET version=version+1,
      config_json=json_set(config_json,'$.chargeDefinition.priceFen',1800) WHERE service_id='synthetic-inpatient-wbc'`).run()
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: s.admission.versionId, duration: 'temporary', selection: { kind: 'service', serviceId: 'synthetic-inpatient-wbc', serviceVersion: 1, quantity: 1 } })).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/executions/complete`, { executionId: request.taskId, expectedExecutionVersion: 1 })).status).toBe(404)
    expect((await dispatchAll(s.runtime)).filter(kind => kind.startsWith('laboratory.'))).toEqual([])
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, { requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion })).status).toBe(200)
    await dispatchAll(s.runtime)
    const after = await (await s.request(s.doctor, `${s.path}/investigations`)).json()
    expect(after.laboratoryRequests[0]).toMatchObject({ status: 'reported', report: { results: [{ value: 7.2 }] } })
    const report = await (await s.request(s.doctor, `/fhir/R5/DiagnosticReport/${after.laboratoryRequests[0].report.diagnosticReportId}`)).json()
    expect(report.encounter.reference).toBe(`Encounter/${s.admission.id}`)
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    const ledger = await (await s.request(cashier, `${s.path}/charges`)).json()
    expect(ledger.charges).toMatchObject([{ kind: 'laboratory', sourceId: request.id, amountFen: 800 }])
  })

  it('转科经过原护士交接和目标护士接收，在途报告跟随住院，当前责任与费用归属一起切换', async () => {
    const s = await setup()
    const targetNurse = await signIn(s.runtime, 'ward-nurse@demo.clinmesh.local')
    const targetDoctor = await signIn(s.runtime, 'inpatient-doctor@demo.clinmesh.local')
    for (const [cookie, role] of [[targetNurse, 'ward-nurse'], [targetDoctor, 'inpatient-doctor']]) expect((await s.runtime.app.request('/api/auth/role', mutation(cookie!, { practitionerRoleId: `practitioner-role-${role}-surgery` }))).status).toBe(200)
    expect((await s.request(targetNurse, s.path)).status).toBe(403)
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '咳嗽两周，评估肺部情况' } })
    const investigation = (await issued.json()).data.imagingRequests[0]
    await s.request(s.nurse, `${s.path}/investigations/send`, { requestId: investigation.id, expectedRequestVersion: investigation.version, serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion })
    const requested = await s.request(s.doctor, `${s.path}/transfers/request`, { encounterVersion: s.admission.versionId, targetWardId: 'ward-surgery', reason: '转外科进一步评估' })
    expect(requested.status).toBe(200)
    const transfer = (await requested.json()).data.transfers[0]
    const receive = { transferId: transfer.id, expectedTransferVersion: transfer.version, encounterVersion: s.admission.versionId, bedId: 'bed-surgery-1' }
    expect((await s.request(targetNurse, `${s.path}/transfers/receive`, receive)).status).toBe(409)
    const incoming = await (await s.request(targetNurse, '/api/his/v1/inpatient/transfers/incoming')).json()
    expect(incoming.items).toHaveLength(1)
    expect(incoming.items[0]).not.toHaveProperty('chargesFen')
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, { transferId: transfer.id, expectedTransferVersion: transfer.version, encounterVersion: s.admission.versionId })).status).toBe(200)
    expect((await s.request(s.nurse, `${s.path}/transfers/receive`, { ...receive, expectedTransferVersion: transfer.version + 1 })).status).toBe(403)
    const received = await s.request(targetNurse, `${s.path}/transfers/receive`, { ...receive, expectedTransferVersion: transfer.version + 1 })
    expect(received.status).toBe(200)
    expect((await s.request(s.doctor, s.path)).status).toBe(403)
    expect((await s.request(s.nurse, `${s.path}/investigations`)).status).toBe(403)
    const current = await (await s.request(targetDoctor, s.path)).json()
    expect(current.admission).toMatchObject({ id: s.admission.id, wardId: 'ward-surgery', organizationId: 'organization-inpatient-surgery', bedId: 'bed-surgery-1' })
    await dispatchAll(s.runtime)
    const after = await (await s.request(targetDoctor, `${s.path}/investigations`)).json()
    expect(after.imagingRequests[0].status).toBe('reported')
    const studyId = after.imagingRequests[0].report.studyId
    expect((await s.request(s.doctor, `/api/his/v1/imaging-studies/${studyId}`)).status).toBe(403)
    expect((await s.request(targetDoctor, `/api/his/v1/imaging-studies/${studyId}`)).status).toBe(200)
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    const charges = await (await s.request(cashier, `${s.path}/charges`)).json()
    expect(charges.charges.filter((charge: { kind: string }) => charge.kind === 'imaging')).toMatchObject([{ organizationId: 'organization-inpatient-surgery' }])
    const encounter = await (await s.request(targetDoctor, `/fhir/R5/Encounter/${s.admission.id}`)).json()
    expect(encounter.serviceProvider.reference).toBe('Organization/organization-inpatient-surgery')
    expect(encounter.location).toMatchObject([{ status: 'completed', location: { reference: 'Location/bed-general-1' } }, { status: 'active', location: { reference: 'Location/bed-surgery-1' } }])
    const reported = after.imagingRequests[0], key = randomUUID(), input = { requestId: reported.id, expectedRequestVersion: reported.version,
      serviceRequestVersion: reported.serviceRequestVersion, taskVersion: reported.taskVersion,
      diagnosticReportId: reported.report.diagnosticReportId, diagnosticReportVersion: reported.report.diagnosticReportVersion }
    const acknowledged = await s.request(targetDoctor, `${s.path}/investigations/acknowledge`, input, key)
    expect(acknowledged.status).toBe(200)
    // 测试运行后安装的合成检验目录先完成与启动相同的计价补齐。
    s.runtime.laboratoryServicePublisher.ensureInpatientPrices()
    const receipt = await acknowledged.json(), before = canonicalStateHash(s.runtime.database)
    await s.runtime.close()
    const reopened = await createClinMeshRuntime(s.runtimeOptions)
    cleanups.unshift(async () => { await reopened.close() })
    expect(canonicalStateHash(reopened.database)).toBe(before)
    expect(await (await reopened.app.request(`${s.path}/investigations`, { headers: { cookie: targetDoctor } })).json()).toEqual(receipt.data)
    expect(await (await reopened.app.request(`${s.path}/charges`, { headers: { cookie: cashier } })).json()).toEqual(charges)
    const replay = await reopened.app.request(`${s.path}/investigations/acknowledge`, { ...mutation(targetDoctor, { input }),
      headers: { ...mutation(targetDoctor, {}).headers, 'idempotency-key': key } })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
    expect(canonicalStateHash(reopened.database)).toBe(before)
    expect((await reopened.app.request(s.path, { headers: { cookie: s.doctor } })).status).toBe(403)
  })

  it('医生开立后等待护士送检，复用 RIS 发布本次 IMP 报告并只计一次执行费', async () => {
    const s = await setup()
    expect((await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 999,
      selection: { kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '咳嗽两周，评估肺部情况' } })).status).toBe(409)
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: { kind: 'imaging', serviceId: 'imaging-chest-radiograph', indication: '咳嗽两周，评估肺部情况' } })
    expect(issued.status).toBe(200)
    const request = (await issued.json()).data.imagingRequests[0]
    expect(request.status).toBe('issued')
    expect((await dispatchAll(s.runtime)).filter(kind => kind.startsWith('imaging.'))).toEqual([])
    const before = await (await s.request(s.doctor, `${s.path}/investigations`)).json()
    expect(before.imagingRequests[0]).not.toHaveProperty('report')
    const send = { requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion }
    expect((await s.request(s.doctor, `${s.path}/investigations/send`, send)).status).toBe(403)
    const key = randomUUID()
    const sent = await s.request(s.nurse, `${s.path}/investigations/send`, send, key)
    expect(sent.status).toBe(200)
    await dispatchAll(s.runtime)
    const after = await (await s.request(s.doctor, `${s.path}/investigations`)).json()
    expect(after.imagingRequests[0].status).toBe('reported')
    const reportId = after.imagingRequests[0].report.diagnosticReportId
    const report = await (await s.request(s.doctor, `/fhir/R5/DiagnosticReport/${reportId}`)).json()
    expect(report.encounter.reference).toBe(`Encounter/${s.admission.id}`)
    expect(report.encounter.reference).not.toBe(`Encounter/${s.visit.encounterId}`)
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, send, key)).status).toBe(200)
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    const charges = await (await s.request(cashier, `${s.path}/charges`)).json()
    expect(charges.charges.filter((charge: { kind: string }) => charge.kind === 'imaging')).toMatchObject([{ amountFen: 8000, sourceId: request.id }])
    expect((await s.request(cashier, `${s.path}/investigations`)).status).toBe(403)
    const currentRequest = after.imagingRequests[0]
    const acknowledged = await s.request(s.doctor, `${s.path}/investigations/acknowledge`, { requestId: currentRequest.id, expectedRequestVersion: currentRequest.version,
      serviceRequestVersion: currentRequest.serviceRequestVersion, taskVersion: currentRequest.taskVersion,
      diagnosticReportId: currentRequest.report.diagnosticReportId, diagnosticReportVersion: currentRequest.report.diagnosticReportVersion })
    expect(acknowledged.status).toBe(200)
    expect((await acknowledged.json()).data.imagingRequests[0].status).toBe('acknowledged')
    expect((await s.request(s.doctor,`${s.path}/record`)).status).toBe(200)
  })
})
