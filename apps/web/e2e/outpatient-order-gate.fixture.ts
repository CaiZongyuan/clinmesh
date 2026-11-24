import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { z } from 'zod'
import {
  clinicalCatalogSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  type ClinicalDocumentContent,
  type DoctorCaseDetail,
} from '@clinmesh/contracts/his'
import { closeQueue, openQueue } from './queue-overlay.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

export const defaultE2eOutpatientGateDocument: ClinicalDocumentContent = {
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

export function stubOutpatientQualityChatPayload(input: {
  schemaName: string
  userPayload: unknown
}): unknown | undefined {
  if (
    input.schemaName !== 'clinical_document_quality'
    && input.schemaName !== 'clinical_document_quality_verification'
  ) {
    return undefined
  }
  const payload = z.object({
    agentFacts: z.array(z.object({ id: z.string() })),
    issues: z.array(z.unknown()).optional(),
  }).parse(input.userPayload)
  return {
    agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })),
    issues: input.schemaName === 'clinical_document_quality_verification'
      ? (payload.issues ?? []).map((_, index) => ({ index, supported: true }))
      : [],
  }
}

async function readDoctorCase(page: Page, origin: string, caseId: string): Promise<DoctorCaseDetail> {
  const response = await page.request.get(`${origin}/api/his/v1/doctor/cases/${caseId}`)
  expect(response.status(), await response.text()).toBe(200)
  return doctorCaseDetailSchema.parse(await response.json())
}

export async function signInitialOutpatientRecordByApi(
  page: Page,
  origin: string,
  caseId: string,
  overrides: Partial<ClinicalDocumentContent> = {},
): Promise<DoctorCaseDetail> {
  const detail = await readDoctorCase(page, origin, caseId)
  if ((detail.clinicalDocument?.signed.length ?? 0) > 0) {
    return detail
  }
  const encounterId = detail.encounter.id
  const expectedVersions = { [`Encounter/${encounterId}`]: detail.encounter.versionId }
  const existingDraft = detail.clinicalDocument?.draft
  const pickField = (field: keyof ClinicalDocumentContent): string => {
    const override = overrides[field]
    if (override !== undefined) return override
    const existing = existingDraft?.[field]
    if (existing !== undefined && existing.trim().length >= 2) return existing
    return defaultE2eOutpatientGateDocument[field] ?? ''
  }
  const document: ClinicalDocumentContent = {
    allergyHistory: pickField('allergyHistory'),
    assessment: pickField('assessment'),
    auxiliaryExamination: pickField('auxiliaryExamination'),
    chiefComplaint: pickField('chiefComplaint'),
    disposition: pickField('disposition'),
    familyHistory: pickField('familyHistory'),
    followUp: pickField('followUp'),
    historyOfPresentIllness: pickField('historyOfPresentIllness'),
    menstrualHistory: pickField('menstrualHistory'),
    obstetricHistory: pickField('obstetricHistory'),
    physicalExamination: pickField('physicalExamination'),
    priorMedicalHistory: pickField('priorMedicalHistory'),
  }
  const draftResponse = await page.request.fetch(
    `${origin}/api/his/v1/encounters/${encounterId}/clinical-document/draft`,
    {
      data: {
        expectedVersions,
        input: {
          document,
          expectedDraftVersion: existingDraft?.version ?? 0,
        },
      },
      headers: { 'idempotency-key': randomUUID(), origin },
      method: 'PUT',
    },
  )
  expect(draftResponse.status(), await draftResponse.text()).toBe(200)
  const draft = clinicalDocumentDraftResponseSchema.parse(await draftResponse.json()).data

  const previewResponse = await page.request.fetch(
    `${origin}/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`,
    {
      data: {
        expectedVersions,
        input: { expectedDraftVersion: draft.draftVersion },
      },
      headers: { 'idempotency-key': randomUUID(), origin },
      method: 'POST',
    },
  )
  expect(previewResponse.status(), await previewResponse.text()).toBe(200)
  const preview = clinicalDocumentSignPreviewResponseSchema.parse(await previewResponse.json()).data

  const signResponse = await page.request.fetch(
    `${origin}/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`,
    {
      data: {
        expectedVersions,
        input: { commitToken: preview.commitToken, previewId: preview.previewId },
      },
      headers: { 'idempotency-key': randomUUID(), origin },
      method: 'POST',
    },
  )
  expect(signResponse.status(), await signResponse.text()).toBe(200)
  clinicalDocumentSignResponseSchema.parse(await signResponse.json())
  return readDoctorCase(page, origin, caseId)
}

