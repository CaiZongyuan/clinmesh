import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

test('patient answers update the visible history without another instruction and preserve unsaved human input', async ({ page, webRoot }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: '头晕一周了，站起来时更明显。' }), model: 'synthetic' }
      await held
      const turns = (input.userPayload as { turns: Array<{ id: string }> }).turns
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness',
        sourceTurnId: turns.at(-1)!.id, quote: '头晕一周了，站起来时更明显。', relation: 'addition' }] }), model: 'synthetic' }
    } },
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const beforeChiefComplaint = await page.getByLabel('主诉', { exact: true }).inputValue()
    const beforePhysicalExamination = await page.getByLabel('查体', { exact: true }).inputValue()
    const beforePriorHistory = await page.getByLabel('既往史', { exact: true }).inputValue()
    expect(beforeChiefComplaint).not.toBe('')
    expect(beforePhysicalExamination).not.toBe('')
    expect(beforePriorHistory).not.toBe('')
    await page.getByLabel('评估', { exact: true }).fill('医生尚未保存的评估。')
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('头晕多久了？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText('头晕一周了，站起来时更明显。', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'processing')
    release()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
    await expect(page.getByText('自动新增', { exact: true })).toBeVisible()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了，站起来时更明显。')
    await expect(page.getByLabel('评估', { exact: true })).toHaveValue('医生尚未保存的评估。')
    await expect(page.getByLabel('主诉', { exact: true })).toHaveValue(beforeChiefComplaint)
    await expect(page.getByLabel('查体', { exact: true })).toHaveValue(beforePhysicalExamination)
    await expect(page.getByLabel('既往史', { exact: true })).toHaveValue(beforePriorHistory)
    // 自动草稿尚未人工保存时，刷新也应保留未涉及字段的分诊与既往事实预填。
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了，站起来时更明显。')
    await expect(page.getByLabel('主诉', { exact: true })).toHaveValue(beforeChiefComplaint)
    await expect(page.getByLabel('查体', { exact: true })).toHaveValue(beforePhysicalExamination)
    await expect(page.getByLabel('既往史', { exact: true })).toHaveValue(beforePriorHistory)
    const automatic = doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`,
    )).json())
    expect(automatic.consultationRecording?.hasSavedDraft).toBe(false)
    await page.getByLabel('评估', { exact: true }).fill('医生尚未保存的评估。')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect(page.getByText('病历草稿已保存', { exact: true })).toBeVisible()
    const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    expect(detail.clinicalDocument?.draft?.assessment).toBe('医生尚未保存的评估。')
    expect(detail.clinicalDocument?.draft?.chiefComplaint).toBe(beforeChiefComplaint)
    expect(detail.clinicalDocument?.draft?.physicalExamination).toBe(beforePhysicalExamination)
    expect(detail.clinicalDocument?.draft?.priorMedicalHistory).toBe(beforePriorHistory)
    expect(detail.consultationRecording?.hasSavedDraft).toBe(true)
    expect(detail.consultationRecording?.additions[0]?.sourceTurnId).toBe(detail.consultation?.turns.at(-1)?.id)
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了，站起来时更明显。')
    await expect(page.getByLabel('主诉', { exact: true })).toHaveValue(beforeChiefComplaint)
    await expect(page.getByLabel('查体', { exact: true })).toHaveValue(beforePhysicalExamination)
    await expect(page.getByLabel('既往史', { exact: true })).toHaveValue(beforePriorHistory)
    await page.getByLabel('主诉', { exact: true }).fill('')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`,
    )).json()).clinicalDocument?.draft?.chiefComplaint).toBe('')
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('主诉', { exact: true })).toHaveValue('')
    expect(errors).toEqual([])
  } finally {
    release()
    await server.close()
  }
})
