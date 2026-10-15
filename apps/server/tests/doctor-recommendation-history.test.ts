import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function setup(syntheaProvider = new StubSyntheaProvider()) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recommendation-history-'))
  disposals.push(() => rm(directory, { recursive: true, force: true }))
  let statements = 0
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic', syntheaProvider,
    chatCompletionsProvider: { completeJson: async input => ({ content: JSON.stringify(persona), model: input.model }) },
    performanceObserver: { observeStatement: () => { statements += 1 }, observeTransaction: () => {} },
  })
  disposals.push(() => runtime.close())
  const started = await startConsultationCase(runtime)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const claimed = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: {
      [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1',
    }, input: {} }),
  })
  expect(claimed.status).toBe(200)
  const actor = (await runtime.identity.resolveSessionContext(new Headers({ cookie }))).actor
  const readCase = async () => doctorCaseDetailSchema.parse(await (await runtime.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  return { runtime, started, actor, cookie, readCase, resetStatements: () => { statements = 0 }, statements: () => statements }
}

it('reads 596 visible resources through the public recommendation entry without repeating one authorization query per resource', async () => {
  const provider = new class extends StubSyntheaProvider {
    override async generate() {
      const corpus = await super.generate()
      const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(corpus.sources[0]!.raw)
      raw.entry.push(...Array.from({ length: 596 }, (_, index) => ({ fullUrl: `urn:uuid:bulk-observation-${index}`,
        resource: { resourceType: 'Observation', id: `bulk-observation-${index}`, status: 'final',
          subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:prior-encounter' },
          effectiveDateTime: '2024-01-10T09:05:00+08:00', code: { text: `合成观察${index}` },
          note: [{ text: '尚未解释，不能推定正常。' }], valueQuantity: { value: index / 100, unit: 'mmol/L' },
          extension: [{ url: 'https://untrusted.invalid', valueString: 'private-extension' }] },
      })))
      return { ...corpus, sources: [{ ...corpus.sources[0]!, raw, hash: sourceArtifactHash(raw) }] }
    }
  }()
  const fixture = await setup(provider)
  fixture.resetStatements()
  const response = await fixture.runtime.app.request(
    `/api/his/v1/doctor/cases/${fixture.started.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: fixture.cookie } },
  )

  expect(response.status).toBe(200)
  expect(fixture.statements()).toBeLessThan(200)
  const history = fixture.runtime.workflow.doctorRecommendationHistory(fixture.actor, fixture.started.outpatientCaseId)
  const observations = history.filter(item => item.source === 'visible-source' && item.resourceType === 'Observation')
  expect(observations).toHaveLength(596)
  expect(observations.find(item => item.entryId === 'urn:uuid:bulk-observation-595')).toMatchObject({ source: 'visible-source', clinical: {
    note: [{ text: '尚未解释，不能推定正常。' }], valueQuantity: { value: 5.95, unit: 'mmol/L' },
  } })
  expect(JSON.stringify(history)).not.toMatch(/private-extension|untrusted\.invalid|2 型糖尿病/)
})

it('reads all patient Conditions beyond one hundred while excluding the current encounter and another patient', async () => {
  const fixture = await setup()
  const patient = (await fixture.readCase()).patient
  for (let index = 0; index < 101; index += 1) fixture.runtime.fhir.create(fixture.actor, {
    resourceType: 'Condition', id: `independent-condition-${String(index).padStart(3, '0')}`,
    subject: { reference: `Patient/${patient.id}` }, code: { text: `独立既往诊断${index}` },
    clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '1990-01-01T00:00:00Z',
  })
  fixture.runtime.fhir.create(fixture.actor, { resourceType: 'Patient', id: 'another-synthetic-patient', name: [{ text: '另一合成患者' }] })
  fixture.runtime.fhir.create(fixture.actor, { resourceType: 'Condition', id: 'other-patient-condition',
    subject: { reference: 'Patient/another-synthetic-patient' }, code: { text: '其他患者诊断' } })
  fixture.runtime.fhir.create(fixture.actor, { resourceType: 'Condition', id: 'current-encounter-condition',
    subject: { reference: `Patient/${patient.id}` }, encounter: { reference: `Encounter/${fixture.started.encounterId}` },
    code: { text: '当前就诊诊断' } })

  const detail = await fixture.readCase()
  expect(detail.priorFacts).toHaveLength(101)
  expect(detail.priorFacts.map(item => item.display)).toContain('独立既往诊断0')
  expect(detail.priorFacts.map(item => item.display)).not.toContain('其他患者诊断')
  expect(detail.priorFacts.map(item => item.display)).not.toContain('当前就诊诊断')
})

it('refuses a missing visible source resource instead of generating a partial recommendation context', async () => {
  const fixture = await setup()
  const entry = fixture.runtime.workflow.doctorCaseHistory(fixture.actor, fixture.started.outpatientCaseId, {
    source: 'visible-source', page: 1, pageSize: 20,
  }).items[0]!
  const bindings = [fixture.actor.workspaceId, fixture.started.caseId, entry.entryId]
  fixture.runtime.database.driver.pragma('foreign_keys = OFF')
  try {
    fixture.runtime.database.driver.prepare(`DELETE FROM synthetic_case_visible_resource
      WHERE workspace_id = ? AND case_id = ? AND source_reference = ?`).run(...bindings)
  } finally {
    fixture.runtime.database.driver.pragma('foreign_keys = ON')
  }
  expect(fixture.runtime.database.driver.prepare(`SELECT COUNT(*) AS count FROM synthetic_case_visible_history
    WHERE workspace_id = ? AND case_id = ? AND source_reference = ?`).get(...bindings)).toEqual({ count: 1 })
  expect(fixture.runtime.database.driver.prepare(`SELECT COUNT(*) AS count FROM synthetic_case_visible_resource
    WHERE workspace_id = ? AND case_id = ? AND source_reference = ?`).get(...bindings)).toEqual({ count: 0 })

  const response = await fixture.runtime.app.request(
    `/api/his/v1/doctor/cases/${fixture.started.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: fixture.cookie } },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
})

it('keeps the completed-history patient, responsible doctor and completion boundaries and rechecks current authorization', async () => {
  const fixture = await setup()
  const patient = (await fixture.readCase()).patient
  fixture.runtime.fhir.create(fixture.actor, { resourceType: 'Patient', id: 'other-history-patient', name: [{ text: '另一合成患者' }] })
  fixture.runtime.database.driver.prepare(`INSERT INTO practitioner_role_binding (
    workspace_id, practitioner_role_id, practitioner_id, role_code, organization_id, location_id, active
  ) SELECT workspace_id, 'other-history-doctor', practitioner_id, role_code, organization_id, location_id, active
    FROM practitioner_role_binding WHERE practitioner_role_id = ?`).run(fixture.actor.practitionerRoleId)
  for (const [caseId, patientId, roleId, completed] of [
    ['prior-own', patient.id, fixture.actor.practitionerRoleId, true],
    ['prior-other-patient', 'other-history-patient', fixture.actor.practitionerRoleId, true],
    ['prior-other-doctor', patient.id, 'other-history-doctor', true],
    ['unfinished-own', patient.id, fixture.actor.practitionerRoleId, false],
  ] as const) {
    const recordedAt = '2000-01-01T09:00:00+08:00'
    fixture.runtime.fhir.create(fixture.actor, { resourceType: 'Encounter', id: `encounter-${caseId}`,
      actualPeriod: { start: recordedAt, ...(completed ? { end: '2000-01-01T10:00:00+08:00' } : {}) },
      class: [{ coding: [{ code: 'AMB', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }] }],
      status: completed ? 'completed' : 'in-progress', subject: { reference: `Patient/${patientId}` },
    })
    fixture.runtime.database.driver.prepare(`INSERT INTO outpatient_case (
      workspace_id, epoch, case_id, scenario_run_id, patient_id, registration_id, encounter_id,
      account_id, department_id, location_id, initial_task_id, status, arrived_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fixture.actor.workspaceId, fixture.actor.epoch, caseId, fixture.actor.scenarioRunId, patientId,
      `registration-${caseId}`, `encounter-${caseId}`, `account-${caseId}`, 'department-general-medicine',
      'location-outpatient', `task-${caseId}`, completed ? 'completed' : 'first-visit', recordedAt, recordedAt,
    )
    fixture.runtime.database.driver.prepare(`INSERT INTO outpatient_case_responsibility (
      workspace_id, epoch, case_id, practitioner_role_id, assigned_at
    ) VALUES (?, ?, ?, ?, ?)`).run(fixture.actor.workspaceId, fixture.actor.epoch, caseId, roleId, recordedAt)
  }

  const read = () => fixture.runtime.workflow.doctorRecommendationHistory(fixture.actor, fixture.started.outpatientCaseId)
  const history = read()
  expect(history.filter(item => item.source === 'local-completed')).toEqual([
    fixture.runtime.workflow.doctorCaseHistoryDetail(fixture.actor, fixture.started.outpatientCaseId, {
      source: 'local-completed', entryId: 'prior-own',
    }),
  ])
  expect(() => fixture.runtime.workflow.doctorRecommendationHistory({ ...fixture.actor, epoch: 'another-epoch' },
    fixture.started.outpatientCaseId)).toThrow()
  expect(() => fixture.runtime.workflow.doctorRecommendationHistory({ ...fixture.actor, roleCode: 'registrar' },
    fixture.started.outpatientCaseId)).toThrow()
  fixture.runtime.database.driver.prepare(`DELETE FROM outpatient_case_responsibility
    WHERE workspace_id = ? AND epoch = ? AND case_id = ?`).run(
    fixture.actor.workspaceId, fixture.actor.epoch, fixture.started.outpatientCaseId,
  )
  expect(read).toThrow()
  const response = await fixture.runtime.app.request(
    `/api/his/v1/doctor/cases/${fixture.started.outpatientCaseId}/recommendations/diagnosis`, { headers: { cookie: fixture.cookie } },
  )
  expect(response.status).toBe(403)
})