export async function confirmPrimaryOutpatientDiagnosisByApi(
  page: Page,
  origin: string,
  caseId: string,
  diagnosisCatalogItemId?: string,
): Promise<DoctorCaseDetail> {
  const detail = await readDoctorCase(page, origin, caseId)
  if (detail.diagnosis?.confirmation?.entries.some(entry => entry.role === 'primary')) {
    return detail
  }
  let resolvedId = diagnosisCatalogItemId
  if (resolvedId === undefined) {
    const catalogResponse = await page.request.get(`${origin}/api/his/v1/catalogs/clinical`)
    expect(catalogResponse.status(), await catalogResponse.text()).toBe(200)
    const catalog = clinicalCatalogSchema.parse(await catalogResponse.json())
    resolvedId = catalog.diagnoses[0]?.id
  }
  if (resolvedId === undefined) {
    throw new Error('Expected at least one diagnosis item in the outpatient clinical catalog')
  }
  const encounterId = detail.encounter.id
  const expectedVersions = { [`Encounter/${encounterId}`]: detail.encounter.versionId }
  const draftResponse = await page.request.fetch(
    `${origin}/api/his/v1/encounters/${encounterId}/diagnosis/draft`,
    {
      data: {
        expectedVersions,
        input: {
          entries: [{ catalogItemId: resolvedId, role: 'primary' }],
          expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
        },
      },
      headers: { 'idempotency-key': randomUUID(), origin },
      method: 'PUT',
    },
  )
  expect(draftResponse.status(), await draftResponse.text()).toBe(200)
  const draft = diagnosisDraftResponseSchema.parse(await draftResponse.json()).data

  const confirmResponse = await page.request.fetch(
    `${origin}/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`,
    {
      data: {
        expectedVersions,
        input: { expectedDraftVersion: draft.draftVersion },
      },
      headers: { 'idempotency-key': randomUUID(), origin },
      method: 'POST',
    },
  )
  expect(confirmResponse.status(), await confirmResponse.text()).toBe(200)
  confirmDiagnosisResponseSchema.parse(await confirmResponse.json())
  return readDoctorCase(page, origin, caseId)
}

async function reloadAndSelectInProgressCase(
  page: Page,
  origin: string,
  caseId: string,
  patientName: string,
): Promise<void> {
  const queueResponse = await page.request.get(`${origin}/api/his/v1/doctor/queue`)
  expect(queueResponse.status(), await queueResponse.text()).toBe(200)
  const queue = doctorQueueSchema.parse(await queueResponse.json())
  const firstInProgress = queue.items.find(
    item => item.status === 'first-visit' || item.status === 'revisit-draft',
  )
  await page.reload()
  await expect(page.locator('[data-agent-section]').first()).toBeAttached()
  const currentPatient = page.getByRole('region', { name: '当前患者' })
  if (firstInProgress?.caseId === caseId) {
    await expect(currentPatient.getByRole('heading', { name: patientName, exact: true })).toBeVisible()
    return
  }
  await expect(currentPatient).toBeVisible()
  const expandOverlay = page.getByRole('button', { name: '展开队列', exact: true })
  const expandRail = page.getByRole('button', { name: /^候诊队列 ·/ })
  if (await expandOverlay.isVisible()) {
    await openQueue(page)
  } else if (await expandRail.isVisible()) {
    await expandRail.click()
  }
  await page.getByRole('tab', { name: '在诊', exact: true }).click()
  await page.getByRole('button', { name: `选择病例 ${patientName}`, exact: true }).click()
  if (await expandOverlay.isVisible() && (await expandOverlay.getAttribute('aria-expanded')) === 'true') {
    await closeQueue(page)
  }
  await expect(currentPatient.getByRole('heading', { name: patientName, exact: true })).toBeVisible()
}

export async function signInitialOutpatientRecordAndRefresh(
  page: Page,
  origin: string,
  caseId: string,
  overrides: Partial<ClinicalDocumentContent> = {},
): Promise<DoctorCaseDetail> {
  const detail = await signInitialOutpatientRecordByApi(page, origin, caseId, overrides)
  await reloadAndSelectInProgressCase(page, origin, detail.caseId, detail.patient.name)
  return detail
}

export async function satisfyOutpatientOrderPrerequisitesAndRefresh(
  page: Page,
  origin: string,
  caseId: string,
  options: {
    diagnosisCatalogItemId?: string
    documentOverrides?: Partial<ClinicalDocumentContent>
  } = {},
): Promise<DoctorCaseDetail> {
  await signInitialOutpatientRecordByApi(page, origin, caseId, options.documentOverrides)
  const detail = await confirmPrimaryOutpatientDiagnosisByApi(page, origin, caseId, options.diagnosisCatalogItemId)
  await reloadAndSelectInProgressCase(page, origin, detail.caseId, detail.patient.name)
  return detail
}

export async function satisfyActiveInProgressOutpatientOrderPrerequisitesAndRefresh(
  page: Page,
  origin: string,
): Promise<DoctorCaseDetail> {
  const queueResponse = await page.request.get(`${origin}/api/his/v1/doctor/queue`)
  expect(queueResponse.status(), await queueResponse.text()).toBe(200)
  const queue = doctorQueueSchema.parse(await queueResponse.json())
  const active = queue.items.find(item => item.status === 'first-visit' || item.status === 'revisit-draft')
  if (active === undefined) {
    throw new Error('Expected an in-progress outpatient case in the doctor queue')
  }
  return satisfyOutpatientOrderPrerequisitesAndRefresh(page, origin, active.caseId)
}

export async function signInitialOutpatientRecordInWorkspace(
  page: Page,
  overrides: Partial<ClinicalDocumentContent> = {},
): Promise<void> {
  await openWorkspaceTab(page, '病历记录')
  const requiredFields: ReadonlyArray<readonly [string, keyof ClinicalDocumentContent]> = [
    ['主诉', 'chiefComplaint'],
    ['现病史', 'historyOfPresentIllness'],
    ['体格检查', 'physicalExamination'],
    ['评估', 'assessment'],
    ['处置', 'disposition'],
    ['随访', 'followUp'],
  ]
  for (const [label, field] of requiredFields) {
    const input = page.getByLabel(label, { exact: true })
    const override = overrides[field]
    if (override !== undefined) {
      await input.fill(override)
      continue
    }
    if ((await input.inputValue()).trim().length < 2) {
      await input.fill(defaultE2eOutpatientGateDocument[field] ?? '')
    }
  }
  await page.getByRole('button', { name: '签署病历', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '确认签署病历', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
