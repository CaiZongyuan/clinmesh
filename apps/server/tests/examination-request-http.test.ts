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
import { defaultOutpatientGateDocument, satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'

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
  const prereq = await satisfyOutpatientOrderPrerequisites(item.runtime, visit.doctor, visit.outpatientCaseId)
  const saved = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/draft`,
    mutation(
      visit.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: prereq.encounterVersion },
        input: { expectedDraftVersion: 0, serviceId: 'examination-ecg-12-lead', indication: '胸部不适评估' },
      },
      'PUT',
    ),
  )
  expect(saved.status, await saved.clone().text()).toBe(200)
  const issued = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/examination-request/actions/issue`,
    mutation(visit.doctor, {
      expectedVersions: { [`Encounter/${visit.encounterId}`]: prereq.encounterVersion },
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
  const ack = await item.runtime.app.request(
    `/api/his/v1/examination-requests/${reported.id}/reports/${report.diagnosticReportId}/actions/acknowledge`,
    mutation(visit.doctor, {
      expectedVersions: { [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion },
      input: { expectedRequestVersion: reported.version },
    }),
  )
  expect(ack.status, await ack.clone().text()).toBe(200)
  const readDetail = async () => {
    const res = await item.runtime.app.request(`/api/his/v1/doctor/cases/${visit.outpatientCaseId}`, {
      headers: { cookie: visit.doctor },
    })
    return doctorCaseDetailSchema.parse(await res.json())
  }
  const encounterVersions = async () => ({
    [`Encounter/${visit.encounterId}`]: (await readDetail()).encounter.versionId,
  })
  const beforeDiag = await readDetail()
  const diagDraft = await item.runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/diagnosis/draft`,
    mutation(
      visit.doctor,
      {
        expectedVersions: { [`Encounter/${visit.encounterId}`]: beforeDiag.encounter.versionId },
        input: {
          expectedDraftVersion: beforeDiag.diagnosis?.draftVersion ?? 0,
          entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }],
        },
      },
      'PUT',
    ),
  )
  expect(diagDraft.status, await diagDraft.clone().text()).toBe(200)
  expect(
    (
      await item.runtime.app.request(
        `/api/his/v1/encounters/${visit.encounterId}/diagnosis/actions/confirm`,
        mutation(visit.doctor, {
          expectedVersions: await encounterVersions(),
          input: { expectedDraftVersion: (await diagDraft.json()).data.draftVersion },
        }),
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
  const revisedDoc = await item.runtime.app.request(
    `/api/his/v1/clinical-documents/${prereq.compositionId}/actions/revise`,
    mutation(visit.doctor, {
      expectedVersions: {
        ...(await encounterVersions()),
        [`Composition/${prereq.compositionId}`]: prereq.compositionVersion,
      },
      input: {
        document: {
          ...defaultOutpatientGateDocument,
          chiefComplaint: '咳嗽三天伴胸闷。',
          historyOfPresentIllness: '患者咳嗽三天，行心电图排查。',
          physicalExamination: '双肺呼吸音粗，心律齐。',
          assessment: '急性支气管炎，心电图正常。',
          disposition: '门诊随访观察。',
          followUp: '症状加重随诊。',
        },
        reason: '心电图检查回报后完善病历。',
      },
    }),
  )
  expect(revisedDoc.status, await revisedDoc.clone().text()).toBe(200)
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
