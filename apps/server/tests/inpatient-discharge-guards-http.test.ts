import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientTransferResponseSchema } from '@clinmesh/contracts/inpatient-transfer'
import { InpatientBilling } from '../src/application/inpatient-billing.ts'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { laboratoryServiceSnapshotSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import { acuteBronchitis, caseBundle, createImagingRuntime, generateCase, mutation, prepareImaging, signIn, snomed, startConsultation } from './fixtures/imaging-scenario.ts'

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
    .run(context.workspaceId, context.epoch, service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service, availableScopes: ['outpatient','inpatient'], chargeDefinition: { id: 'synthetic-wbc-charge-definition', currency: 'CNY', priceFen: 800 } }))
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

describe('住院出院跨检查与转科门禁', () => {
  it('待送检申请阻断出院；取消后可继续，待出院不能新开检查或转科', async () => {
    const s = await setup(), issued = await issueLab(s)
    const input = { encounterVersion:s.admission.versionId,reason:'出院核对' }
    const blocked = await s.request(s.doctor, `${s.path}/discharge/issue`, input)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({error:{code:'INPATIENT_INVESTIGATION_PENDING'}})
    expect((await s.request(s.doctor, `${s.path}/investigations/cancel`, actionInput(issued))).status).toBe(200)
    const discharge = await s.request(s.doctor, `${s.path}/discharge/issue`, input)
    expect(discharge.status).toBe(200)
    const admission = inpatientDischargeResponseSchema.parse(await discharge.json()).data.admission
    expect((await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion:admission.versionId,catalogVersion:1,
      selection:{kind:'laboratory',catalogItemId:'synthetic-inpatient-wbc',indicationCode:'clinical-assessment'} })).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/transfers/request`, { encounterVersion:admission.versionId,targetWardId:'ward-surgery',reason:'待出院禁止新转科' })).status).toBe(409)
  })

  it('申请及交接中的转科阻断出院，明确取消后才可继续', async () => {
    const s = await setup()
    const transferResponse = await s.request(s.doctor, `${s.path}/transfers/request`, { encounterVersion:s.admission.versionId,targetWardId:'ward-surgery',reason:'合成专科评估' })
    expect(transferResponse.status).toBe(200)
    const transfer = inpatientTransferResponseSchema.parse(await transferResponse.json()).data.transfers[0]!
    const input = { encounterVersion:s.admission.versionId,reason:'出院核对' }
    const blocked = await s.request(s.doctor, `${s.path}/discharge/issue`, input)
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({error:{code:'INPATIENT_TRANSFER_PENDING'}})
    expect((await s.request(s.nurse, `${s.path}/transfers/handover`, { encounterVersion:s.admission.versionId,transferId:transfer.id,expectedTransferVersion:transfer.version })).status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/discharge/issue`, input)).status).toBe(409)
    expect((await s.request(s.doctor, `${s.path}/transfers/cancel`, { encounterVersion:s.admission.versionId,transferId:transfer.id,expectedTransferVersion:transfer.version+1 })).status).toBe(200)
    expect((await s.request(s.doctor, `${s.path}/discharge/issue`, input)).status).toBe(200)
  })
  it('已受理及执行中阻断出院，报告与费用原子完成后未阅可结算；封账拒绝首次迟到费用', async () => {
    const s = await setup(), cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    await dispatchAll(s.runtime)
    const request = await issueLab(s)
    expect((await s.request(s.nurse, `${s.path}/investigations/send`, actionInput(request))).status).toBe(200)
    const discharge = { encounterVersion:s.admission.versionId,reason:'合成检查完成后出院' }
    for (const [eventKind,status] of [['laboratory.accept-request','accepted'],['laboratory.start-request','in-progress']] as const) {
      const event = await s.runtime.dispatcher.dispatchOnce()
      expect(event?.kind).toBe(eventKind)
      const pending = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json()).laboratoryRequests[0]!
      expect(pending.status).toBe(status)
      expect((await s.request(s.doctor, `${s.path}/discharge/issue`, discharge)).status).toBe(409)
      const ledger = inpatientChargesSchema.parse(await (await s.request(cashier, `${s.path}/charges`)).json())
      expect(ledger.charges).toEqual([])
    }
    const completion = await s.runtime.dispatcher.dispatchOnce()
    expect(completion?.kind).toBe('laboratory.report-request')
    const reported = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json()).laboratoryRequests[0]!
    expect(reported.status).toBe('reported')
    expect(reported.report?.results[0]).toMatchObject({value:7.2})
    const ledger = inpatientChargesSchema.parse(await (await s.request(cashier, `${s.path}/charges`)).json())
    expect(ledger.charges).toHaveLength(1)
    expect(ledger.chargesFen).toBe(800)
    const issue = await s.request(s.doctor, `${s.path}/discharge/issue`, discharge)
    expect(issue.status).toBe(200)
    const issued = inpatientDischargeResponseSchema.parse(await issue.json()).data.admission
    const departure = await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion:issued.versionId,reason:'护士出区核对',departureMethod:'home' })
    expect(departure.status).toBe(200)
    const preview = inpatientSettlementPreviewSchema.parse(await (await s.request(cashier, `${s.path}/discharge/preview`)).json())
    expect(preview.chargesFen).toBe(800)
    const settled = await s.request(cashier, `${s.path}/discharge/settle`, { encounterVersion:preview.encounterVersion,fingerprint:preview.fingerprint,
      expectedChargesFen:preview.chargesFen,expectedBalanceFen:preview.balanceFen })
    expect(settled.status).toBe(200)
    const beforeLate = inpatientSettlementResponseSchema.parse(await settled.json()).data
    const context = await s.runtime.identity.resolveRequestActor(new Headers({cookie:cashier}),'GET',`${s.path}/charges`)
    const billing = new InpatientBilling(s.runtime.database,s.runtime.fhir)
    s.runtime.database.driver.exec('BEGIN IMMEDIATE')
    try {
      expect(() => billing.record(context,{admissionId:s.admission.id,organizationId:s.admission.organizationId,kind:'laboratory',sourceId:randomUUID(),
        serviceDate:'2026-08-24',amountFen:800,virtualTime:'2026-08-24T09:00:00+08:00',label:'合成首次迟到执行费'},[])).toThrow('已结算住院账户不能新增费用')
    } finally { s.runtime.database.driver.exec('ROLLBACK') }
    expect(inpatientSettlementPreviewSchema.parse(await (await s.request(cashier, `${s.path}/discharge/preview`)).json())).toEqual(beforeLate)
    expect(inpatientDetailSchema.parse(await (await s.request(s.doctor,s.path)).json()).admission.financialStatus).toBe('settled')
  })

})

async function issueLab(s: Awaited<ReturnType<typeof setup>>) {
  const response = await s.request(s.doctor, `${s.path}/investigations/issue`, { encounterVersion:s.admission.versionId,catalogVersion:1,
    selection:{kind:'laboratory',catalogItemId:'synthetic-inpatient-wbc',indicationCode:'clinical-assessment'} })
  expect(response.status).toBe(200)
  return inpatientInvestigationResponseSchema.parse(await response.json()).data.laboratoryRequests[0]!
}
function actionInput(request: Awaited<ReturnType<typeof issueLab>>) {
  return { requestId:request.id,expectedRequestVersion:request.version,serviceRequestVersion:request.serviceRequestVersion,taskVersion:request.taskVersion }
}
