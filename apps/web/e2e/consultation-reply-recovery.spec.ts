import { doctorCaseDetailSchema, sendConsultationMessageResponseSchema } from '@clinmesh/contracts/his'
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { modelUsageControlSchema } from '@clinmesh/contracts/model-usage'
import { ChatCompletionsError, OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

async function openConsultation(page: Page, server: Awaited<ReturnType<typeof startBrowserServer>>) {
  await page.goto(`${server.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(server.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByText('张琴', { exact: true }).first().click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
  await expect(page.getByRole('tab', { name: '问诊记录', exact: true })).toHaveAttribute('aria-selected', 'true')
}

test('preserves a control-blocked question across reload and resumes the original reply when enabled', async ({ page, webRoot }) => {
  let replyRequests = 0
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async (_url, init) => {
        const name = JSON.parse(String(init?.body)).response_format.json_schema.name
        if (name === 'patient_dialogue_reply') replyRequests++
        return Response.json({ choices: [{ message: { content: JSON.stringify(name === 'patient_persona' ? persona : { reply: '起身时会晕。' }) } }] })
      },
    }),
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const admin = await signIn(server.runtime, 'admin@demo.clinmesh.local', server.password, server.origin)
    const setEnabled = async (enabled: boolean) => {
      const current = modelUsageControlSchema.parse(await (await server.runtime.app.request('/api/model-usage/control', { headers: { cookie: admin } })).json())
      const response = await server.runtime.app.request('/api/model-usage/control', { method: 'PUT',
        headers: { cookie: admin, origin: server.origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ enabled, requests: null, automaticRetries: false, expectedVersion: current.workspace.version }) })
      expect(response.status).toBe(200)
    }
    await setEnabled(false)
    await openConsultation(page, server)
    const panel = page.getByRole('tabpanel', { name: '问诊记录', exact: true })
    await panel.getByRole('textbox', { name: '向患者提问', exact: true }).fill('什么时候会晕？')
    await panel.getByRole('button', { name: '向患者提问', exact: true }).click()
    const waiting = panel.getByRole('button', { name: '等待模型控制恢复', exact: true })
    await expect(waiting).toBeDisabled()
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    const original = (await read()).consultation?.replyAttempt
    expect(original?.status).toBe('blocked')
    expect(replyRequests).toBe(0)
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await expect(waiting).toBeDisabled()
    await expect(panel.getByText('医生问题已保存，模型控制恢复且本次回答期限仍有效时将自动接续。', { exact: true })).toBeVisible()
    expect((await read()).consultation?.replyAttempt).toEqual(original)
    await setEnabled(true)
    await expect(panel.getByText('起身时会晕。', { exact: true })).toBeVisible()
    await expect(panel.getByText('什么时候会晕？', { exact: true })).toHaveCount(1)
    expect((await read()).consultation?.replyAttempt).toMatchObject({ status: 'succeeded', deadlineAt: original!.deadlineAt })
    expect(replyRequests).toBe(1)
  } finally { await server.close() }
})

test('keeps an accepted patient answer running after reload and joins it from the real waiting control', async ({ page, webRoot }) => {
  let replyRequests = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: input.model }
      if (input.schemaName === 'patient_dialogue_reply') {
        replyRequests++
        await gate
        return { content: JSON.stringify({ reply: '一站起来就晕。' }), model: input.model }
      }
      return { content: JSON.stringify({ additions: [] }), model: input.model }
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await openConsultation(page, server)
    const panel = page.getByRole('tabpanel', { name: '问诊记录', exact: true })
    await panel.getByRole('textbox', { name: '向患者提问', exact: true }).fill('什么时候晕？')
    const [ask] = await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/actions/ask-consultation-question')),
      panel.getByRole('button', { name: '向患者提问', exact: true }).click(),
    ])
    await expect.poll(() => replyRequests).toBe(1)
    const original = (await read()).consultation?.replyAttempt
    expect(original?.status).toBe('executing')
    // Reload drops every page waiter while the server keeps the accepted question.
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await expect(panel.getByText('患者正在输入…', { exact: true })).toBeVisible()
    await expect(panel.getByText('患者回答仍在生成，等待将复用本次回答。', { exact: true })).toBeVisible()
    const [joined] = await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/actions/retry-consultation-reply')),
      panel.getByRole('button', { name: '等待当前回答', exact: true }).click(),
    ])
    const key = joined.headers()['idempotency-key']
    expect(key).toBeTruthy()
    // A completed acceptance receipt proves the later waiter joined before releasing the provider.
    await expect.poll(async () => (await page.request.get(`${server.origin}/api/his/v1/command-receipts`, {
      params: { operationId: 'encounter.consultation.reply.retry', idempotencyKey: key! },
    })).status()).toBe(200)
    expect((await read()).consultation?.replyAttempt).toEqual(original)
    expect(replyRequests).toBe(1)
    release()
    await expect(panel.getByText('一站起来就晕。', { exact: true })).toBeVisible()
    await expect(panel.getByText('什么时候晕？', { exact: true })).toHaveCount(1)
    await expect(panel.getByRole('button', { name: '重试患者回答', exact: true })).toHaveCount(0)
    const replay = await page.request.post(ask.url(), {
      headers: { origin: server.origin, 'idempotency-key': ask.headers()['idempotency-key']! },
      data: ask.postDataJSON(),
    })
    expect(replay.status()).toBe(200)
    expect(sendConsultationMessageResponseSchema.parse(await replay.json()).data.patientTurn.messageText).toBe('一站起来就晕。')
    expect(replyRequests).toBe(1)
  } finally {
    release()
    await server.close()
  }
})

test('shows failed and unknown replies after reload and sends a new retry only on an explicit click', async ({ page, webRoot }) => {
  let replyRequests = 0
  const retryKeys: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/actions/retry-consultation-reply')) {
      retryKeys.push(request.headers()['idempotency-key']!)
    }
  })
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: input.model }
      if (input.schemaName === 'patient_dialogue_reply') {
        replyRequests++
        if (replyRequests === 1) throw new ChatCompletionsError('AI_AUTH_FAILED', 'private-provider-credential-and-prompt')
        if (replyRequests === 2) throw new ChatCompletionsError('AI_TIMEOUT', 'private-provider-credential-and-prompt')
        return { content: JSON.stringify({ reply: '站起来时最晕。' }), model: input.model }
      }
      return { content: JSON.stringify({ additions: [] }), model: input.model }
    } },
  })
  try {
    await startConsultationCase(server.runtime, server.password, server.origin)
    await openConsultation(page, server)
    const panel = page.getByRole('tabpanel', { name: '问诊记录', exact: true })
    await panel.getByRole('textbox', { name: '向患者提问', exact: true }).fill('什么时候最晕？')
    await panel.getByRole('button', { name: '向患者提问', exact: true }).click()
    const failed = panel.getByText('患者回答失败。重试将使用当前 ClinMesh 模型设置。', { exact: true })
    await expect(failed).toBeVisible()
    expect(replyRequests).toBe(1)
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await expect(failed).toBeVisible()
    expect(replyRequests).toBe(1)
    await panel.getByRole('button', { name: '重试患者回答', exact: true }).click()
    const unknown = panel.getByText('上次回答结果未知，未自动补答。明确重试将使用当前 ClinMesh 模型设置。', { exact: true })
    await expect(unknown).toBeVisible()
    expect(replyRequests).toBe(2)
    await page.reload()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await expect(unknown).toBeVisible()
    expect(replyRequests).toBe(2)
    expect(await page.locator('body').innerText()).not.toContain('private-provider')
    await panel.getByRole('button', { name: '重试患者回答', exact: true }).click()
    await expect(panel.getByText('站起来时最晕。', { exact: true })).toBeVisible()
    expect(replyRequests).toBe(3)
    expect(retryKeys).toHaveLength(2)
    expect(new Set(retryKeys).size).toBe(2)
  } finally { await server.close() }
})
