import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { commandResponseSchema, createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema,
  inpatientPharmacySchema, inpatientPharmacyResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDischargeResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientPciDataResponseSchema, pciCaseSourceResponseSchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { patientPersonaRevisionSchema, syntheticCaseInstanceSchema } from '@clinmesh/contracts/scenario'
import { referenceDataReleaseListSchema } from '@clinmesh/contracts/reference-data'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../../src/runtime.ts'
import { prepareDrgRulesPackage } from '../../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { runReferenceDatabaseCli } from '../../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../src/application/scenario-data/medical-service-snapshot.ts'

/** Public provenance for four independently checked inputs; this is a hand-written acceptance slice, not the full grouper. */
export const pciChsEvidence = {
  sourceUrl: 'https://www.opendrg.cn/demo/drg/ce/3258.b47bba5f.js',
  sourceSha256: '70c00d9ef9b02c1556b8a96ece350f6ce3d1fd2b6f9dd8ea80c2ec7d2ba0f0ff',
  inputs: [
    { diagnosis: 'I25.103', operation: null, drgCode: 'FR59' },
    { diagnosis: 'I25.103', operation: '36.0700', drgCode: 'FM39' },
    { diagnosis: 'I50.900', operation: null, drgCode: 'FR25' },
    { diagnosis: 'J18.900', operation: null, drgCode: 'ES45' },
  ],
  scope: 'Fixed adult cases without a secondary CC/MCC; no complete CHS-DRG, combination-operation or age-branch coverage.',
}

export const pciAcceptanceGroups = [
  { level: 'MDC', code: 'MDCF', name: '循环系统疾病及功能障碍', parentCode: null },
  { level: 'MDC', code: 'MDCE', name: '呼吸系统疾病及功能障碍', parentCode: null },
  { level: 'ADRG', code: 'FR5', name: '冠状动脉粥样硬化/血栓/闭塞', parentCode: 'MDCF' },
  { level: 'DRG', code: 'FR59', name: '冠状动脉粥样硬化/血栓/闭塞', parentCode: 'FR5' },
  { level: 'ADRG', code: 'FM3', name: '经皮冠状动脉支架植入', parentCode: 'MDCF' },
  { level: 'DRG', code: 'FM39', name: '经皮冠状动脉支架植入', parentCode: 'FM3' },
  { level: 'ADRG', code: 'FM5', name: '合成冠脉造影阶段', parentCode: 'MDCF' },
  { level: 'DRG', code: 'FM59', name: '合成冠脉造影终端', parentCode: 'FM5' },
  { level: 'ADRG', code: 'FR2', name: '心力衰竭、休克', parentCode: 'MDCF' },
  { level: 'DRG', code: 'FR25', name: '心力衰竭、休克，不伴合并症或并发症', parentCode: 'FR2' },
  { level: 'ADRG', code: 'ES4', name: '呼吸系统感染/炎症', parentCode: 'MDCE' },
  { level: 'DRG', code: 'ES45', name: '呼吸系统感染/炎症，不伴合并症或并发症', parentCode: 'ES4' },
]

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const clinicalConcepts = [
  { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
  { code: 'I50.900', display: '心力衰竭', row: 13195 },
  { code: 'J18.900', display: '肺炎', row: 14680 },
  { code: 'I10.x09', display: '高血压', row: 12457 },
].map(({ code, display, row }) => ({ id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`, domain: 'diagnosis',
  system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code, display, status: 'active',
  sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}` }))

export async function preparePciAcceptanceData(directory: string) {
  const referenceDatabasePath = join(directory, 'reference.sqlite'), drgRulesDirectory = join(directory, 'drg-rules')
  const externalReference = process.env.CLINMESH_TEST_REFERENCE_DATABASE
  const externalRelease = process.env.CLINMESH_TEST_REFERENCE_RELEASE_ID
  assert.equal(externalReference === undefined, externalRelease === undefined, 'Provide both the reference database and its active Release identity')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: clinicalConcepts,
    medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-pci-acceptance-reference', schemaVersion: '1', createdAt: '2026-10-25T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-pci-acceptance', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: hash(artifact),
      licenseId: 'CC0-1.0', retrievedAt: '2026-10-25T00:00:00.000Z', sourceUrl: 'https://example.test/clinmesh/pci-acceptance', upstreamVersion: '2022.r4-minimal-test-facts' }] }))
  if (externalReference === undefined) {
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  } else {
    // A closed/checkpointed reference snapshot is copied; acceptance never writes the operator's source database.
    await copyFile(externalReference, referenceDatabasePath)
  }
  // CI uses a self-authored program, never fragments of an executable upstream source.
  // The identical HTTP journey can explicitly consume a locally materialized full v2 package.
  if (process.env.CLINMESH_TEST_DRG_RULES_DIRECTORY) {
    const directory = process.env.CLINMESH_TEST_DRG_RULES_DIRECTORY
    assert.equal(hash(await readFile(join(directory, 'manifest.json'), 'utf8')), '23dcd363076bbf1956d62788698819d1693b457c2b383818f209b963b7cc9d44', 'Full PCI acceptance requires the pinned complete v2 package')
    return { referenceDatabasePath, drgRulesDirectory: directory }
  }
  await mkdir(drgRulesDirectory)
  const complicationTables = { CC: {}, MCC: {}, CCE: { 'I10.x09': 'synthetic' }, SS_VALID: ['36.0700', '88.5500'] }
  const jsText = `const CC={},MCC={},CCE={"I10.x09":"synthetic"},SS_VALID=["36.0700","88.5500"];
class Groups { FR59_group(x) { return true } FM39_group(x) { return true } FM59_group(x) { return true }
  FR25_group(x) { return true } ES45_group(x) { return true } }
function group_record(x) { return function(x) {
  if (["J18.900"].includes(x.zdList[0])) { Q('符合MDCE入组条件，匹配规则：合成输入'); Q('符合ES4入组条件，匹配规则：合成输入'); return (new Groups).ES45_group(x) ? 'ES45' : '' }
  Q('符合MDCF入组条件，匹配规则：合成输入');
  if (["36.0700"].includes(x.ssList[0])) { Q('符合FM3入组条件，匹配规则：合成主操作'); return (new Groups).FM39_group(x) ? 'FM39' : '' }
  if (["88.5500"].includes(x.ssList[0])) { Q('符合FM5入组条件，匹配规则：合成主操作'); return (new Groups).FM59_group(x) ? 'FM59' : '' }
  if (["I25.103"].includes(x.zdList[0])) { Q('符合FR5入组条件，匹配规则：合成输入'); return (new Groups).FR59_group(x) ? 'FR59' : '' }
  if (["I50.900"].includes(x.zdList[0])) { Q('符合FR2入组条件，匹配规则：合成输入'); return (new Groups).FR25_group(x) ? 'FR25' : '' }
  return '0000'
}(x) }`
  const files = prepareDrgRulesPackage({ groups: pciAcceptanceGroups, jsText, complicationTables,
    input: { openDrgJsSha256: hash(jsText), openDrgTablesSha256: hash(JSON.stringify(complicationTables)), r3GroupsSha256: hash(pciAcceptanceGroups.map(row => JSON.stringify(row)).join('\n') + '\n') },
    releaseId: 'clinmesh-pci-acceptance-synthetic-v2', sourceVersion: 'self-authored-five-stage-cases-v2' })
  for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content)
  return { referenceDatabasePath, drgRulesDirectory }
}

