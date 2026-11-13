import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import {
  acuteBronchitis,
  caseBundle,
  createImagingRuntime,
  generateCase,
  mutation,
  signIn,
  startConsultation,
} from './fixtures/imaging-scenario.ts'

const created: Awaited<ReturnType<typeof createImagingRuntime>>[] = []
afterEach(async () => {
  for (const item of created.splice(0)) {
    await item.runtime.close()
    await rm(item.directory, { recursive: true, force: true })
  }
})

it('offers pixel-free ECG/TTE and freezes a normal adult report after payment', async () => {
  const bundle = caseBundle({
    gender: 'male',
    index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
    name: '功能检查合成患者',
  })
  bundle.entry = bundle.entry.filter((entry) => entry.resource.id !== 'prior-fact-0')
  const item = await createImagingRuntime([bundle], { persona: true })
  created.push(item)
  const admin = await signIn(item.runtime)
  const source = await generateCase(item.runtime, admin)
  const visit = await startConsultation(item.runtime, admin, source)
  const catalog = await item.runtime.app.request(
    `/api/his/v1/doctor/cases/${visit.outpatientCaseId}/examination-services`,
    { headers: { cookie: visit.doctor } },
  )
  expect(catalog.status).toBe(200)
  expect(
    (await catalog.json()).items.map((entry: { service: { examCode: string } }) => entry.service.examCode),
  ).toEqual(['ecg-12-lead', 'tte'])
  const saved = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
    mutation(
      visit.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
        input: { expectedDraftVersion: 0, serviceId: 'examination-ecg-12-lead', indication: '胸部不适评估' },
      },
      'PUT',
    ),
  )
  expect(saved.status, await saved.clone().text()).toBe(200)
  const issued = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
    mutation(visit.doctor, {
      expectedVersions: { [`Encounter/${visit.encounterId}`]: '3' },
      input: { expectedDraftVersion: 1 },
    }),
  )
  expect(issued.status, await issued.clone().text()).toBe(200)
  const request = (await issued.json()).data.request
  expect(request.billing.price.priceFen).toBe(3000)
  const { payOutpatientInvestigation } = await import('./fixtures/pay-outpatient-investigation.ts')
  await payOutpatientInvestigation(item.runtime, {
    caseId: visit.outpatientCaseId,
    category: 'examination',
    chargeItemId: request.billing.chargeItemId,
  })
  while ((await item.runtime.dispatcher.dispatchOnce()) !== undefined) {}
  const response = await item.runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, {
    headers: { cookie: visit.doctor },
  })
  const detail = doctorCaseDetailSchema.parse(await response.json())
  expect(
    detail.examinationRequests?.requests[0]?.report?.results.find((result) => result.code === 'ventricular-rate')
      ?.value,
    JSON.stringify(detail.examinationRequests),
  ).toBe(72)
  expect(detail.examinationRequests?.requests[0]?.status).toBe('reported')
})
