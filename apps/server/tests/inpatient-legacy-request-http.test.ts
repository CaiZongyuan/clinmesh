import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
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
  return { ...created, request, doctor, nurse, registrar, admission, path, visit, context }
}

type Kind = 'laboratory' | 'imaging'

function draftInput(kind: Kind, expectedDraftVersion: number) {
  return kind === 'laboratory'
    ? { expectedDraftVersion, catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' }
    : { expectedDraftVersion, serviceId: 'imaging-chest-radiograph', indication: '合成旧入口检查' }
}

async function saveOutpatientDraft(s: Awaited<ReturnType<typeof setup>>, kind: Kind) {
  const response = await s.runtime.app.request(`/api/his/v1/encounters/${s.visit.encounterId}/${kind}-request/draft`, mutation(s.visit.doctor, {
    expectedVersions: { [`Encounter/${s.visit.encounterId}`]: '3' }, input: draftInput(kind, 0),
  }, 'PUT'))
  expect(response.status).toBe(200)
}

// 异常持久事实 fixture：升级前旧入口遗留的住院草稿，不代表允许创建它的产品入口。
function installLegacyInpatientDraft(s: Awaited<ReturnType<typeof setup>>, kind: Kind) {
  if (kind === 'laboratory') {
    s.runtime.database.driver.prepare(`INSERT INTO laboratory_request_state
      SELECT workspace_id,epoch,?,version,draft_catalog_item_id,draft_indication_code,draft_reference_json,updated_by,updated_at,draft_service_snapshot_json
      FROM laboratory_request_state WHERE workspace_id=? AND epoch=? AND case_id=?`)
      .run(s.admission.id, s.context.workspaceId, s.context.epoch, s.visit.outpatientCaseId)
  } else {
    s.runtime.database.driver.prepare(`INSERT INTO imaging_request_state
      SELECT workspace_id,epoch,?,version,draft_service_id,draft_indication,draft_service_snapshot_json,updated_by,updated_at
      FROM imaging_request_state WHERE workspace_id=? AND epoch=? AND case_id=?`)
      .run(s.admission.id, s.context.workspaceId, s.context.epoch, s.visit.outpatientCaseId)
  }
}

describe('旧门诊检查入口的住院授权边界', () => {
  it.each([
    ['laboratory', 'save'], ['laboratory', 'issue'], ['imaging', 'save'], ['imaging', 'issue'],
  ] as const)('住院医生不能通过旧 %s %s 入口写入检查', async (kind, action) => {
    const s = await setup()
    if (action === 'issue') {
      await saveOutpatientDraft(s, kind)
      installLegacyInpatientDraft(s, kind)
    }
    const response = await s.runtime.app.request(`/api/his/v1/encounters/${s.admission.id}/${kind}-request/${action === 'save' ? 'draft' : 'actions/issue'}`, mutation(s.doctor, {
      expectedVersions: { [`Encounter/${s.admission.id}`]: s.admission.versionId },
      input: action === 'save' ? draftInput(kind, 0) : { expectedDraftVersion: 1 },
    }, action === 'save' ? 'PUT' : 'POST'))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'ROLE_NOT_ALLOWED' } })
    expect(inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())).toMatchObject({ laboratoryRequests: [], imagingRequests: [], sent: [] })
  })

  it.each(['laboratory', 'imaging'] as const)('缺失送检关联的遗留住院 %s 申请不能被系统受理', async kind => {
    const s = await setup()
    const issued = await s.request(s.doctor, `${s.path}/investigations/issue`, {
      encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: kind === 'laboratory'
        ? { kind, catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' }
        : { kind, serviceId: 'imaging-chest-radiograph', indication: '合成住院检查' },
    })
    expect(issued.status).toBe(200)
    const investigation = inpatientInvestigationsSchema.parse((await issued.json()).data)[kind === 'laboratory' ? 'laboratoryRequests' : 'imagingRequests'][0]!
    const sent = await s.request(s.nurse, `${s.path}/investigations/send`, {
      requestId: investigation.id, expectedRequestVersion: investigation.version,
      serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion,
    })
    expect(sent.status).toBe(200)
    // 模拟升级前孤立申请及晚到事件；生产入口没有删除送检关联的能力。
    s.runtime.database.driver.prepare('DELETE FROM inpatient_investigation WHERE workspace_id=? AND epoch=? AND request_id=?')
      .run(s.context.workspaceId, s.context.epoch, investigation.id)

    expect(await s.runtime.dispatcher.dispatchOnce({ kinds: [`${kind}.accept-request`] })).toMatchObject({ status: 'failed' })
    expect(await s.runtime.dispatcher.dispatchOnce({ kinds: [`${kind}.start-request`, `${kind}.report-request`] })).toBeUndefined()
    const current = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())[kind === 'laboratory' ? 'laboratoryRequests' : 'imagingRequests'][0]!
    expect(current).toMatchObject({ id: investigation.id, status: 'issued', version: 1, taskVersion: investigation.taskVersion })
    expect(current.report).toBeUndefined()
    const task = fhirResourceSchema.parse(await (await s.request(s.doctor, `/fhir/R5/Task/${investigation.taskId}`)).json())
    expect(task.status).toBe('requested')
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    expect(await (await s.request(cashier, `${s.path}/charges`)).json()).toMatchObject({ charges: [] })
  })

  it.each(['laboratory', 'imaging'] as const)('正确住院 %s 入口仍可开立、送检、报告且重放只记一次费用', async kind => {
    const s = await setup()
    const key = randomUUID()
    const input = {
      encounterVersion: s.admission.versionId, catalogVersion: 1,
      selection: kind === 'laboratory'
        ? { kind, catalogItemId: 'synthetic-inpatient-wbc', indicationCode: 'clinical-assessment' }
        : { kind, serviceId: 'imaging-chest-radiograph', indication: '合成住院检查' },
    }
    const issue = () => s.request(s.doctor, `${s.path}/investigations/issue`, input, key)
    const issued = await issue()
    expect(issued.status).toBe(200)
    const receipt = await issued.json()
    expect(await (await issue()).json()).toEqual(receipt)
    const investigation = inpatientInvestigationsSchema.parse(receipt.data)[kind === 'laboratory' ? 'laboratoryRequests' : 'imagingRequests'][0]!
    const sendKey = randomUUID()
    const send = () => s.request(s.nurse, `${s.path}/investigations/send`, {
      requestId: investigation.id, expectedRequestVersion: investigation.version,
      serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion,
    }, sendKey)
    expect((await send()).status).toBe(200)
    for (const action of ['accept', 'start', 'report']) {
      expect(await s.runtime.dispatcher.dispatchOnce({ kinds: [`${kind}.${action}-request`] })).toMatchObject({ status: 'completed' })
    }
    expect((await send()).status).toBe(200)
    expect(await s.runtime.dispatcher.dispatchOnce({ kinds: [`${kind}.accept-request`] })).toBeUndefined()
    const current = inpatientInvestigationsSchema.parse(await (await s.request(s.doctor, `${s.path}/investigations`)).json())[kind === 'laboratory' ? 'laboratoryRequests' : 'imagingRequests'][0]!
    expect(current).toMatchObject({ id: investigation.id, status: 'reported' })
    expect(current.report).toBeDefined()
    const cashier = await signIn(s.runtime, 'cashier@demo.clinmesh.local')
    expect((await (await s.request(cashier, `${s.path}/charges`)).json()).charges).toMatchObject([
      { kind, sourceId: investigation.id, amountFen: kind === 'laboratory' ? 800 : 8000 },
    ])
  })
})
