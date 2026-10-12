import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { agentPageContextBindingSchema } from '@clinmesh/contracts/agent'
import { validateAgentToolInputForContext } from '../src/application/agent-context-policy.ts'
import type { ActorContext } from '../src/application/command-executor.ts'
import { canonicalJsonHash } from '../src/application/scenario-data/canonical-json.ts'
import { compileSyntheaIndexCase } from '../src/application/scenario-data/synthea-index-case.ts'
import { createSyntheticPatientProfiles } from '../src/application/scenario-data/synthetic-patient-profile.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const doctor: ActorContext = {
  actorId: 'actor-outpatient-doctor',
  epoch: 'epoch-1',
  practitionerRoleId: 'practitioner-role-outpatient-doctor',
  roleCode: 'outpatient-doctor',
  scenarioRunId: 'scenario-run-1',
  workspaceId: 'workspace-demo',
}
const recordedAt = '2026-08-24T09:00:00+08:00'

describe('current doctor case authorized history', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
  })

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-doctor-history-'))
    directories.push(directory)
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: 'Test-Synthetic-History-Aa1!',
      dshBridgeSecret: 'test-dsh-bridge-secret-with-at-least-32-characters',
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    runtime.database.driver.prepare(`
      INSERT INTO practitioner_role_binding (
        workspace_id, practitioner_role_id, practitioner_id, role_code, organization_id, location_id, active
      ) SELECT workspace_id, 'practitioner-role-other-doctor', practitioner_id,
        role_code, organization_id, location_id, active FROM practitioner_role_binding
        WHERE practitioner_role_id = 'practitioner-role-outpatient-doctor'
    `).run()
    return runtime
  }

  function createCase(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    caseId: string,
    patientId: string,
    options: { completedAt?: string; practitionerRoleId?: string } = {},
  ) {
    if (!runtime.database.driver.prepare(`
      SELECT 1 FROM fhir_resource WHERE workspace_id = ? AND epoch = ?
        AND resource_type = 'Patient' AND resource_id = ?
    `).get(doctor.workspaceId, doctor.epoch, patientId)) {
      runtime.fhir.create(doctor, {
        birthDate: '1992-02-02', gender: 'female', id: patientId,
        name: [{ text: '合成历史患者' }], resourceType: 'Patient',
      })
    }
    runtime.fhir.create(doctor, {
      actualPeriod: { start: recordedAt, ...(options.completedAt === undefined ? {} : { end: options.completedAt }) },
      class: [{ coding: [{ code: 'AMB', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }] }],
      id: `encounter-${caseId}`, resourceType: 'Encounter',
      status: options.completedAt === undefined ? 'in-progress' : 'completed',
      subject: { reference: `Patient/${patientId}` },
    })
    runtime.database.driver.prepare(`
      INSERT INTO outpatient_case (
        workspace_id, epoch, case_id, scenario_run_id, patient_id, registration_id,
        encounter_id, account_id, department_id, location_id, initial_task_id,
        status, arrived_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(doctor.workspaceId, doctor.epoch, caseId, doctor.scenarioRunId, patientId,
      `registration-${caseId}`, `encounter-${caseId}`, `account-${caseId}`,
      'department-general-medicine', 'location-outpatient', `task-${caseId}`,
      options.completedAt === undefined ? 'first-visit' : 'completed', recordedAt, recordedAt)
    runtime.database.driver.prepare(`
      INSERT INTO outpatient_case_responsibility (
        workspace_id, epoch, case_id, practitioner_role_id, assigned_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(doctor.workspaceId, doctor.epoch, caseId,
      options.practitionerRoleId ?? doctor.practitionerRoleId, recordedAt)
  }

  function materializeHistory(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>) {
    const bundle = {
      entry: [{ fullUrl: 'urn:uuid:source-patient', resource: {
        birthDate: '1992-02-02', gender: 'female', id: 'source-patient',
        name: [{ text: '合成历史患者' }], resourceType: 'Patient',
      } }, { fullUrl: 'urn:uuid:prior-encounter', resource: {
        id: 'prior-encounter', period: { start: '2025-08-01T09:00:00+08:00', end: '2025-08-01T10:00:00+08:00' },
        resourceType: 'Encounter', status: 'finished', subject: { reference: 'urn:uuid:source-patient' },
      } }, { fullUrl: 'urn:uuid:prior-condition', resource: {
        code: { coding: [{ code: '59621000', display: '高血压', system: 'http://snomed.info/sct' }] },
        encounter: { reference: 'urn:uuid:prior-encounter' }, id: 'prior-condition',
        extension: [{ url: 'https://untrusted.example/secret', valueString: 'arbitrary-extension' }],
        recordedDate: '2025-08-01T09:05:00+08:00', resourceType: 'Condition',
        subject: { reference: 'urn:uuid:source-patient' },
        text: { status: 'generated', div: '<div>untrusted-narrative</div>' },
      } }, { fullUrl: 'urn:uuid:index-encounter', resource: {
        id: 'index-encounter', period: { start: '2026-06-01T09:00:00+08:00', end: '2026-06-01T10:00:00+08:00' },
        reasonCode: [{ text: '头痛' }], resourceType: 'Encounter', status: 'finished',
        subject: { reference: 'urn:uuid:source-patient' },
      } }, { fullUrl: 'urn:uuid:index-condition', resource: {
        code: { text: 'hidden-index-diagnosis' }, encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-condition', recordedDate: '2026-06-01T09:05:00+08:00',
        resourceType: 'Condition', subject: { reference: 'urn:uuid:source-patient' },
      } }], resourceType: 'Bundle', type: 'collection',
    }
    const profile = createSyntheticPatientProfiles({
      batchId: 'history-batch', batchName: '历史合成批次', createdAt: recordedAt,
      request: scenarioGenerationRequestSchema.parse({
        moduleMode: 'filter', modules: ['hypertension'], name: '历史合成批次',
        population: { age: { maximum: 60, minimum: 18 }, count: 1, gender: 'female' },
        providerId: 'synthea', seeds: { clinical: 1, population: 1 },
        timeRange: { end: '2026-08-01', start: '2016-08-01' }, timeZone: 'Asia/Shanghai',
      }),
      sources: [{ format: 'fhir-r4-bundle', hash: canonicalJsonHash(bundle), patientId: 'source-patient', raw: bundle }],
      workspaceId: doctor.workspaceId,
    })[0]!
    new SyntheticPatientProfileRepository(runtime.database).createBatch([profile], 'actor-administrator')
    const sourceCase = new SyntheticCaseRepository(runtime.database).createFromProfile({
      actorId: 'actor-administrator', compiled: compileSyntheaIndexCase(bundle), profile,
    })
    runtime.database.driver.prepare(`
      INSERT INTO patient_persona_revision (workspace_id, case_id, revision, content_json,
        model_id, prompt_version, prompt_hash, input_hash, output_hash, created_at)
      VALUES (?, ?, 1, '{}', 'fixture-model', 'fixture-v1', ?, ?, ?, ?)
    `).run(doctor.workspaceId, sourceCase.caseId, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), recordedAt)
    runtime.database.driver.prepare(`
      INSERT INTO synthetic_patient_materialization (
        workspace_id, epoch, profile_id, profile_revision, patient_id, created_at
      ) VALUES (?, ?, ?, ?, 'patient-current', ?)
    `).run(doctor.workspaceId, doctor.epoch, profile.profileId, profile.revision, recordedAt)
    runtime.database.driver.prepare(`
      INSERT INTO synthetic_case_materialization (
        workspace_id, epoch, case_id, case_revision, profile_id, profile_revision,
        brief_revision, patient_id, outpatient_case_id, registration_id,
        encounter_id, queue_task_id, started_by_actor_id, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 'patient-current', 'current',
        'registration-current', 'encounter-current', 'task-current', ?, ?)
    `).run(doctor.workspaceId, doctor.epoch, sourceCase.caseId, profile.profileId,
      profile.revision, doctor.actorId, recordedAt)
    return sourceCase.caseId
  }

  it('pages only this patient completed records owned by the current doctor', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    createCase(runtime, 'older', 'patient-current', { completedAt: '2026-08-20T10:00:00+08:00' })
    createCase(runtime, 'newer', 'patient-current', { completedAt: '2026-08-21T10:00:00+08:00' })
    createCase(runtime, 'other-patient', 'patient-other', { completedAt: '2026-08-22T10:00:00+08:00' })
    createCase(runtime, 'other-doctor', 'patient-current', {
      completedAt: '2026-08-23T10:00:00+08:00', practitionerRoleId: 'practitioner-role-other-doctor',
    })

    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 1, pageSize: 1, source: 'local-completed',
    })).toMatchObject({
      availability: 'available', coverage: 'current-patient-responsible-doctor',
      items: [{ entryId: 'newer', source: 'local-completed', clinicalDate: '2026-08-21T10:00:00+08:00' }],
      page: 1, pageSize: 1, total: 2,
    })
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 2, pageSize: 1, source: 'local-completed',
    })).toMatchObject({ items: [{ entryId: 'older' }], page: 2, total: 2 })
    expect(runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', {
      entryId: 'older', source: 'local-completed',
    })).toMatchObject({
      source: 'local-completed', entryId: 'older',
      record: { caseId: 'older', patient: { id: 'patient-current' }, clinicalDocuments: [] },
    })
    for (const entryId of ['other-patient', 'other-doctor', 'current', 'unknown']) {
      expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', {
        entryId, source: 'local-completed',
      })).toThrow('authorized history')
    }
  })

  it('reads paged visible materialized history without exposing raw resources or hidden truth', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 1, pageSize: 1, source: 'visible-source',
    })).toMatchObject({ availability: 'no-materialization', items: [], total: 0 })
    materializeHistory(runtime)

    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 1, pageSize: 1, source: 'visible-source',
    })).toMatchObject({
      availability: 'available', coverage: 'materialized-visible-history',
      items: [{ entryId: 'urn:uuid:prior-encounter', source: 'visible-source', resourceType: 'Encounter' }],
      page: 1, pageSize: 1, total: 2,
    })
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 2, pageSize: 1, source: 'visible-source',
    })).toMatchObject({ items: [{ entryId: 'urn:uuid:prior-condition' }], page: 2, total: 2 })
    const detail = runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', {
      entryId: 'urn:uuid:prior-condition', source: 'visible-source',
    })
    expect(detail).toMatchObject({
      clinical: { code: { coding: [{ code: '59621000', display: '高血压' }] }, recordedDate: '2025-08-01T09:05:00+08:00' },
      entryId: 'urn:uuid:prior-condition', missingFieldMeaning: 'not-recorded', source: 'visible-source',
    })
    expect(JSON.stringify(detail)).not.toMatch(/hidden-index|raw|Bundle|arbitrary-extension|untrusted|subject|index-condition/)
    for (const entryId of ['urn:uuid:index-condition', 'urn:uuid:index-encounter', 'Condition/prior-condition', 'https://untrusted.example/secret']) {
      expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', {
        entryId, source: 'visible-source',
      })).toThrow('authorized history')
    }
  })

  it('publishes history operations for the responsible case and validates the allowed entry set', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    createCase(runtime, 'prior', 'patient-current', { completedAt: '2026-08-20T10:00:00+08:00' })
    createCase(runtime, 'other-patient', 'patient-other', { completedAt: '2026-08-20T10:00:00+08:00' })
    materializeHistory(runtime)
    const signIn = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: 'doctor@demo.clinmesh.local', password: 'Test-Synthetic-History-Aa1!' }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' }, method: 'POST',
    })
    const cookie = signIn.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const response = await runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({
        claim: {
          taskEpoch: 'a1b2c3d4-1234-4234-8234-123456789abc',
          activeSection: 'diagnosis', selection: { kind: 'case', id: 'current', version: '1' },
          ui: { status: 'ready' }, version: 1, viewId: 'consultation', viewRevision: 'history-frame-1',
        },
        client: { id: 'history-client', revision: 1 }, dshSessionId: 'history-session',
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' }, method: 'POST',
    })
    expect(response.status).toBe(201)
    const binding = agentPageContextBindingSchema.parse(await response.json())
    expect(binding.snapshot.allowedOperationIds).toEqual(expect.arrayContaining([
      'outpatient.history.search', 'outpatient.history.read',
    ]))
    const user = runtime.database.driver.prepare('SELECT id FROM user WHERE email = ?')
      .get('doctor@demo.clinmesh.local') as { id: string }
    const validate = (source: 'local-completed' | 'visible-source', entryId: string) => validateAgentToolInputForContext(
      runtime.database, new SyntheticCaseRepository(runtime.database), binding.snapshot,
      user.id, 'outpatient.history.read', { entryId, source },
    )
    expect(validate('local-completed', 'prior')).toEqual({ entryId: 'prior', source: 'local-completed' })
    expect(validate('local-completed', 'other-patient')).toBeUndefined()
    expect(validate('visible-source', 'urn:uuid:prior-condition')).toEqual({ entryId: 'urn:uuid:prior-condition', source: 'visible-source' })
    expect(validate('visible-source', 'urn:uuid:index-condition')).toBeUndefined()
  })

  it('rechecks responsibility, materialized patient links, and current resource access at query time', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    createCase(runtime, 'other', 'patient-other')
    materializeHistory(runtime)
    const query = { page: 1, pageSize: 10, source: 'visible-source' as const }
    const read = { entryId: 'urn:uuid:prior-condition', source: 'visible-source' as const }
    expect(() => runtime.workflow.doctorCaseHistory({
      ...doctor, practitionerRoleId: 'practitioner-role-other-doctor',
    }, 'current', query)).toThrow('another doctor')
    expect(() => runtime.workflow.doctorCaseHistoryDetail({
      ...doctor, roleCode: 'administrator',
    }, 'current', read)).toThrow('Practitioner Role')
    runtime.database.driver.prepare(`
      UPDATE synthetic_case_materialization SET patient_id = 'patient-other'
      WHERE workspace_id = ? AND epoch = ? AND outpatient_case_id = 'current'
    `).run(doctor.workspaceId, doctor.epoch)
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', query)).toMatchObject({
      availability: 'no-materialization', items: [], total: 0,
    })
    expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', read)).toThrow('authorized history')
    runtime.database.driver.prepare(`
      UPDATE synthetic_case_materialization SET patient_id = 'patient-current'
      WHERE workspace_id = ? AND epoch = ? AND outpatient_case_id = 'current'
    `).run(doctor.workspaceId, doctor.epoch)
    runtime.database.driver.prepare(`
      UPDATE fhir_resource SET deleted = 1 WHERE workspace_id = ? AND epoch = ?
        AND resource_type = 'Patient' AND resource_id = 'patient-current'
    `).run(doctor.workspaceId, doctor.epoch)
    expect(() => runtime.workflow.doctorCaseHistory(doctor, 'current', query)).toThrow('current outpatient case')
    expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', read)).toThrow('current outpatient case')
  })

  it('distinguishes materialized empty history and out-of-range pages without widening the entry set', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    const caseId = materializeHistory(runtime)
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 3, pageSize: 1, source: 'visible-source',
    })).toMatchObject({ availability: 'available', items: [], page: 3, total: 2 })
    runtime.database.driver.prepare(`
      DELETE FROM synthetic_case_visible_history WHERE workspace_id = ? AND case_id = ?
    `).run(doctor.workspaceId, caseId)
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 1, pageSize: 10, source: 'visible-source',
    })).toMatchObject({ availability: 'no-data', items: [], total: 0 })
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', {
      page: 1, pageSize: 10, source: 'local-completed',
    })).toMatchObject({ availability: 'no-data', items: [], total: 0 })
    expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', {
      entryId: 'urn:uuid:prior-condition', source: 'visible-source',
    })).toThrow('authorized history')
  })

  it('excludes deleted history records and rejects reads after the workspace epoch changes', async () => {
    const runtime = await setup()
    createCase(runtime, 'current', 'patient-current')
    createCase(runtime, 'prior', 'patient-current', { completedAt: '2026-08-20T10:00:00+08:00' })
    const query = { page: 1, pageSize: 10, source: 'local-completed' as const }
    const read = { entryId: 'prior', source: 'local-completed' as const }
    runtime.database.driver.prepare(`
      UPDATE fhir_resource SET deleted = 1 WHERE workspace_id = ? AND epoch = ?
        AND resource_type = 'Encounter' AND resource_id = 'encounter-prior'
    `).run(doctor.workspaceId, doctor.epoch)
    expect(runtime.workflow.doctorCaseHistory(doctor, 'current', query)).toMatchObject({
      availability: 'no-data', items: [], total: 0,
    })
    expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', read)).toThrow('authorized history')
    runtime.database.driver.prepare(`UPDATE workspace SET active_epoch = 'epoch-2' WHERE workspace_id = ?`)
      .run(doctor.workspaceId)
    expect(() => runtime.workflow.doctorCaseHistory(doctor, 'current', query)).toThrow('not current')
    expect(() => runtime.workflow.doctorCaseHistoryDetail(doctor, 'current', read)).toThrow('not current')
  })
})
