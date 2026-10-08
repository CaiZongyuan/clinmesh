import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

for (const existingAutomaticDraft of [false, true]) {
  test(`appends the first automatic history to unsaved prefill in a ${existingAutomaticDraft ? 'previously created' : 'new'} draft`, async ({ page, webRoot }) => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let reply = '反复头晕一周。'
    let field = existingAutomaticDraft ? 'chiefComplaint' : 'historyOfPresentIllness'
    const server = await startBrowserServer(webRoot, {
      dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
      syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
      chatCompletionsProvider: { async completeJson(input) {
        if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
        if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
        if (field === 'historyOfPresentIllness') await held
        const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
        return { content: JSON.stringify({ additions: [{ field, sourceTurnId: turns.at(-1)!.id,
          quote: turns.at(-1)!.messageText, relation: 'addition' }] }), model: 'synthetic' }
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
      const ask = async () => {
        await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
        await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充病史？')
        await page.getByRole('button', { name: '向患者提问', exact: true }).click()
        await expect(page.getByText(reply, { exact: true })).toBeVisible()
        await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      }
      const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
        `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
      if (existingAutomaticDraft) {
        await ask()
        await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
        expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('')
      } else await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      const history = page.getByLabel('现病史', { exact: true })
      expect(await history.inputValue()).not.toBe('')
      const manual = '医生核对：头晕五天。\n医生补充：站立时加重。'
      await history.fill(manual)
      reply = '夜间也会头晕。'
      field = 'historyOfPresentIllness'
      await ask()
      await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'processing')
      release()
      await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
      const expected = `${manual}\n患者自述：${reply}`
      await expect(history).toHaveValue(expected)
      await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
      await expect(page.getByText('病历草稿已保存', { exact: true })).toBeVisible()
      expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(expected)
      expect((await read()).consultationRecording?.additions.at(-1)).toMatchObject({
        status: 'applied', ownership: 'automatic', currentText: `患者自述：${reply}`,
      })
      await page.reload()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      await expect(history).toHaveValue(expected)
    } finally {
      release()
      await server.close()
    }
  })
}

test('patient answers update the visible history without another instruction and preserve unsaved human input', async ({ page, webRoot }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reply = '头晕一周了，站起来时更明显。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      await held
      const { turns, history } = input.userPayload as { turns: Array<{ id: string; messageText: string }>; history: Array<{ id: string; quote: string }> }
      const correction = turns.at(-1)!.messageText.startsWith('刚才说错了')
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness',
        sourceTurnId: turns.at(-1)!.id, quote: turns.at(-1)!.messageText, relation: correction ? 'correction' : 'addition',
        ...(correction ? { targetAdditionId: history[0]!.id } : {}) }] }), model: 'synthetic' }
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
    // 自动草稿尚未人工保存时，刷新保留未涉及字段的分诊与既往事实预填。
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
    const historyField = page.getByLabel('现病史', { exact: true })
    await historyField.fill('医生核对：头晕五天，站起来时更明显。')
    reply = '夜间也会头晕。'
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('夜间有没有头晕？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText('夜间也会头晕。', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(historyField).toHaveValue('医生核对：头晕五天，站起来时更明显。\n患者自述：夜间也会头晕。')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json()).consultationRecording?.additions[0]?.ownership).toBe('manual')
    reply = '刚才说错了，头晕是六天。'
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('再核对一次持续时间？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText(reply, { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.locator('[data-consultation-addition="pending"]')).toContainText('医生核对：头晕五天，站起来时更明显。')
    await expect(page.locator('[data-consultation-addition="pending"]')).toContainText('患者原回答')
    await historyField.fill('医生核对：头晕五天，站起来时更明显。\n患者自述：夜间也会头晕。\n医生补充：暂未查体。')
    await expect(page.getByRole('button', { name: '接受替换', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect(page.getByRole('button', { name: '接受替换', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '接受替换', exact: true }).click()
    await expect(historyField).toHaveValue('患者自述：刚才说错了，头晕是六天。\n患者自述：夜间也会头晕。\n医生补充：暂未查体。')
    await expect(page.locator('[data-consultation-addition="pending"]')).toHaveCount(0)
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(historyField).toHaveValue('患者自述：刚才说错了，头晕是六天。\n患者自述：夜间也会头晕。\n医生补充：暂未查体。')
    await expect(page.getByLabel('评估', { exact: true })).toHaveValue('医生尚未保存的评估。')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect(page.getByText('病历草稿已保存', { exact: true })).toBeVisible()
    const detail = doctorCaseDetailSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    expect(detail.clinicalDocument?.draft?.assessment).toBe('医生尚未保存的评估。')
    expect(detail.consultationRecording?.additions.at(-1)?.sourceTurnId).toBe(detail.consultation?.turns.at(-1)?.id)
    expect(detail.clinicalDocument?.draft?.chiefComplaint).toBe(beforeChiefComplaint)
    expect(detail.clinicalDocument?.draft?.physicalExamination).toBe(beforePhysicalExamination)
    expect(detail.clinicalDocument?.draft?.priorMedicalHistory).toBe(beforePriorHistory)
    expect(detail.consultationRecording?.hasSavedDraft).toBe(true)
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
