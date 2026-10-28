import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../../src/runtime.ts'
import { prepareDrgRulesPackage } from '../../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { runReferenceDatabaseCli } from '../../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../src/application/scenario-data/medical-service-snapshot.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './drg-synthetic-program.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

export function requestDrgReview(runtime: Runtime, cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
  return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: {
    cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key,
  }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
}

/** Only self-authored reference/rules and a temporary hospital database; no model access. */
export async function setupDrgReview(cleanups: Array<() => Promise<void>>) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-drg-review-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{
    id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
    system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09',
    display: '合成真实目录高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457',
  }], medicationProducts: syntheticNhsaMedicationProductSnapshot,
  services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({
    releaseId: 'synthetic-clinical-2022', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated',
      checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
      retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }],
  }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const groups = [
    { level: 'MDC', code: 'MDCR', name: '合成循环系统疾病', parentCode: null },
    { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCR' },
    { level: 'DRG', code: 'RA15', name: '合成高血压组，不伴合并症或并发症', parentCode: 'RA1' },
    { level: 'ADRG', code: 'RA2', name: '合成PCI介入组', parentCode: 'MDCR' },
    { level: 'DRG', code: 'RA25', name: '合成PCI介入组，不伴合并症或并发症', parentCode: 'RA2' },
  ]
  const jsText = syntheticDrgSource('I10.x09', 'RA15', '00.6600')
  const drgRulesDirectory = join(directory, 'drg-rules')
  await mkdir(drgRulesDirectory)
  const complicationTables = { CC: {}, MCC: {}, CCE: {} }
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables,
    input: syntheticDrgIdentity(jsText, groups, complicationTables),
    releaseId: 'chs-drg-sim-test', sourceVersion: 'CHS-DRG-3.0-sim-test' })
  for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content, 'utf8')
  const options: CreateClinMeshRuntimeOptions = {
    authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022', demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'], drgRulesDirectory,
    investigationModel: 'synthetic-forbidden',
    chatCompletionsProvider: { completeJson: async () => { throw new Error('DRG review verification must never request a model') } },
  }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close() })
  const request = (cookie: string, path: string, input?: unknown, key?: string) => requestDrgReview(runtime, cookie, path, input, key)
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: {
    cookie: registrar, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID(),
  }, body: JSON.stringify({ expectedVersions: {}, input: {
    name: '合成推演审阅患者', gender: 'male', birthDate: '1960-03-04', identifier: `SYN-${randomUUID()}`,
  } }) })
  expect(created.status).toBe(200)
  const patient = createPatientResponseSchema.parse(await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1',
    patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })
  expect(registered.status).toBe(200)
  const registration = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registration.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: registration.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  const admission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
  const clinicalCatalog = inpatientFullCatalogSchema.parse(await (await request(doctor, '/api/his/v1/inpatient/clinical-catalog')).json())
  return { directory, options, get runtime() { return runtime }, request, login, patient, admission,
    doctor, nurse, cashier, registrar, path, clinicalCatalog,
    restart: async (overrides: Partial<CreateClinMeshRuntimeOptions> = {}) => {
      await runtime.close()
      runtime = await createClinMeshRuntime({ ...options, ...overrides })
    },
    openPeer: async () => {
      const peer = await createClinMeshRuntime({ ...options, migrationMode: 'verify' })
      cleanups.push(async () => { await peer.close() })
      return peer
    },
  }
}

export async function confirmPrimary(s: Awaited<ReturnType<typeof setupDrgReview>>) {
  const clinical = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
  return s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion,
    expectedRevision: clinical.diagnosis.revision, entries: [{
      catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '推演审阅验证诊断',
    }],
  })
}
