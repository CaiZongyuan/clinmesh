import { doctorCaseDetailSchema, clinicalDocumentQualityControlStateSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { documentQualityFixture, qualityPatientReply } from './doctor-document-quality-fixture.ts'
import { runDocumentQualityJourney } from './doctor-document-quality-journey.ts'

test('keeps triage prefill saved when automatic recording only updates another field', async ({ page, webRoot }) => {
  const reply = '站起来时头晕更明显。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-quality-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 30,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      if (input.schemaName === 'consultation_history_increment') {
        const { turns } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })).min(1) }).parse(input.userPayload)
        const source = turns.at(-1)!
        return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness', relation: 'addition',
          sourceTurnId: source.id, quote: source.messageText }] }), model: 'synthetic' }
      }
      throw new Error(`Unexpected synthetic model schema: ${input.schemaName}`)
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('什么时候头晕更明显？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText(reply, { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toContain(reply)
    expect((await read()).clinicalDocument?.draft?.chiefComplaint).toBe('')
    expect((await read()).consultationRecording?.hasSavedDraft).toBe(false)
    const banner = page.getByRole('region', { name: '当前患者', exact: true })
    const chiefComplaint = page.getByLabel('主诉', { exact: true })
    const reopen = async () => {
      await page.reload()
      await page.getByRole('tab', { name: '在诊', exact: true }).click()
      await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    }
    await reopen()
    await expect(chiefComplaint).toHaveValue('反复头晕一周')
    await expect(banner).toContainText('主诉：反复头晕一周')
    await expect(banner.getByText('未保存', { exact: true })).toHaveCount(0)
    await chiefComplaint.fill('')
    await expect(banner.getByText('未保存', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).consultationRecording?.hasSavedDraft).toBe(true)
    await reopen()
    await expect(chiefComplaint).toHaveValue('')
    await expect(banner).toContainText('主诉：未记录')
    await expect(banner.getByText('未保存', { exact: true })).toHaveCount(0)
  } finally { await server.close() }
})

test('edits document quality issues directly and signs without individual review decisions', async ({ page, webRoot }) => {
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-quality-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 30,
    qualityCompletions: async input => ({ content: JSON.stringify(documentQualityFixture(input)), model: 'synthetic' }),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: qualityPatientReply }), model: 'synthetic' }
      if (input.schemaName === 'consultation_history_increment') return { content: JSON.stringify({ additions: [] }), model: 'synthetic' }
      if (['clinical_document_quality', 'clinical_document_quality_verification'].includes(input.schemaName)) {
        return { content: JSON.stringify(documentQualityFixture(input)), model: 'synthetic' }
      }
      throw new Error(`Unexpected synthetic model schema: ${input.schemaName}`)
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const banner = page.getByRole('region', { name: '当前患者', exact: true })
    const chiefComplaint = page.getByLabel('主诉', { exact: true })
    await chiefComplaint.fill('头晕三周，医生重新问诊后记录。')
    const draftUrl = `${server.origin}/api/his/v1/encounters/${started.encounterId}/clinical-document/draft`
    await page.route(draftUrl, route => {
      const body = route.request().postDataJSON()
      return route.continue({ postData: JSON.stringify({ ...body, input: { ...body.input, expectedDraftVersion: 999 } }) })
    })
    const failedSave = page.waitForResponse(response => response.url() === draftUrl && response.request().method() === 'PUT')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    expect((await failedSave).status()).toBe(409)
    await expect(chiefComplaint).toHaveValue('头晕三周，医生重新问诊后记录。')
    await expect(banner).toContainText('主诉：头晕三周，医生重新问诊后记录。')
    await expect(banner).toContainText('未保存')
    await page.unroute(draftUrl)
    await chiefComplaint.fill('')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.chiefComplaint).toBe('')
    await page.reload()
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await page.locator(`[data-agent-selection="${started.outpatientCaseId}"]`).click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(chiefComplaint).toHaveValue('')
    await expect(banner).toContainText('主诉：未记录')
    expect(await runDocumentQualityJourney({ page, read,
      quality: async clientId => {
        const response = await page.request.get(`${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}/document-quality-control${clientId === undefined ? '' : `?clientId=${encodeURIComponent(clientId)}`}`)
        expect(response.status()).toBe(200)
        return clinicalDocumentQualityControlStateSchema.parse(await response.json())
      },
    })).toEqual({ signedCount: 1, editedDirectly: true, agentSourceChecked: false })
    expect(errors).toEqual([])
  } finally { await server.close() }
})
