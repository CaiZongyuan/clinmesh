import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

test('merges a readable history and shows both saved patient replies and their doctor context after reload', async ({ page, webRoot }) => {
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
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(summary)
    replyIndex = 1
    await ask('咳嗽何时开始，有没有胸痛或气促？')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(combined)
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(combined)
    const active = page.locator('[data-consultation-addition="applied"]')
    await active.getByRole('button', { name: '查看来源', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '患者原回答', exact: true })
    await expect(dialog).toContainText('Agent 病史总结：' + combined)
    await expect(dialog.locator('blockquote')).toHaveText(replies)
    await expect(dialog).toContainText('医生提问：何时开始发热，最高体温多少，有没有咳嗽和痰？')
    await expect(dialog).toContainText('医生提问：咳嗽何时开始，有没有胸痛或气促？')
    await expect(dialog.locator('mark')).toHaveText(replies)
    const updated = (await read()).consultationRecording!.additions.at(-1)!
    expect(updated.facts![0]!.sources).toHaveLength(2)
    await page.keyboard.press('Escape')
    await active.getByRole('button', { name: '撤销此条', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue(summary)
  } finally { await server.close() }
})
