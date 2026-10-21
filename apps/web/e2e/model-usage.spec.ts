import { modelUsageControlSchema, modelUsageOverviewSchema, modelUsageListSchema } from '@clinmesh/contracts/model-usage'
import { agentPageContextBindingSchema } from '@clinmesh/contracts/agent'
import { randomUUID } from 'node:crypto'
import { isDoctorDelegation } from '../../dsh-web/src/doctor-delegation.ts'
import { syntheticRecognitionLlm } from '../../dsh-web/src/doctor-input-fixture.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { expect, test } from './fixtures.ts'

test('reads persisted synthetic model usage from the real Settings entry and survives reload', async ({ page, webRoot }) => {
  const secret = 'synthetic-host-usage-e2e-secret-at-least-32-characters'
  const server = await startBrowserServer(webRoot, {
    dshBridgeSecret: secret,
    modelPricing: { prices: [{ provider: 'synthetic-host', model: 'host-classifier', version: 'host-price-v1', currency: 'USD', rates: { input: 2, output: 4 } }],
      exchangeRates: [{ currency: 'USD', version: 'fx-v1', cnyPerUnit: 7 }] },
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => Response.json({ model: 'synthetic-model', choices: [{ message: { content: JSON.stringify(persona) } }] }),
    }),
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const doctor = await signIn(server.runtime, 'doctor@demo.clinmesh.local', server.password, server.origin)
    const headers = { cookie: doctor, origin: server.origin, 'content-type': 'application/json' }
    const visit = await server.runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {
        [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' }, input: {} }),
    })
    expect(visit.status).toBe(200)
    const version = (await visit.json()).data.encounterVersion
    const context = agentPageContextBindingSchema.parse(await (await server.runtime.app.request('/api/agent/v1/page-contexts', {
      method: 'POST', headers, body: JSON.stringify({ client: { id: randomUUID(), revision: 1 }, dshSessionId: 'usage-e2e-host',
        claim: { taskEpoch: randomUUID(), activeSection: 'consultation', version: 1, viewId: 'consultation',
          viewRevision: 'usage-e2e', ui: { status: 'ready' }, selection: { kind: 'case', id: started.outpatientCaseId, version } } }),
    })).json())
    const permit = (await (await server.runtime.app.request('/api/agent/v1/doctor-tasks/permit', { method: 'POST', headers,
      body: JSON.stringify({ contextToken: context.token, content: '替我问清头晕的诱因。', rpcId: randomUUID() }) })).json()).permit
    const host = { llm: syntheticRecognitionLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '{"intent":"discuss","evidence":""}' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }) } as unknown as Parameters<typeof isDoctorDelegation>[0]
    await isDoctorDelegation(host, { provider: 'synthetic-host', model: 'host-classifier' }, '替我问清头晕的诱因。',
      new AbortController().signal, { upstreamOrigin: server.origin, secret, permit })
    await page.goto(`${server.origin}/settings`)
    await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('link', { name: '模型用量', exact: true }).click()
    await expect(page.getByRole('heading', { name: '模型用量', exact: true })).toBeVisible()
    const response = await page.request.get(`${server.origin}/api/model-usage/overview`)
    expect(response.status()).toBe(200)
    const usage = modelUsageOverviewSchema.parse(await response.json())
    expect(usage.totals.requests).toBe(2)
    await expect(page.getByRole('region', { name: '已派发请求' })).toContainText('2')
    await page.getByRole('tab', { name: '请求明细', exact: true }).click()
    await page.getByRole('combobox', { name: '功能', exact: true }).click()
    await page.getByRole('option', { name: '医生代问识别', exact: true }).click()
    await page.getByRole('button', { name: '应用筛选' }).click()
    await expect(page.getByRole('button', { name: '查看请求详情' })).toHaveCount(1)
    await page.getByRole('button', { name: '查看请求详情' }).click()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('host-classifier', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('doctor_delegation', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('host-price-v1', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('fx-v1', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('0.000036', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '功能', exact: true }).click()
    await page.getByRole('option', { name: '患者人设', exact: true }).click()
    await page.getByRole('button', { name: '应用筛选' }).click()
    await page.getByRole('button', { name: '查看请求详情' }).click()
    await page.getByRole('button', { name: '核对待确认用量', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '核对待确认用量', exact: true })
    await dialog.getByLabel('依据引用', { exact: true }).fill('bill:synthetic-e2e')
    await dialog.getByLabel('总 Token', { exact: true }).fill('150')
    await dialog.getByLabel('人民币费用', { exact: true }).fill('0')
    await dialog.getByRole('button', { name: '确认核对', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('bill:synthetic-e2e', { exact: true })).toBeVisible()
    const reconciled = modelUsageListSchema.parse(await (await page.request.get(`${server.origin}/api/model-usage/requests?feature=patient_persona`)).json()).items[0]
    expect(reconciled).toMatchObject({ usage: { totalTokens: null }, accounting: { totalTokens: 150, cny: 0 },
      corrections: [{ kind: 'reconcile', evidence: 'bill:synthetic-e2e' }] })
    await page.reload()
    await expect(page.getByRole('region', { name: '已派发请求' })).toContainText('2')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: '额度与策略' }).click()
    await expect(page.getByRole('region', { name: '工作区控制', exact: true }).getByText('无限', { exact: true })).toHaveCount(6)
    await page.getByRole('tab', { name: '计价说明', exact: true }).click()
    await expect(page.getByRole('table', { name: '计价说明', exact: true }).getByText('host-price-v1', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally { await server.close() }
})

test('administrators save model controls through Settings and members can only read the persisted policy', async ({ page, browserApp }) => {
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('link', { name: '模型用量', exact: true }).click()
  await page.getByRole('tab', { name: '额度与策略' }).click()
  const workspace = page.getByRole('region', { name: '工作区控制', exact: true })
  await workspace.getByRole('checkbox', { name: '请求次数无限' }).uncheck()
  await workspace.getByLabel('请求次数上限', { exact: true }).fill('0')
  await workspace.getByRole('checkbox', { name: 'Token 无限', exact: true }).uncheck()
  await workspace.getByLabel('Token 上限', { exact: true }).fill('5000')
  await workspace.getByRole('checkbox', { name: '人民币费用无限', exact: true }).uncheck()
  await workspace.getByLabel('人民币费用上限', { exact: true }).fill('0')
  await workspace.getByRole('checkbox', { name: '启用模型生成' }).uncheck()
  await workspace.getByRole('checkbox', { name: '允许自动重试' }).uncheck()
  await workspace.getByRole('button', { name: '保存工作区策略' }).click()
  await expect(page.getByText('工作区策略已保存', { exact: true })).toBeVisible()
  const control = modelUsageControlSchema.parse(await (await page.request.get(`${browserApp.origin}/api/model-usage/control`)).json())
  expect(control.workspace).toMatchObject({ enabled: false, requests: 0, tokens: 5000, cny: 0,
    automaticRetries: false, version: 2, used: 0, remaining: 0, tokensUsed: 0, tokensRemaining: 5000, cnyUsed: 0, cnyRemaining: 0 })
  expect(control.workspace.requestsStartedAt).not.toBeNull()
  expect(control.workspace.tokensStartedAt).not.toBeNull()
  expect(control.workspace.cnyStartedAt).not.toBeNull()
  expect(control.deployment).toMatchObject({ enabled: true, requests: null, automaticRetries: true })
  await page.reload()
  await page.getByRole('tab', { name: '额度与策略' }).click()
  await expect(workspace.getByRole('checkbox', { name: '启用模型生成' })).not.toBeChecked()
  await expect(workspace.getByLabel('请求次数上限', { exact: true })).toHaveValue('0')
  await expect(workspace.getByLabel('Token 上限', { exact: true })).toHaveValue('5000')
  await expect(workspace.getByLabel('人民币费用上限', { exact: true })).toHaveValue('0')
  await workspace.getByRole('checkbox', { name: '请求次数无限' }).check()
  await workspace.getByRole('checkbox', { name: 'Token 无限', exact: true }).check()
  await workspace.getByRole('checkbox', { name: '人民币费用无限', exact: true }).check()
  await workspace.getByRole('checkbox', { name: '启用模型生成' }).check()
  await workspace.getByRole('button', { name: '保存工作区策略' }).click()
  await expect(page.getByText('工作区策略已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('link', { name: '模型用量', exact: true }).click()
  await page.getByRole('tab', { name: '额度与策略' }).click()
  await expect(workspace.getByText('仅管理员可修改工作区控制。', { exact: true })).toBeVisible()
  await expect(workspace.getByRole('checkbox')).toHaveCount(0)
  await expect(workspace.getByRole('button', { name: '保存工作区策略' })).toHaveCount(0)
  const persisted = modelUsageControlSchema.parse(await (await page.request.get(`${browserApp.origin}/api/model-usage/control`)).json())
  expect(persisted.deployment).toBeNull()
  await expect(page.getByRole('region', { name: '部署控制（只读）' })).toHaveCount(0)
  expect(persisted.workspace).toMatchObject({ enabled: true, requests: null, tokens: null, cny: null, automaticRetries: false, version: 3,
    requestsStartedAt: control.workspace.requestsStartedAt, tokensStartedAt: control.workspace.tokensStartedAt, cnyStartedAt: control.workspace.cnyStartedAt })
})
