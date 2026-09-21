import type { PatientPersonaContent, ScenarioProviderCapabilities } from '@clinmesh/contracts/scenario'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { createClinMeshRuntime } from '../../src/runtime.ts'
import { sourceArtifactHash } from '../../src/application/scenario-data/provider.ts'
import type { ScenarioGenerationProvider, SourcePatientCorpus } from '../../src/application/scenario-data/provider.ts'

export const persona: PatientPersonaContent = {
  chiefComplaint: '反复头晕一周',
  knownHistorySummary: '既往有高血压病史，规律服药。',
  medicationMemory: '每天吃一片降压药，名字记不清。',
  openingStatement: '医生您好，我最近一周总是头晕。',
  persona: {
    attitude: '怕花钱，能不查就不查',
    character: '直爽、话多',
    healthLiteracy: '小学文化，听不懂医学名词',
    speechStyle: '句子短，爱打比方',
  },
  symptomExperience: '一周前蹲下起身时开始晕，眼前发黑，歇一会儿能缓过来，没自己买过药。',
}

export class StubSyntheaProvider implements ScenarioGenerationProvider {
  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 10,
      modules: [],
      providerId: 'synthea',
      providerName: 'Synthea',
    }
  }

  async generate(): Promise<SourcePatientCorpus> {
    const raw = {
      entry: [{
        fullUrl: 'urn:uuid:patient',
        resource: { address: [{ text: '合成市城东区块合成路1号' }], birthDate: '1970-01-01', gender: 'female', id: 'p1', name: [{ text: '张琴' }], resourceType: 'Patient' },
      }, {
        fullUrl: 'urn:uuid:prior-encounter',
        resource: { id: 'pe', period: { end: '2025-01-10T09:30:00+08:00', start: '2025-01-10T09:00:00+08:00' }, resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } },
      }, {
        fullUrl: 'urn:uuid:prior-condition',
        resource: { code: { coding: [{ code: '59621000', display: '高血压（疾病）', system: 'http://snomed.info/sct' }] }, encounter: { reference: 'urn:uuid:prior-encounter' }, id: 'pc', recordedDate: '2025-01-10T09:05:00+08:00', resourceType: 'Condition', subject: { reference: 'urn:uuid:patient' } },
      }, {
        fullUrl: 'urn:uuid:index-encounter',
        resource: { id: 'ie', period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' }, reasonCode: [{ text: '血压控制不佳' }], resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:patient' } },
      }, {
        fullUrl: 'urn:uuid:index-condition',
        resource: { code: { coding: [{ code: '386661006', display: '2 型糖尿病', system: 'http://snomed.info/sct' }] }, encounter: { reference: 'urn:uuid:index-encounter' }, id: 'ic', recordedDate: '2026-06-01T10:20:00+08:00', resourceType: 'Condition', subject: { reference: 'urn:uuid:patient' } },
      }, {
        fullUrl: 'urn:uuid:index-wbc',
        resource: {
          code: { coding: [{ code: '6690-2', display: '白细胞计数', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'iwtest',
          interpretation: [{ coding: [{ code: 'H', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: '10*9/L', value: 9.5 }, low: { unit: '10*9/L', value: 3.5 }, text: '3.5-9.5 x10^9/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: '10*9/L', value: 11.2 },
        },
      }, {
        fullUrl: 'urn:uuid:index-hgb',
        resource: {
          code: { coding: [{ code: '718-7', display: '血红蛋白', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'ihtest',
          interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: 'g/L', value: 150 }, low: { unit: 'g/L', value: 115 }, text: '115-150 g/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: 'g/L', value: 135 },
        },
      }, {
        fullUrl: 'urn:uuid:index-plt',
        resource: {
          code: { coding: [{ code: '777-3', display: '血小板计数', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'iptest',
          interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: '10*9/L', value: 350 }, low: { unit: '10*9/L', value: 125 }, text: '125-350 x10^9/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: '10*9/L', value: 210 },
        },
      }, {
        fullUrl: 'urn:uuid:index-crp',
        resource: {
          code: { coding: [{ code: '1988-5', display: 'C 反应蛋白', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-06-01T10:15:00+08:00',
          encounter: { reference: 'urn:uuid:index-encounter' },
          id: 'irtest',
          interpretation: [{ coding: [{ code: 'H', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
          issued: '2026-06-01T10:20:00+08:00',
          referenceRange: [{ high: { unit: 'mg/L', value: 8 }, low: { unit: 'mg/L', value: 0 }, text: '0-8 mg/L' }],
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: 'urn:uuid:patient' },
          valueQuantity: { system: 'http://unitsofmeasure.org', unit: 'mg/L', value: 18.6 },
        },
      }],
      resourceType: 'Bundle',
      type: 'collection',
    }
    return {
      kind: 'synthea-r4',
      sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(raw), patientId: 'p1', raw }],
    }
  }
}

export async function signIn(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, email: string, password = 'Synthetic-Demo-Password-2026!') {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

const origin = 'http://localhost'

export async function startConsultationCase(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, password = 'Synthetic-Demo-Password-2026!') {
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local', password)
  await runtime.app.request('/api/sim/v1/scenario-generation-jobs', {
    body: JSON.stringify({
      name: '对话演练患者',
      population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
      providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }),
    headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': randomUUID(), origin },
    method: 'POST',
  })
  const generated = await runtime.scenarioData.processNextGenerationJob()
  const caseId = generated?.caseIds[0]
  if (caseId === undefined) throw new Error('No generated case')
  await runtime.app.request(
    `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-persona-jobs`,
    {
      body: '{}',
      headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': randomUUID(), origin },
      method: 'POST',
    },
  )
  const personaJob = await runtime.patientPersona.processNext()
  if (personaJob?.status !== 'succeeded') throw new Error('Persona generation failed')

  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local', password)
  const session = await runtime.identity.resolveSessionContext(new Headers({ cookie: registrar }))
  const catalog = runtime.workflow.registrationCatalog(session.actor)
  const startedResponse = await runtime.app.request(
    `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
    {
      body: JSON.stringify({
        activeBriefRevision: 1,
        departmentId: catalog.departments[0]!.id,
        expectedCaseRevision: 2,
        locationId: catalog.locations[0]!.id,
        visitDate: catalog.virtualDate,
        visitTypeId: catalog.visitTypes[0]!.id,
      }),
      headers: { 'content-type': 'application/json', cookie: registrar, 'idempotency-key': randomUUID(), origin },
      method: 'POST',
    },
  )
  expect(startedResponse.status).toBe(200)
  const detail = await startedResponse.json() as { data: {
    encounterId: string
    outpatientCaseId: string
    queueTaskId: string
  } }
  const encounterId = detail.data.encounterId

  const triageCookie = await signIn(runtime, 'triage@demo.clinmesh.local', password)
  const triaged = await runtime.app.request(`/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
    body: JSON.stringify({
      expectedVersions: { [`Encounter/${encounterId}`]: '1', [`Task/${detail.data.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 96, systolicMmHg: 162 },
        chiefComplaint: '反复头晕一周',
        oxygenSaturationPct: 98,
        pulseBpm: 82,
        respirationBpm: 18,
        temperatureC: 36.5,
      },
    }),
    headers: { 'content-type': 'application/json', cookie: triageCookie, 'idempotency-key': randomUUID(), origin },
    method: 'POST',
  })
  expect(triaged.status).toBe(200)
  const triageData = await triaged.json() as { data: { encounterVersion: string; doctorTaskId: string } }
  return {
    adminCookie: admin,
    caseId,
    doctorTaskId: triageData.data.doctorTaskId,
    encounterId,
    encounterVersion: triageData.data.encounterVersion,
    outpatientCaseId: detail.data.outpatientCaseId,
  }
}


export function useSyntheticLaboratoryCatalog(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>): void {
  const update = runtime.database.driver.prepare(`
    UPDATE outpatient_catalog SET config_json = ?
    WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
      AND kind = 'laboratory' AND item_id = ?
  `)
  update.run(JSON.stringify({
    allowedIndicationCodes: ['fever', 'clinical-evaluation'],
    contraindicatedAllergyCodes: [],
    referenceConcept: {
      code: '6690-2',
      display: '白细胞计数',
      id: 'laboratory:synthetic-wbc',
      laboratory: {
        category: 'hematology',
        referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5 x10^9/L' },
        resultType: 'quantity',
        specimen: 'blood',
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
      },
      sourceLocator: 'synthetic:test:wbc',
      system: 'http://loinc.org',
      version: '2.83',
    },
  }), 'lab-cbc')
  update.run(JSON.stringify({
    allowedIndicationCodes: ['fever', 'clinical-evaluation'],
    contraindicatedAllergyCodes: [],
    referenceConcept: {
      code: '1988-5',
      display: 'C 反应蛋白',
      id: 'laboratory:synthetic-crp',
      laboratory: {
        category: 'chemistry',
        referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
        resultType: 'quantity',
        specimen: 'blood',
        unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
      },
      sourceLocator: 'synthetic:test:crp',
      system: 'http://loinc.org',
      version: '2.83',
    },
  }), 'lab-crp')
}
