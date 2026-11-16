import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { doctorCaseDetailSchema, doctorCompletedCaseDetailSchema } from '@clinmesh/contracts/his'
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
  const reported = detail.examinationRequests!.requests[0]!,
    report = reported.report!
  const recordedSource = item.runtime.database.driver
    .prepare(
      "SELECT message_text, metadata_json FROM consultation_recording_source WHERE case_id = ? AND source_kind = 'report'",
    )
    .get(visit.outpatientCaseId) as { message_text: string; metadata_json: string } | undefined
  expect(recordedSource?.message_text).toContain(report.technique)
  expect(JSON.parse(recordedSource?.metadata_json ?? '{}')).toMatchObject({
    reportReference: `DiagnosticReport/${report.diagnosticReportId}/_history/${report.diagnosticReportVersion}`,
    reportContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  const ack = await item.runtime.app.request(
    `/api/his/v1/examination-requests/${reported.id}/reports/${report.diagnosticReportId}/actions/acknowledge`,
    mutation(visit.doctor, {
      expectedVersions: { [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion },
      input: { expectedRequestVersion: reported.version },
    }),
  )
  expect(ack.status, await ack.clone().text()).toBe(200)
  const encounterVersions = async () => {
    const res = await item.runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, {
      headers: { cookie: visit.doctor },
    })
    return { [`Encounter/${visit.encounterId}`]: doctorCaseDetailSchema.parse(await res.json()).encounter.versionId }
  }
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/diagnosis/draft`,
        mutation(
          visit.doctor,
          {
            expectedVersions: await encounterVersions(),
            input: { expectedDraftVersion: 0, entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] },
          },
          'PUT',
        ),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/diagnosis/actions/confirm`,
        mutation(visit.doctor, { expectedVersions: await encounterVersions(), input: { expectedDraftVersion: 1 } }),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/medication-conclusion/actions/confirm-no-medication`,
        mutation(visit.doctor, { expectedVersions: await encounterVersions(), input: { expectedDraftVersion: 0 } }),
      )
    ).status,
  ).toBe(200)
  const docDraft = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/clinical-document/draft`,
    mutation(
      visit.doctor,
      {
        expectedVersions: await encounterVersions(),
        input: {
          expectedDraftVersion: 0,
          document: {
            chiefComplaint: '咳嗽三天伴胸闷。',
            historyOfPresentIllness: '患者咳嗽三天，行心电图排查。',
            physicalExamination: '双肺呼吸音粗，心律齐。',
            assessment: '急性支气管炎，心电图正常。',
            disposition: '门诊随访观察。',
            followUp: '症状加重随诊。',
          },
        },
      },
      'PUT',
    ),
  )
  expect(docDraft.status).toBe(200)
  const preview = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/clinical-document/actions/preview-sign`,
    mutation(visit.doctor, {
      expectedVersions: await encounterVersions(),
      input: { expectedDraftVersion: (await docDraft.json()).data.draftVersion },
    }),
  )
  expect(preview.status).toBe(200)
  const previewData = (await preview.json()).data
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/clinical-document/actions/sign`,
        mutation(visit.doctor, {
          expectedVersions: await encounterVersions(),
          input: { previewId: previewData.previewId, commitToken: previewData.commitToken },
        }),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/actions/complete`,
        mutation(visit.doctor, { expectedVersions: await encounterVersions(), input: {} }),
      )
    ).status,
  ).toBe(200)
  const completedRes = await item.runtime.app.request(
    `/api/his/v1/doctor/completed-cases/${visit.outpatientCaseId}`,
    { headers: { cookie: visit.doctor } },
  )
  expect(completedRes.status, await completedRes.clone().text()).toBe(200)
  const completed = doctorCompletedCaseDetailSchema.parse(await completedRes.json())
  expect(completed.examinationRequests).toHaveLength(1)
  expect(completed.timeline.map((event) => event.kind)).toEqual(
    expect.arrayContaining([
      'examination-request-issued',
      'examination-report-issued',
      'examination-report-acknowledged',
    ]),
  )
})