export async function parsePciResponse<T>(schema: z.ZodType<T>, response: Response): Promise<T> {
  assert.equal(response.status, 200, response.ok ? 'Expected HTTP 200' : await response.clone().text())
  return schema.parse(await response.json())
}

export async function preparePciPaymentDrgFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-payment-drg-'))
  const data = await preparePciAcceptanceData(directory), password = `Test-${randomUUID()}-Aa1!`
  let modelCalls = 0
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), ...data,
    activeReferenceReleaseId: process.env.CLINMESH_TEST_REFERENCE_RELEASE_ID ?? 'synthetic-pci-acceptance-reference', demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    investigationModel: 'synthetic-forbidden',
    chatCompletionsProvider: { completeJson: async () => { modelCalls += 1; throw new Error('Fixed PCI acceptance must never request a model') } } }
  return { directory, data, password, options, get modelCalls() { return modelCalls } }
}

export async function createPciPaymentDrgFixture(prepared: Awaited<ReturnType<typeof preparePciPaymentDrgFixture>>) {
  const { directory, data, password, options } = prepared
  let runtime = await createClinMeshRuntime(options)
  const cookies = new Map<string, string>()
  async function login(role: string) {
    const cached = cookies.get(role)
    if (cached !== undefined) return cached
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }) })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    cookies.set(role, cookie)
    return cookie
  }
  async function requestRaw(role: string, path: string, body: unknown, method = 'POST', key = randomUUID()) {
    return runtime.app.request(path, { method, headers: { cookie: await login(role), origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) })
  }
  async function request(role: string, path: string, input?: unknown, key = randomUUID(), expectedVersions?: Record<string, string>) {
    return input === undefined ? runtime.app.request(path, { headers: { cookie: await login(role) } })
      : requestRaw(role, path, { input, ...(expectedVersions === undefined ? {} : { expectedVersions }) }, 'POST', key)
  }
  const read = <T>(role: string, path: string, schema: z.ZodType<T>) => request(role, path).then(response => parsePciResponse(schema, response))
  async function admitSyntheticCase(codes: string[], bedId: string) {
    const patient = (await parsePciResponse(createPatientResponseSchema, await request('registrar', '/api/his/v1/patients', {
      name: '合成固定病组联合验收', gender: 'male', birthDate: '1966-05-20', identifier: `SYN-${randomUUID()}` }, randomUUID(), {}))).data.patient
    const registered = (await parsePciResponse(inpatientCommandResponseSchema, await request('registrar', '/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000 }))).data.admission
    const path = `/api/his/v1/inpatient/admissions/${registered.id}`
    const admission = (await parsePciResponse(inpatientCommandResponseSchema, await request('ward-nurse', `${path}/receive`, {
      encounterVersion: registered.versionId, bedId }))).data.admission
    const diagnosis = await parsePciResponse(inpatientFullClinicalResponseSchema, await request('inpatient-doctor', `${path}/diagnoses/confirm`, {
      encounterVersion: admission.versionId, expectedRevision: 0, entries: codes.map((code, index) => ({
        catalogItemId: clinicalConcepts.find(concept => concept.code === code)!.id,
        role: index === 0 ? 'primary' : 'secondary', admissionCondition: '1',
        note: code === 'I10.x09' ? '合并高血压，演示既有药品计量；不作为PCI抗栓方案' : '合成固定成人诊断',
      })) }))
    return { admissionId: registered.id, patientId: patient.id, path, encounterVersion: diagnosis.data.encounterVersion }
  }
  async function preparePciAdmission(materialIds = ['hospital-material-pci-stent', 'hospital-material-pci-balloon', 'hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter']) {
    await parsePciResponse(inpatientPciDataResponseSchema, await request('admin', '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' }))
    const source = (await parsePciResponse(pciCaseSourceResponseSchema, await request('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { expectedEpoch: 'epoch-1' }))).data
    const casePath = `/api/sim/v1/synthetic-cases/${source.case.caseId}`
    const persona = (await parsePciResponse(commandResponseSchema(patientPersonaRevisionSchema), await request('admin', `${casePath}/patient-persona-revisions`, { content: {
      chiefComplaint: '活动后胸闷三个月，加重一周，休息可缓解。', knownHistorySummary: '无已知药物过敏，静息无胸痛。', medicationMemory: '近期未自行加药。',
      openingStatement: '医生您好，最近一活动胸口就闷，休息后会好。', persona: { attitude: '愿意配合检查', character: '平和', healthLiteracy: '普通', speechStyle: '简短清楚' },
      symptomExperience: '步行数百米后胸口闷，停下休息几分钟会缓解，没有晕厥。',
    } }))).data
    const ready = (await parsePciResponse(commandResponseSchema(syntheticCaseInstanceSchema), await requestRaw('admin', `${casePath}/patient-persona-revisions/active`, {
      personaRevision: persona.revision, expectedCaseRevision: source.case.revision }, 'PUT'))).data
    const started = (await parsePciResponse(startSyntheticInpatientCaseResponseSchema, await requestRaw('registrar', `/api/his/v1/synthetic-cases/${source.case.caseId}/actions/start-inpatient-visit`, {
      activeBriefRevision: ready.activeBriefRevision, expectedCaseRevision: ready.revision, expectedEpoch: 'epoch-1', wardId: 'ward-general' }))).data
    const admissionPath = `/api/his/v1/inpatient/admissions/${started.admissionId}`
    const registered = await read('registrar', admissionPath, inpatientDetailSchema)
    const admission = (await parsePciResponse(inpatientCommandResponseSchema, await request('ward-nurse', `${admissionPath}/receive`, {
      encounterVersion: registered.admission.versionId, bedId: 'bed-general-1' }))).data.admission
    const diagnosis = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('inpatient-doctor', `${admissionPath}/diagnoses/confirm`, {
      encounterVersion: admission.versionId, expectedRevision: 0, entries: [{ catalogItemId: clinicalConcepts[0]!.id, role: 'primary', admissionCondition: '1', note: '本院医生确认固定合成冠心病' }] }))).data
    const deposit = (await parsePciResponse(inpatientPaymentPreviewResponseSchema, await request('cashier', `${admissionPath}/payments/preview`, {
      kind: 'deposit', amountFen: 5000, tenders: [{ method: 'cash', amountFen: 5000 }], simulatorRule: 'success' }))).data
    await parsePciResponse(inpatientPaymentResponseSchema, await request('cashier', `${admissionPath}/payments/confirm`, { previewId: deposit.previewId, commitToken: deposit.commitToken }))
    const stay = { admissionId: started.admissionId, patientId: started.patientId, path: admissionPath, encounterVersion: diagnosis.encounterVersion,
      sourceCaseId: source.case.caseId, sourceCaseRevision: source.case.revision }
    const path = stay.path
    const catalog = await read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
    const procedure = catalog.procedures.find(item => item.coding.code === '36.0700')!
    assert.equal(procedure.coding.code, '36.0700')
    const planned = (await parsePciResponse(inpatientSurgeryResponseSchema, await request('inpatient-doctor', `${path}/surgeries/request`, {
      encounterVersion: stay.encounterVersion, procedureId: procedure.id, catalogVersion: procedure.version,
      plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成冠心病PCI支架计划' }))).data.requests[0]!
    let reservations: z.infer<typeof inpatientMaterialReservationListSchema>['reservations'] = []
    const reservationResponse = commandResponseSchema(inpatientMaterialReservationListSchema)
    for (const materialId of materialIds) {
      const material = catalog.materials.find(item => item.id === materialId)
      assert.ok(material, `missing executable synthetic material ${materialId}`)
      const current = await read('inpatient-doctor', path, inpatientDetailSchema)
      const result = await parsePciResponse(reservationResponse, await request('inpatient-doctor', `${path}/drg/reservations`, {
        encounterVersion: current.admission.versionId, materialId, catalogVersion: material.version, quantity: 1, requestId: planned.id, reason: '合成PCI院内耗材预留' }))
      reservations = result.data.reservations
    }
    return { ...stay, procedure, requestId: planned.id, reservations, catalog }
  }
  async function pciExecutionInput(stay: Awaited<ReturnType<typeof preparePciAdmission>>, requestId = stay.requestId) {
    for (const [role, action] of [['ward-nurse', 'check-preop'], ['inpatient-doctor', 'confirm-consent']] as const) {
      const surgery = await read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
      await parsePciResponse(inpatientSurgeryResponseSchema, await request(role, `${stay.path}/surgeries/${action}`, {
        requestId, expectedRequestVersion: surgery.requests.find(item => item.id === requestId)!.version, note: '合成PCI术前准备完成' }))
    }
    const surgery = await read('inpatient-doctor', `${stay.path}/surgeries`, inpatientSurgerySchema)
    return { requestId, expectedRequestVersion: surgery.requests.find(item => item.id === requestId)!.version,
      procedureId: stay.procedure.id, catalogVersion: stay.procedure.version,
      note: `合成病例实际实施：${stay.procedure.coding.display}`, materials: stay.reservations.map(reservation => ({ materialId: reservation.materialId,
        catalogVersion: stay.catalog.materials.find(item => item.id === reservation.materialId)!.version, quantity: reservation.quantity, reservationId: reservation.id })) }
  }
  async function executePci(stay: Awaited<ReturnType<typeof preparePciAdmission>>) {
    return (await parsePciResponse(inpatientSurgeryResponseSchema, await request('inpatient-doctor', `${stay.path}/surgeries/execute`,
      await pciExecutionInput(stay)))).data.executions.find(item => item.requestId === stay.requestId)!
  }
  async function confirmMainProcedure(stay: { path: string }, executionId: string) {
    const record = await read('inpatient-doctor', `${stay.path}/record`, inpatientRecordSchema)
    return parsePciResponse(inpatientRecordResponseSchema, await request('inpatient-doctor', `${stay.path}/record/submit`, {
      expectedRevision: record.revision?.revision ?? 0, expectedSourcesHash: record.sourcesHash, mainProcedureExecutionId: executionId }))
  }
  async function executeAngiography(stay: Awaited<ReturnType<typeof preparePciAdmission>>) {
    const procedure = stay.catalog.procedures.find(item => item.coding.code === '88.5500')!
    const admission = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const requested = await parsePciResponse(inpatientSurgeryResponseSchema, await request('inpatient-doctor', `${stay.path}/surgeries/request`, {
      encounterVersion: admission.admission.versionId, procedureId: procedure.id, catalogVersion: procedure.version,
      plannedFor: '2026-08-24T15:00:00+08:00', reason: '固定合成病例实际冠脉造影' }))
    const requestId = requested.data.requests.find(item => item.plannedProcedure.id === procedure.id)!.id
    const angiography = { ...stay, procedure, requestId, reservations: [] }
    return executePci(angiography)
  }
  async function dispensePciMedications(stay: Awaited<ReturnType<typeof preparePciAdmission>>) {
    const suppliedExecutions: string[] = []
    for (const [suffix, doseText, doseQuantity, frequencyCode] of [
      ['aspirin', '100 mg', 1, 'QD'], ['clopidogrel', '75 mg', 1, 'QD'], ['atorvastatin', '20 mg', 2, 'QD'],
      ['heparin', '1 mL', 1, 'PRN'], ['iohexol', '50 mL', 50, 'PRN'],
    ] as const) {
      suppliedExecutions.push(await dispensePciMedication(stay, { suffix, doseText, doseQuantity, frequencyCode }))
    }
    return suppliedExecutions
  }
  async function dispensePciMedication(stay: { path: string }, input: {
    suffix: string; doseText: string; doseQuantity: number; frequencyCode: 'QD' | 'PRN'; surgeryExecutionId?: string
  }) {
    const { suffix, doseText, doseQuantity, frequencyCode, surgeryExecutionId } = input
    const catalog = await read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
    const medication = catalog.medications.find(item => item.id === `medication-pci-${suffix}`)!
    const selection = { kind: 'medication', catalogItemId: medication.id, catalogVersion: medication.version, doseText, frequencyCode, doseQuantity }
    const draft = { medications: [{ catalogItemId: medication.id, catalogVersion: medication.version, doseText, frequencyCode, doseQuantity }], services: [] }
    const evaluation = await parsePciResponse(inpatientDrgSimulationSchema, await request('inpatient-doctor', `${stay.path}/drg/simulation`, draft))
    const admission = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const issued = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('inpatient-doctor', `${stay.path}/orders/issue`, {
      encounterVersion: admission.admission.versionId, duration: 'temporary', selection, expectedDrgFingerprint: evaluation.fingerprint,
      ...(surgeryExecutionId === undefined ? {} : { surgeryExecutionId }) }))).data
    const order = issued.orders.find(item => item.catalogItemId === medication.id && item.state === 'signed')!
    let verified = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('ward-nurse', `${stay.path}/orders/verify`, {
      orderId: order.id, expectedOrderVersion: order.version }))).data
    if (frequencyCode === 'PRN') verified = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('ward-nurse', `${stay.path}/executions/request-prn`, {
      orderId: order.id, expectedOrderVersion: verified.orders.find(item => item.id === order.id)!.version, reason: '固定合成病例本次介入用药' }))).data
    const execution = verified.executions.find(item => item.orderId === order.id)!
    const pharmacy = await read('pharmacist', `${stay.path}/pharmacy`, inpatientPharmacySchema)
    const lot = pharmacy.medications.find(item => item.id === medication.id)!.lots[0]!
    const supplied = (await parsePciResponse(inpatientPharmacyResponseSchema, await request('pharmacist', `${stay.path}/executions/dispense`, {
      executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: doseQuantity }] }))).data
    await parsePciResponse(inpatientFullClinicalResponseSchema, await request('ward-nurse', `${stay.path}/executions/administer`, {
      executionId: execution.id, expectedExecutionVersion: supplied.executions.find(item => item.id === execution.id)!.version }))
    return execution.id
  }
  function dispensePostoperativePciAspirin(stay: { path: string }, surgeryExecutionId: string) {
    return dispensePciMedication(stay, { suffix: 'aspirin', doseText: '100 mg', doseQuantity: 1, frequencyCode: 'QD', surgeryExecutionId })
  }
  async function completePciLaboratories(stay: { path: string }) {
    const catalog = await read('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog', inpatientInvestigationCatalogSchema)
    for (const item of catalog.items.filter(item => item.id.startsWith('hospital-lab-pci-'))) {
      const admission = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
      const issued = (await parsePciResponse(inpatientInvestigationResponseSchema, await request('inpatient-doctor', `${stay.path}/investigations/issue`, {
        encounterVersion: admission.admission.versionId, catalogVersion: item.version,
        selection: { kind: 'laboratory', catalogItemId: item.id, indicationCode: 'clinical-assessment' } }))).data
      const investigation = issued.laboratoryRequests.find(request => request.catalogItemId === item.id)!
      await parsePciResponse(inpatientInvestigationResponseSchema, await request('ward-nurse', `${stay.path}/investigations/send`, {
        requestId: investigation.id, expectedRequestVersion: investigation.version,
        serviceRequestVersion: investigation.serviceRequestVersion, taskVersion: investigation.taskVersion }))
    }
    for (let attempt = 0; attempt < 100; attempt += 1) if (await runtime.dispatcher.dispatchOnce() === undefined) break
    const reported = await read('inpatient-doctor', `${stay.path}/investigations`, inpatientInvestigationsSchema)
    assert.equal(reported.laboratoryRequests.length, 9)
    for (const investigation of reported.laboratoryRequests) {
      assert.ok(investigation.report, JSON.stringify(investigation.generationError))
      await parsePciResponse(inpatientInvestigationResponseSchema, await request('inpatient-doctor', `${stay.path}/investigations/acknowledge`, {
        requestId: investigation.id, expectedRequestVersion: investigation.version, serviceRequestVersion: investigation.serviceRequestVersion,
        taskVersion: investigation.taskVersion, diagnosticReportId: investigation.report.diagnosticReportId,
        diagnosticReportVersion: investigation.report.diagnosticReportVersion }))
    }
    return read('inpatient-doctor', `${stay.path}/investigations`, inpatientInvestigationsSchema)
  }
  async function depart(stay: { path: string }) {
    const current = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const issued = (await parsePciResponse(inpatientDischargeResponseSchema, await request('inpatient-doctor', `${stay.path}/discharge/issue`, {
      encounterVersion: current.admission.versionId, reason: '合成PCI临床治疗完成' }))).data.admission
    return (await parsePciResponse(inpatientDischargeResponseSchema, await request('ward-nurse', `${stay.path}/discharge/depart`, {
      encounterVersion: issued.versionId, reason: '合成PCI出区核对', departureMethod: 'home' }))).data.admission
  }
  if (process.env.CLINMESH_TEST_REFERENCE_DATABASE) {
    const releases = await read('admin', '/api/sim/v1/reference-data/releases', referenceDataReleaseListSchema)
    const active = releases.items.find(item => item.releaseId === options.activeReferenceReleaseId)
    assert.ok(active, 'The external reference release must be published')
    assert.equal(active.releaseId, 'clinmesh-cn-health-2026-09-15.r1', 'Full PCI acceptance requires the reviewed clinical release')
    assert.equal(active.contentHash, '1f4693925350643d55914005b531cb4f9472100caa330c390795d3dcfc4ad2d7')
  }
  return { get runtime() { return runtime }, directory, options, ...data, login, request, read, admitSyntheticCase, preparePciAdmission, pciExecutionInput, executePci, executeAngiography, confirmMainProcedure, dispensePciMedications, dispensePostoperativePciAspirin, completePciLaboratories, depart,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) },
    close: async () => { await runtime.close(); await rm(directory, { recursive: true }) } }
}

export type PciPaymentDrgFixture = Awaited<ReturnType<typeof createPciPaymentDrgFixture>>
