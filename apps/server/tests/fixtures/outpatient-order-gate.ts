import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  startVisitResponseSchema,
  type ClinicalDocumentContent,
} from '@clinmesh/contracts/his'
import type { createClinMeshRuntime } from '../../src/runtime.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

export const defaultOutpatientGateDocument: ClinicalDocumentContent = {
  allergyHistory: '否认已知药物过敏。',
  assessment: '初步临床评估已完成，拟进一步完善检查及诊疗方案。',
  auxiliaryExamination: '暂无本院辅助检查结果。',
  chiefComplaint: '合成门诊主诉不适。',
  disposition: '门诊完善相关检查并对症处理。',
  familyHistory: '否认特殊家族遗传病史。',
  followUp: '检查回报或症状变化及时复诊。',
  historyOfPresentIllness: '患者自述近期出现上述不适，生命体征平稳。',
  menstrualHistory: '患者自述既往月经规律或已绝经。',
  obstetricHistory: '患者自述既往婚育史无特殊。',
  physicalExamination: '神志清楚，查体合作，心肺腹未见明显急性体征。',
  priorMedicalHistory: '既往病史如病例记录所示。',
}

function commandInit(
  cookie: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
  origin = 'http://localhost',
) {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
      origin,
    },
    method,
  }
}

async function ensureConsultationStarted(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  origin: string,
) {
  let detailResponse = await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, {
    headers: { cookie: doctorCookie },
  })
  assert.equal(detailResponse.status, 200)
  let detail = doctorCaseDetailSchema.parse(await detailResponse.json())
  if (detail.status === 'awaiting-doctor') {
    const startResponse = await runtime.app.request(
      `/api/his/v1/encounters/${detail.encounter.id}/actions/start-first-visit`,
      commandInit(
        doctorCookie,
        {
          expectedVersions: {
            [`Encounter/${detail.encounter.id}`]: detail.encounter.versionId,
            [`Task/${detail.taskId}`]: detail.taskVersion,
          },
          input: {},
        },
        'POST',
        origin,
      ),
    )
    assert.equal(startResponse.status, 200, await startResponse.clone().text())
    startVisitResponseSchema.parse(await startResponse.json())
    detailResponse = await runtime.app.request(`/api/his/v1/doctor/cases/${caseId}`, {
      headers: { cookie: doctorCookie },
    })
    assert.equal(detailResponse.status, 200)
    detail = doctorCaseDetailSchema.parse(await detailResponse.json())
  }
  return detail
}

export async function signInitialOutpatientDocument(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  overrides: Partial<ClinicalDocumentContent> = {},
  origin = 'http://localhost',
) {
  const detail = await ensureConsultationStarted(runtime, doctorCookie, caseId, origin)
  const existingSigned = detail.clinicalDocument?.signed.at(-1)
  if (existingSigned !== undefined) {
    return {
      compositionId: existingSigned.compositionId,
      compositionVersion: existingSigned.compositionVersion,
      documentId: existingSigned.documentId,
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
    }
  }
  const encounterId = detail.encounter.id
  const encounterVersion = detail.encounter.versionId
  const expectedVersions = { [`Encounter/${encounterId}`]: encounterVersion }
  const document: ClinicalDocumentContent = {
    ...defaultOutpatientGateDocument,
    ...overrides,
  }
  const savedResponse = await runtime.app.request(
    `/api/his/v1/encounters/${encounterId}/clinical-document/draft`,
    commandInit(
      doctorCookie,
      {
        expectedVersions,
        input: {
          document,
          expectedDraftVersion: detail.clinicalDocument?.draft?.version ?? 0,
        },
      },
      'PUT',
      origin,
    ),
  )
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text())
  const saved = clinicalDocumentDraftResponseSchema.parse(await savedResponse.json()).data

  const previewResponse = await runtime.app.request(
    `/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`,
    commandInit(
      doctorCookie,
      {
        expectedVersions,
        input: { expectedDraftVersion: saved.draftVersion },
      },
      'POST',
      origin,
    ),
  )
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text())
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data

  const signedResponse = await runtime.app.request(
    `/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`,
    commandInit(
      doctorCookie,
      {
        expectedVersions,
        input: {
          commitToken: preview.commitToken,
          previewId: preview.previewId,
        },
      },
      'POST',
      origin,
    ),
  )
  assert.equal(signedResponse.status, 200, await signedResponse.clone().text())
  const signed = clinicalDocumentSignResponseSchema.parse(await signedResponse.json()).data
  return {
    compositionId: signed.compositionId,
    compositionVersion: signed.compositionVersion,
    documentId: signed.documentId,
    encounterId,
    encounterVersion,
  }
}

export async function confirmPrimaryOutpatientDiagnosis(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  catalogItemId = 'diagnosis-influenza',
  options: { forceReconfirm?: boolean | undefined; origin?: string | undefined } = {},
) {
  const origin = options.origin ?? 'http://localhost'
  const detail = await ensureConsultationStarted(runtime, doctorCookie, caseId, origin)
  if (detail.diagnosis?.confirmation !== undefined && options.forceReconfirm !== true) {
    return {
      confirmationId: detail.diagnosis.confirmation.id,
      diagnosisVersion: detail.diagnosis.draftVersion,
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
    }
  }
  const encounterId = detail.encounter.id
  const expectedVersions = { [`Encounter/${encounterId}`]: detail.encounter.versionId }
  const draftResponse = await runtime.app.request(
    `/api/his/v1/encounters/${encounterId}/diagnosis/draft`,
    commandInit(
      doctorCookie,
      {
        expectedVersions,
        input: {
          entries: [{ catalogItemId, role: 'primary' as const }],
          expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
        },
      },
      'PUT',
      origin,
    ),
  )
  assert.equal(draftResponse.status, 200, await draftResponse.clone().text())
  const draft = diagnosisDraftResponseSchema.parse(await draftResponse.json()).data

  const confirmResponse = await runtime.app.request(
    `/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`,
    commandInit(
      doctorCookie,
      {
        expectedVersions,
        input: { expectedDraftVersion: draft.draftVersion },
      },
      'POST',
      origin,
    ),
  )
  assert.equal(confirmResponse.status, 200, await confirmResponse.clone().text())
  const confirmed = confirmDiagnosisResponseSchema.parse(await confirmResponse.json()).data
  return {
    confirmationId: confirmed.confirmation.id,
    diagnosisVersion: confirmed.diagnosisVersion,
    encounterId,
    encounterVersion: confirmed.encounterVersion,
  }
}

export async function satisfyOutpatientOrderPrerequisites(
  runtime: Runtime,
  doctorCookie: string,
  caseId: string,
  options: {
    diagnosisCatalogItemId?: string | undefined
    document?: Partial<ClinicalDocumentContent> | undefined
    origin?: string | undefined
  } = {},
) {
  const signed = await signInitialOutpatientDocument(
    runtime,
    doctorCookie,
    caseId,
    options.document,
    options.origin,
  )
  const diagnosis = await confirmPrimaryOutpatientDiagnosis(
    runtime,
    doctorCookie,
    caseId,
    options.diagnosisCatalogItemId,
    { origin: options.origin },
  )
  return {
    ...signed,
    confirmationId: diagnosis.confirmationId,
    diagnosisVersion: diagnosis.diagnosisVersion,
    encounterVersion: diagnosis.encounterVersion,
  }
}
