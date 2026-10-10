import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

test('reviews paused omissions, recovers preparation after reload and signs only after manual review', async ({ page, webRoot }) => {
  let reply = '头晕一周了。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }> }
      const turn = payload.turns.at(-1)!
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turn.id,
        quote: turn.messageText, relation: 'addition' }] }), model: 'synthetic' }
    } },
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
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
    const ask = async () => {
      await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
      await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充病史？')
      await page.getByRole('button', { name: '向患者提问', exact: true }).click()
      await expect(page.getByText(reply, { exact: true })).toBeVisible()
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    }
    await ask()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了。')
    await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复并补录', exact: true })).toBeEnabled()
    reply = '站起来时更明显。'
    await ask()
    for (const [label, text] of [
      ['主诉', '头晕一周。'], ['既往史', '既往高血压。'], ['查体', '查体未见明显异常。'],
      ['辅助检查', '暂无检查。'], ['评估', '继续评估。'], ['处置', '门诊随访。'], ['随访', '加重时及时就诊。'],
    ]) await page.getByLabel(label!, { exact: true }).fill(text!)
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
    await expect(dialog).toContainText('待整理 1')
    await expect(dialog).toContainText('自动整理已暂停')
    const commit = dialog.getByRole('button', { name: '确认签署病历', exact: true })
    await expect(commit).toBeDisabled()
    const firstPreviewId = (await read()).consultationRecording!.signingPreparation!.previewId
    await page.route('**/clinical-document/actions/cancel-sign', async route => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    }, { times: 1 })
    await dialog.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await read()).consultationRecording!.signingPreparation).toBeUndefined()
    expect((await read()).consultationRecording).toMatchObject({ paused: true, remainingCount: 1 })
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(dialog).toBeVisible()
    expect((await read()).consultationRecording!.signingPreparation!.previewId).not.toBe(firstPreviewId)
    await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(page.getByText('签署准备尚未结束', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
    await expect(page.getByText('签署准备尚未结束', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了。\n患者自述：站起来时更明显。')
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(commit).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await expect(commit).toBeEnabled()
    await commit.click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(1)
    expect((await read()).clinicalDocument!.signed[0]!.content.historyOfPresentIllness).toBe('患者自述：头晕一周了。\n患者自述：站起来时更明显。')
    expect(errors).toEqual([])
  } finally { await server.close() }
})
