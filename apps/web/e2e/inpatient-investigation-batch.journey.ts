import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import type { startBrowserServer } from '../../server/tests/browser-server.ts'
import type { startConsultationCase } from '../../server/tests/fixtures/consultation.ts'
import { expect } from './fixtures.ts'

export async function prepareInpatientInvestigations(page: Page, app: Awaited<ReturnType<typeof startBrowserServer>>, source: Awaited<ReturnType<typeof startConsultationCase>>) {
  const login = async (role: string) => expect((await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
  })).status()).toBe(200)
  const post = (path: string, input: unknown) => page.request.post(`${app.origin}${path}`, {
    headers: { origin: app.origin, 'idempotency-key': randomUUID() }, data: { input },
  })
  await login('registrar')
  const encounter = fhirResourceSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/Encounter/${source.encounterId}`)).json())
  const patientReference = z.object({ reference: z.string() }).parse(encounter.subject).reference
  const patient = fhirResourceSchema.parse(await (await page.request.get(`${app.origin}/fhir/R5/${patientReference}`)).json())
  const session = sessionContextSchema.parse(await (await page.request.get(`${app.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: session.actor.epoch, patientId: patient.id, patientVersion: patient.meta!.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  return { admission, path }
}
