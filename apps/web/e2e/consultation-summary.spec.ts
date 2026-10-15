import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { waitForRecordedHistory } from './consultation-recording.ts'

test('merges readable history across replies and restores it without source controls after reload', async ({ page, webRoot }) => {
  const replies = ['昨天晚上开始发烧，最高量到38.5度，还咳嗽，但是没有痰。',
    '咳嗽也是昨晚开始的，胸口不疼，也不觉得喘。']
  let replyIndex = 0
  const summary = '昨晚起发热伴干咳，自述最高体温38.5℃'
  const combined = summary + '；否认胸痛、气促'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: replies[replyIndex] }), model: 'synthetic' }
      const { turns, history } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
        history: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
      const first = turns.find(turn => turn.messageText === replies[0])!
      const second = turns.find(turn => turn.messageText === replies[1])
      return { model: 'synthetic', content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness',
        relation: second === undefined ? 'addition' : 'update',
        ...(second === undefined ? {} : { targetAdditionId: history[0]!.id }),
        facts: [{ text: summary, sources: [{ sourceTurnId: first.id, quote: replies[0] },
          ...(second === undefined ? [] : [{ sourceTurnId: second.id, quote: replies[1] }])] },
        ...(second === undefined ? [] : [{ text: '否认胸痛、气促', sources: [{ sourceTurnId: second.id, quote: replies[1] }] }])],
      }] }) }
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
    const ask = async (question: string) => {
      await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
      await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill(question)
      await page.getByRole('button', { name: '向患者提问', exact: true }).click()
      await expect(page.getByText(replies[replyIndex]!, { exact: true })).toBeVisible()
      await expect.poll(async () => (await read()).consultationRecording?.status).toBe('updated')
    }
    await ask('何时开始发热，最高体温多少，有没有咳嗽和痰？')
    const recordTab = page.getByRole('tab', { name: '病历记录', exact: true })
    await expect(recordTab).toContainText('有更新')
    await page.clock.install()
    await page.clock.fastForward(6_000)
    await expect(recordTab).toContainText('有更新')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(summary)
    const changed = page.locator('[data-clinical-document-field="historyOfPresentIllness"]')
    await expect(changed.getByRole('status')).toHaveText('已更新')
    await expect(changed.locator('[data-clinical-document-update]')).toHaveAttribute('data-clinical-document-update', 'visible')
    await expect(page.locator('[data-clinical-document-update]')).toHaveCount(1)
    await page.clock.fastForward(4_000)
    await expect(changed.locator('[data-clinical-document-update]')).toHaveAttribute('data-clinical-document-update', 'fading')
    await page.clock.fastForward(800)
    await expect(changed.getByRole('status')).toHaveCount(0)
    await expect(recordTab).not.toContainText('有更新')
    expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(summary)
    replyIndex = 1
    await ask('咳嗽何时开始，有没有胸痛或气促？')
    await expect(recordTab).toContainText('有更新')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await waitForRecordedHistory(page, combined)
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(combined)
    await expect(changed.getByRole('status')).toHaveText('已更新')
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(combined)
    await expect(page.getByText('自动记录来源', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toHaveCount(0)
    const updated = (await read()).consultationRecording!.additions.at(-1)!
    expect(updated.facts![0]!.sources).toHaveLength(2)
    await expect(page.getByRole('button', { name: '撤销此条', exact: true })).toHaveCount(0)
    expect((await read()).clinicalDocument!.draft!.historyOfPresentIllness).toBe(combined)
  } finally { await server.close() }
})

for (const local of ['医生核对：头晕四天。', '医生核对头晕四天']) {
  test(`preserves unsaved history and complete automatic rewrites through saving and reload: ${local}`, async ({ page, webRoot }) => {
    const replies = ['头晕三天。', '昨夜出现恶心。', '昨夜还吐了一次。']
    const summaries = ['患者自述头晕三天', '三天前出现头晕，伴昨夜恶心', '三天前出现头晕，伴昨夜恶心、呕吐']
    let replyIndex = 0
    const server = await startBrowserServer(webRoot, {
      dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
      syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
      chatCompletionsProvider: { async completeJson(input) {
        if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
        if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply: replies[replyIndex] }), model: 'synthetic' }
        const { turns, history } = z.object({ turns: z.array(z.object({ id: z.string(), messageText: z.string() })),
          history: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
        return { model: 'synthetic', content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness',
          relation: replyIndex === 0 ? 'addition' : 'update',
          ...(replyIndex === 0 ? {} : { targetAdditionId: history[0]!.id }),
          facts: [{ text: summaries[replyIndex], sources: replies.slice(0, replyIndex + 1).map(quote => ({
            sourceTurnId: turns.find(turn => turn.messageText === quote)!.id, quote,
          })) }],
        }] }) }
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
      const history = page.getByLabel('现病史', { exact: true })
      const ask = async () => {
        await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
        await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充头晕和其他症状。')
        await page.getByRole('button', { name: '向患者提问', exact: true }).click()
        await expect.poll(async () => (await read()).consultationRecording?.processedCount).toBe(replyIndex + 1)
        await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      }
      await ask()
      await expect(history).toHaveValue(summaries[0]!)
      await history.fill(local)
      for (replyIndex = 1; replyIndex < replies.length; replyIndex++) {
        await ask()
        await expect(history).toHaveValue(`${local}\n待核实补充：\n${summaries[replyIndex]}`)
        expect((await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(summaries[replyIndex])
      }
      const combined = `${local}\n待核实补充：\n${summaries.at(-1)}`
      await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
      await expect.poll(async () => (await read()).clinicalDocument?.draft?.historyOfPresentIllness).toBe(combined)
      await page.reload()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      await expect(history).toHaveValue(combined)
      expect((await read()).consultationRecording).toMatchObject({ processedCount: 3, remainingCount: 0, failedCount: 0 })
    } finally { await server.close() }
  })
}
