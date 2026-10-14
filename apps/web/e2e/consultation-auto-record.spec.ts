import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { ChatCompletionsError } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { waitForRecordedHistory } from './consultation-recording.ts'

test('records a conflict automatically without replacing handwritten history and preserves the rest of the draft after reload', async ({ page, webRoot }) => {
  const reply = '胸痛两天了。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string }>;
        manualHistory: Array<{ id: string; text: string }> }
      const target = payload.manualHistory.find(item => item.text === '医生核对：否认胸痛。')!
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId: payload.turns.at(-1)!.id,
        quote: reply, relation: 'conflict', targetAdditionId: target.id }] }), model: 'synthetic' }
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const original = '医生核对：否认胸痛。\n平时睡眠正常。'
    const history = page.getByLabel('现病史', { exact: true })
    await history.fill(original)
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(original)
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充胸痛情况？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText(reply, { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const expected = original + '\n患者自述存在矛盾，待核实：患者自述：胸痛两天了。'
    await expect(history).toHaveValue(expected)
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(history).toHaveValue(expected)
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(expected)
  } finally { await server.close() }
})

for (const code of ['AI_TIMEOUT', 'AI_RESPONSE_INVALID'] as const) {
  test(`settles ${code} with a visible reason and saved patient reply after reload`, async ({ page, webRoot }) => {
    const server = await startBrowserServer(webRoot, {
      dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
      syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
      chatCompletionsProvider: { async completeJson(input) {
        if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
        if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: '头晕一周了。' }), model: 'synthetic' }
        throw new ChatCompletionsError(code, 'private-provider-credential-and-prompt')
      } },
    })
    try {
      await startConsultationCase(server.runtime, server.password, server.origin)
      await page.goto(`${server.origin}/consultation`)
      await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
      await page.getByLabel('账户密码').fill(server.password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('tab', { name: '待诊', exact: true }).click()
      await page.getByText('张琴', { exact: true }).first().click()
      await page.getByRole('button', { name: '开始首诊', exact: true }).click()
      await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
      await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('头晕多久了？')
      await page.getByRole('button', { name: '向患者提问', exact: true }).click()
      await expect(page.getByText('头晕一周了。', { exact: true })).toBeVisible()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      const reason = code === 'AI_TIMEOUT' ? '自动记录超时，患者回答已保存，请根据问诊原文补充病史。'
        : '自动记录结果未通过校验，病史未写入，请核对问诊原文。'
      await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'failed')
      await page.getByRole('button', { name: '问诊自动记录', exact: true }).click()
      await expect(page.getByText(reason, { exact: true })).toBeVisible()
      await page.reload()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      await page.getByRole('button', { name: '问诊自动记录', exact: true }).click()
      await expect(page.getByText(reason, { exact: true })).toBeVisible()
      await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'failed')
      expect(await page.locator('body').innerText()).not.toContain('private-provider-credential-and-prompt')
    } finally { await server.close() }
  })
}

test('pauses recording while asking, preserves it on reload, resumes missing replies and retries a failure', async ({ page, webRoot }) => {
  let reply = '头晕一周了。'
  let fail = false
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      if (fail) throw new Error('Synthetic disconnect')
      const turns = (input.userPayload as { turns: Array<{ id: string; messageText: string }> }).turns
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turns.at(-1)!.id,
        quote: turns.at(-1)!.messageText, relation: 'addition' }] }), model: 'synthetic' }
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    let failCaseReads = false
    let failedCaseReads = 0
    await page.route(`${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`, async route => {
      if (failCaseReads) { failedCaseReads += 1; await route.abort('failed') }
      else await route.continue()
    })
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
    }
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await page.getByLabel('现病史', { exact: true }).fill('')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await ask()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await waitForRecordedHistory(page, reply)
    await page.getByLabel('现病史', { exact: true }).fill('医生核对：头晕五天。')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect(page.getByText('病历草稿已保存', { exact: true })).toBeVisible()
    failCaseReads = true
    await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'paused')
    await expect.poll(() => failedCaseReads).toBeGreaterThan(0)
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('医生核对：头晕五天。')
    failCaseReads = false
    reply = '站起来时更明显。'
    await ask()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'paused')
    expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：头晕五天。')
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复并补录', exact: true })).toBeVisible()
    expect((await read()).consultationRecording).toMatchObject({ paused: true, processedCount: 1, remainingCount: 1 })
    const readsBeforeResume = failedCaseReads
    failCaseReads = true
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await expect.poll(() => failedCaseReads).toBeGreaterThan(readsBeforeResume)
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'processing')
    await expect(page.getByRole('button', { name: '暂停自动整理', exact: true })).toBeEnabled()
    failCaseReads = false
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await waitForRecordedHistory(page, reply)
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('医生核对：头晕五天。\n患者自述：站起来时更明显。')
    reply = '夜间也会头晕。'
    fail = true
    await ask()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'failed')
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    fail = false
    const readsBeforeRetry = failedCaseReads
    failCaseReads = true
    await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
    await expect.poll(() => failedCaseReads).toBeGreaterThan(readsBeforeRetry)
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'processing')
    failCaseReads = false
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'updated')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await waitForRecordedHistory(page, reply)
    expect((await read()).consultationRecording).toMatchObject({ processedCount: 3, remainingCount: 0, failedCount: 0 })
    expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe('医生核对：头晕五天。\n患者自述：站起来时更明显。\n患者自述：夜间也会头晕。')
  } finally { await server.close() }
})

for (const existingAutomaticDraft of [false, true]) {
  test(`preserves saved prefill while recording automatically in a ${existingAutomaticDraft ? 'previously created' : 'new'} draft`, async ({ page, webRoot }) => {
    const recording = page.getByRole('tabpanel', { name: '病历记录', exact: true }).locator('[data-consultation-recording]')
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
        await expect(recording).toHaveAttribute('data-consultation-recording', 'updated')
        await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
        await waitForRecordedHistory(page, reply)
      } else await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      const history = page.getByLabel('现病史', { exact: true })
      expect(await history.inputValue()).not.toBe('')
      const manual = '医生核对：头晕五天。\n医生补充：站立时加重。'
      await history.fill(manual)
      reply = '夜间也会头晕。'
      field = 'historyOfPresentIllness'
      await ask()
      await expect(recording).toHaveAttribute('data-consultation-recording', 'processing')
      release()
      await expect(recording).toHaveAttribute('data-consultation-recording', 'updated')
      const expected = `${manual}\n患者自述：${reply}`
      await expect(history).toHaveValue(expected)
      await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
      await waitForRecordedHistory(page, reply)
      await expect(history).toHaveValue(expected)
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
