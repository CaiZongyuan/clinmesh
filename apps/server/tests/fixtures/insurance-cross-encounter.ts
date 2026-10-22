import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { registrationCatalogSchema, registrationResponseSchema, triageResponseSchema, doctorQueueSchema, startVisitResponseSchema,
  firstVisitDraftResponseSchema, laboratoryOrderResponseSchema } from '@clinmesh/contracts/his'
import { insurancePreviewResponseSchema, insuranceResponseSchema, insuranceStateSchema } from '@clinmesh/contracts/insurance'
import type { inpatientInsuranceFixture } from './insurance-inpatient.ts'

/** Build a same-patient competitor through the public outpatient workflow with a synthetic price. */
export async function outpatientInsuranceCompetitor(s: Awaited<ReturnType<typeof inpatientInsuranceFixture>>) {
  s.runtime.database.driver.prepare("UPDATE outpatient_catalog SET price_fen=4000 WHERE item_id='lab-fever-panel'").run()
  async function command(role: string, path: string, input: unknown, expectedVersions: Record<string, string> = {}, method = 'POST') {
    const response = await s.runtime.app.request(path, { method,
      headers: { cookie: await s.login(role), origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ input, expectedVersions }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }
  const catalog = registrationCatalogSchema.parse(await (await s.request('registrar', '/api/his/v1/catalogs/registration')).json())
  const registration = registrationResponseSchema.parse(await command('registrar', '/api/his/v1/registrations/actions/register', {
    patientId: s.patient.id, departmentId: 'department-general-medicine', locationId: 'location-outpatient', visitDate: catalog.virtualDate, visitTypeId: 'visit-general',
  }, { [`Patient/${s.patient.id}`]: s.patient.versionId })).data
  const encounter = `Encounter/${registration.encounterId}`
  const triage = triageResponseSchema.parse(await command('triage', `/api/his/v1/encounters/${registration.encounterId}/actions/record-triage`, {
    acuityCode: 'level-3', chiefComplaint: '合成医保竞争检验', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
    oxygenSaturationPct: 98, pulseBpm: 80, respirationBpm: 20, temperatureC: 36.5,
  }, { [encounter]: '1', [`Task/${registration.queueTaskId}`]: '1' })).data
  const queue = doctorQueueSchema.parse(await (await s.request('doctor', '/api/his/v1/doctor/queue?pageSize=20')).json())
  const caseId = queue.items.find(row => row.encounterId === registration.encounterId)!.caseId
  const task = `Task/${triage.doctorTaskId}`
  const visit = startVisitResponseSchema.parse(await command('doctor', `/api/his/v1/encounters/${registration.encounterId}/actions/start-first-visit`, {}, {
    [encounter]: triage.encounterVersion, [task]: '1',
  })).data
  const draft = firstVisitDraftResponseSchema.parse(await command('doctor', `/api/his/v1/encounters/${registration.encounterId}/drafts/first-visit`, {
    expectedDraftVersion: 0, assessment: '合成医保测试', historyOfPresentIllness: '合成发热一天',
  }, { [encounter]: visit.encounterVersion }, 'PUT')).data
  laboratoryOrderResponseSchema.parse(await command('doctor', `/api/his/v1/encounters/${registration.encounterId}/actions/issue-laboratory-order`, {
    catalogItemId: 'lab-fever-panel', expectedDraftVersion: draft.draftVersion, indicationCode: 'fever',
  }, { [encounter]: visit.encounterVersion, [task]: visit.taskVersion }))
  const path = `/api/his/v1/insurance/outpatient/${caseId}`
  return {
    preview: async () => insurancePreviewResponseSchema.parse(await command('cashier', `${path}/preview`, { planCode: 'employee-v1' })).data,
    confirm: async (preview: { previewId: string; commitToken: string }) => insuranceResponseSchema.parse(await command('cashier', `${path}/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })).data,
    read: async () => insuranceStateSchema.parse(await (await s.request('cashier', path)).json()),
  }
}
