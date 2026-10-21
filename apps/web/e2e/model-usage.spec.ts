import { modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { OpenAIChatCompletionsClient } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { expect, test } from './fixtures.ts'

test('reads persisted synthetic model usage from the real Settings entry and survives reload', async ({ page, webRoot }) => {
  const server = await startBrowserServer(webRoot, {
    syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => Response.json({ model: 'synthetic-model', choices: [{ message: { content: JSON.stringify(persona) } }] }),
    }),
  })
  try {
    await startConsultationCase(server.runtime, server.password, server.origin)
    await page.goto(`${server.origin}/settings`)
    await page.getByLabel('账户邮箱').fill('admin@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('link', { name: '模型用量', exact: true }).click()
    await expect(page.getByRole('heading', { name: '模型用量', exact: true })).toBeVisible()
    const response = await page.request.get(`${server.origin}/api/model-usage/overview`)
    expect(response.status()).toBe(200)
    const usage = modelUsageOverviewSchema.parse(await response.json())
    expect(usage.totals.requests).toBe(1)
    await expect(page.getByRole('region', { name: '已派发请求' })).toContainText('1')
    await page.getByRole('button', { name: '查看请求详情' }).click()
    await expect(page.getByRole('region', { name: '请求详情' }).getByText('synthetic-model', { exact: true }).first()).toBeVisible()
    await page.reload()
    await expect(page.getByRole('region', { name: '已派发请求' })).toContainText('1')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: '额度与策略' }).click()
    await expect(page.getByText('无限', { exact: true })).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally { await server.close() }
})
