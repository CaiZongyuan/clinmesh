import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { createPatientResponseSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { insurancePreviewResponseSchema } from '@clinmesh/contracts/insurance'

export async function prepareSettledInsurance(page: Page, app: { origin: string; password: string }) {
  const loginApi = async (name: string) => {
    expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { origin: app.origin },
      data: { email: `${name}@demo.clinmesh.local`, password: app.password } })).status()).toBe(200)
  }
  const request = (path: string, input: unknown, expectedVersions?: object) => page.request.post(`${app.origin}${path}`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input, ...(expectedVersions ? { expectedVersions } : {}) },
  })
  await loginApi('registrar')
  const patient = createPatientResponseSchema.parse(await (await request('/api/his/v1/patients', {
    name: '合成医保更正患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
  }, {})).json()).data.patient
  const admission = inpatientCommandResponseSchema.parse(await (await request('/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await loginApi('ward-nurse')
  const received = inpatientCommandResponseSchema.parse(await (await request(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).json()).data.admission
  await loginApi('admin')
  expect((await request('/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
    expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-27T00:00:00+08:00',
  })).status()).toBe(200)
  await loginApi('inpatient-doctor')
  const issued = inpatientDischargeResponseSchema.parse(await (await request(`${path}/discharge/issue`, { encounterVersion: received.versionId, reason: '合成治疗完成' })).json()).data.admission
  await loginApi('ward-nurse')
  inpatientDischargeResponseSchema.parse(await (await request(`${path}/discharge/depart`, { encounterVersion: issued.versionId, reason: '合成出区核对完成', departureMethod: 'home' })).json())
  await loginApi('cashier')
  const insurance = insurancePreviewResponseSchema.parse(await (await request(`/api/his/v1/insurance/inpatient/${admission.id}/preview`, { planCode: 'employee-v1' }, {})).json()).data
  expect((await request(`/api/his/v1/insurance/inpatient/${admission.id}/confirm`, { previewId: insurance.previewId, commitToken: insurance.commitToken }, {})).status()).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await (await page.request.get(`${app.origin}${path}/discharge/preview`)).json())
  const settled = inpatientSettlementResponseSchema.parse(await (await request(`${path}/discharge/settle`, {
    encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen,
  })).json()).data
  await loginApi('ward-nurse')
  expect((await request(`${path}/discharge/clear`, { encounterVersion: settled.encounterVersion, reason: '合成床位清洁完成' })).status()).toBe(200)
  await loginApi('cashier')
  return { path, admission, settled }
}
