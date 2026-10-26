import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { z } from 'zod'
import { commandResponseSchema, createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema, inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema,
  inpatientPharmacySchema, inpatientPharmacyResponseSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDischargeResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
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
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: clinicalConcepts,
    medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-pci-acceptance-reference', schemaVersion: '1', createdAt: '2026-10-25T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-pci-acceptance', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: hash(artifact),
      licenseId: 'CC0-1.0', retrievedAt: '2026-10-25T00:00:00.000Z', sourceUrl: 'https://example.test/clinmesh/pci-acceptance', upstreamVersion: '2022.r4-minimal-test-facts' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  // CI uses a self-authored program, never fragments of an executable upstream source.
  // The identical HTTP journey can explicitly consume a locally materialized full v2 package.
  if (process.env.CLINMESH_TEST_DRG_RULES_DIRECTORY) return { referenceDatabasePath, drgRulesDirectory: process.env.CLINMESH_TEST_DRG_RULES_DIRECTORY }
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
  expect(response.status, response.ok ? undefined : await response.clone().text()).toBe(200)
  return schema.parse(await response.json())
}

export async function preparePciPaymentDrgFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-payment-drg-'))
  const data = await preparePciAcceptanceData(directory), password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), ...data,
    activeReferenceReleaseId: 'synthetic-pci-acceptance-reference', demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  return { directory, data, password, options }
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
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0]!
    cookies.set(role, cookie)
    return cookie
  }
  async function request(role: string, path: string, input?: unknown, key = randomUUID(), expectedVersions?: Record<string, string>) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie: await login(role), origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key },
    ...(input === undefined ? {} : { body: JSON.stringify({ input, ...(expectedVersions === undefined ? {} : { expectedVersions }) }) }) })
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
  async function preparePciAdmission(materialIds = ['hospital-material-stent', 'hospital-material-balloon', 'hospital-material-guidewire', 'hospital-material-catheter']) {
    const stay = await admitSyntheticCase(['I25.103', 'I10.x09'], 'bed-general-1')
    const path = stay.path
    const catalog = await read('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema)
    const procedure = catalog.procedures.find(item => item.coding.code === '36.0700')!
    expect(procedure.coding.code).toBe('36.0700')
    const planned = (await parsePciResponse(inpatientSurgeryResponseSchema, await request('inpatient-doctor', `${path}/surgeries/request`, {
      encounterVersion: stay.encounterVersion, procedureId: procedure.id, catalogVersion: procedure.version,
      plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成冠心病PCI支架计划' }))).data.requests[0]!
    let reservations: z.infer<typeof inpatientMaterialReservationListSchema>['reservations'] = []
    const reservationResponse = commandResponseSchema(inpatientMaterialReservationListSchema)
    for (const materialId of materialIds) {
      const material = catalog.materials.find(item => item.id === materialId)
      expect(material, `missing executable synthetic material ${materialId}`).toBeDefined()
      const current = await read('inpatient-doctor', path, inpatientDetailSchema)
      const result = await parsePciResponse(reservationResponse, await request('inpatient-doctor', `${path}/drg/reservations`, {
        encounterVersion: current.admission.versionId, materialId, catalogVersion: material!.version, quantity: 1, requestId: planned.id, reason: '合成PCI院内耗材预留' }))
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
      note: '合成PCI实际支架植入', materials: stay.reservations.map(reservation => ({ materialId: reservation.materialId,
        catalogVersion: stay.catalog.materials.find(item => item.id === reservation.materialId)!.version, quantity: reservation.quantity, reservationId: reservation.id })) }
  }
  async function executePci(stay: Awaited<ReturnType<typeof preparePciAdmission>>) {
    return (await parsePciResponse(inpatientSurgeryResponseSchema, await request('inpatient-doctor', `${stay.path}/surgeries/execute`,
      await pciExecutionInput(stay)))).data.executions[0]!
  }
  async function dispenseHypertensionMedication(stay: Awaited<ReturnType<typeof preparePciAdmission>>) {
    const catalog = await read('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog', inpatientFullCatalogSchema)
    const medication = catalog.medications.find(item => item.id === 'medication-amlodipine')!
    const selection = { kind: 'medication', catalogItemId: medication.id, catalogVersion: medication.version, doseText: '5 mg', frequencyCode: 'QD', doseQuantity: 1 }
    const draft = { medications: [{ catalogItemId: medication.id, catalogVersion: medication.version, doseText: '5 mg', frequencyCode: 'QD', doseQuantity: 1 }], services: [] }
    const evaluation = await parsePciResponse(inpatientDrgSimulationSchema, await request('inpatient-doctor', `${stay.path}/drg/simulation`, draft))
    const admission = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const issued = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('inpatient-doctor', `${stay.path}/orders/issue`, {
      encounterVersion: admission.admission.versionId, duration: 'temporary', selection, expectedDrgFingerprint: evaluation.fingerprint }))).data
    const order = issued.orders.find(item => item.state === 'signed')!
    const verified = (await parsePciResponse(inpatientFullClinicalResponseSchema, await request('ward-nurse', `${stay.path}/orders/verify`, {
      orderId: order.id, expectedOrderVersion: order.version }))).data
    const execution = verified.executions.find(item => item.orderId === order.id)!
    const pharmacy = await read('pharmacist', `${stay.path}/pharmacy`, inpatientPharmacySchema)
    const lot = pharmacy.medications.find(item => item.id === medication.id)!.lots[0]!
    const supplied = (await parsePciResponse(inpatientPharmacyResponseSchema, await request('pharmacist', `${stay.path}/executions/dispense`, {
      executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }] }))).data
    return { executionId: execution.id, clinical: supplied }
  }
  async function depart(stay: { path: string }) {
    const current = await read('inpatient-doctor', stay.path, inpatientDetailSchema)
    const issued = (await parsePciResponse(inpatientDischargeResponseSchema, await request('inpatient-doctor', `${stay.path}/discharge/issue`, {
      encounterVersion: current.admission.versionId, reason: '合成PCI临床治疗完成' }))).data.admission
    return (await parsePciResponse(inpatientDischargeResponseSchema, await request('ward-nurse', `${stay.path}/discharge/depart`, {
      encounterVersion: issued.versionId, reason: '合成PCI出区核对', departureMethod: 'home' }))).data.admission
  }
  return { get runtime() { return runtime }, directory, options, ...data, login, request, read, admitSyntheticCase, preparePciAdmission, pciExecutionInput, executePci, dispenseHypertensionMedication, depart,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) },
    close: async () => { await runtime.close(); await rm(directory, { recursive: true }) } }
}

export type PciPaymentDrgFixture = Awaited<ReturnType<typeof createPciPaymentDrgFixture>>
