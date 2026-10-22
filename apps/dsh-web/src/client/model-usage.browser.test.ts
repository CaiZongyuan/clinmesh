import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test.describe(`model usage settings with React ${version}`, () => {
    let script = ''
    test.beforeAll(async () => {
      const react = version === '18' ? 'react18' : 'react'
      const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
      const result = await build({
        configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: { alias: [
          { find: /^react$/, replacement: require.resolve(react) },
          { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
          { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
          { find: /^react-dom$/, replacement: require.resolve(reactDom) },
        ] },
        build: { write: false, lib: { entry: fileURLToPath(new URL('./model-usage.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'ModelUsageContract' } },
      })
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
        if (!('output' in output)) throw new Error('Unexpected build watcher')
        return output.output
      })
      const chunk = outputs.find(output => output.type === 'chunk')
      if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser script')
      script = chunk.code.replaceAll('</script', '<\\/script')
    })
    for (const scenario of [{ locale: 'zh-CN', theme: 'dark', width: 390, administrator: true },
      { locale: 'en-US', theme: 'light', width: 1280, administrator: false },
      { locale: 'en-US', theme: 'light', width: 1280, administrator: true }]) {
      test(`opens from host Settings at ${scenario.width}px in ${scenario.locale} as ${scenario.administrator ? 'administrator' : 'member'}`, async ({ page }) => {
        const zh = scenario.locale === 'zh-CN'
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.setViewportSize({ width: scenario.width, height: 844 })
        await page.route('https://synthetic.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
        await page.goto('https://synthetic.test/model-usage')
        await page.setContent(`<html lang="${scenario.locale}" data-theme="${scenario.theme}" data-usage-administrator="${scenario.administrator}"><body><script>${script}</script></body></html>`)
        await page.getByRole('button', { name: zh ? '医院工作台' : 'Hospital workspace' }).click()
        await page.getByRole('menuitem', { name: zh ? '模型用量' : 'Model usage', exact: true }).click()
        await expect(page.getByRole('heading', { name: zh ? '模型用量' : 'Model usage', exact: true })).toBeVisible()
        await expect(page.getByRole('region', { name: zh ? '已派发请求' : 'Dispatched requests' })).toContainText('3')
        await expect(page.getByRole('region', { name: zh ? '已知输入 Token' : 'Known input tokens', exact: true })).toContainText('120')
        await expect(page.getByRole('region', { name: zh ? '已知输出 Token' : 'Known output tokens', exact: true })).toContainText(zh ? '未知' : 'Unknown')
        await expect(page.getByRole('region', { name: zh ? '人民币费用' : 'CNY cost' })).toContainText(zh ? '未知' : 'Unknown')
        const requests = page.getByRole('tab', { name: zh ? '请求明细' : 'Requests', exact: true })
        await page.getByRole('tab', { name: zh ? '用量总览' : 'Usage overview', exact: true }).focus()
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Enter')
        await expect(requests).toHaveAttribute('aria-selected', 'true')
        await page.getByLabel(zh ? '病例 ID' : 'Case ID', { exact: true }).fill('case-synthetic')
        await page.getByRole('combobox', { name: zh ? '功能' : 'Feature', exact: true }).click()
        await page.getByRole('option', { name: zh ? '医生代问识别' : 'Doctor delegation recognition', exact: true }).click()
        await page.getByRole('button', { name: zh ? '应用筛选' : 'Apply filters' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-usage-filter', /caseId=case-synthetic/)
        await expect(page.locator('html')).toHaveAttribute('data-usage-filter', /feature=doctor_delegation/)
        await expect(page.getByText(zh ? '其他 DSH 原生会话及插件发起的调用不在覆盖范围。' : 'Other DSH native sessions and plugin calls are outside this coverage.', { exact: false })).toBeVisible()
        await page.getByRole('button', { name: zh ? '查看请求详情' : 'View request detail' }).click()
        const detail = page.getByRole('region', { name: zh ? '请求详情' : 'Request detail', exact: true })
        await expect(detail).toBeFocused()
        await expect(detail.getByText(zh ? '已派发' : 'Dispatched', { exact: true })).toBeVisible()
        await expect(detail.getByText('historical-actual-model', { exact: true })).toBeVisible()
        await expect(detail.getByText('turn-a', { exact: true })).toBeVisible()
        await expect(detail.getByText('document-c', { exact: true })).toBeVisible()
        if (scenario.administrator) {
          const reconcile = detail.getByRole('button', { name: zh ? '核对待确认用量' : 'Reconcile unknown usage', exact: true })
          await reconcile.click()
          let dialog = page.getByRole('dialog', { name: zh ? '核对待确认用量' : 'Reconcile unknown usage', exact: true })
          await expect(dialog).toBeVisible()
          expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
          await page.keyboard.press('Escape')
          await expect(dialog).toHaveCount(0)
          await expect(reconcile).toBeFocused()
          await reconcile.click()
          dialog = page.getByRole('dialog', { name: zh ? '核对待确认用量' : 'Reconcile unknown usage', exact: true })
          await dialog.getByLabel(zh ? '依据引用' : 'Evidence reference', { exact: true }).fill('bill:synthetic-1')
          await dialog.getByLabel(zh ? '总 Token' : 'Total tokens', { exact: true }).fill('150')
          await dialog.getByRole('button', { name: zh ? '确认核对' : 'Confirm reconciliation', exact: true }).click()
          await expect(dialog).toHaveCount(0)
          await expect(detail.getByText('bill:synthetic-1', { exact: true })).toBeVisible()
          expect(JSON.parse(await page.locator('html').getAttribute('data-usage-correction') ?? '{}')).toEqual({ expectedRevision: 0, evidence: 'bill:synthetic-1', totalTokens: 150 })
          await reconcile.click()
          dialog = page.getByRole('dialog', { name: zh ? '核对待确认用量' : 'Reconcile unknown usage', exact: true })
          await expect(dialog.getByLabel(zh ? '总 Token' : 'Total tokens', { exact: true })).toHaveCount(0)
          await dialog.getByLabel(zh ? '依据引用' : 'Evidence reference', { exact: true }).fill('bill:synthetic-2')
          await dialog.getByLabel(zh ? '人民币费用' : 'CNY cost', { exact: true }).fill('0')
          await dialog.getByRole('button', { name: zh ? '确认核对' : 'Confirm reconciliation', exact: true }).click()
          await expect(dialog).toHaveCount(0)
          await expect(reconcile).toHaveCount(0)
          await expect(detail.getByText('bill:synthetic-2', { exact: true })).toBeVisible()
          await expect(page.locator('html')).toHaveAttribute('data-usage-idempotency', /^[0-9a-f-]{36}$/)
        } else {
          await expect(detail.getByRole('button', { name: 'Reconcile unknown usage', exact: true })).toHaveCount(0)
          await expect(detail.getByRole('button', { name: 'Reprice with current prices', exact: true })).toHaveCount(0)
        }
        await page.getByRole('tab', { name: zh ? '额度与策略' : 'Quotas and policy' }).click()
        const workspace = page.getByRole('region', { name: zh ? '工作区控制' : 'Workspace controls', exact: true })
        const retention = page.getByRole('region', { name: zh ? '明细保留期' : 'Request detail retention', exact: true })
        await expect(workspace.getByText(zh ? '无限' : 'Unlimited', { exact: true })).toHaveCount(6)
        if (scenario.administrator) {
          const days = retention.getByLabel(zh ? '保留天数' : 'Retention days', { exact: true })
          await expect(days).toHaveValue('90')
          await days.fill('137')
          await retention.getByRole('button', { name: zh ? '保存保留期' : 'Save retention', exact: true }).click()
          await expect(page.locator('html')).toHaveAttribute('data-usage-retention-write', '{"days":137,"expectedVersion":1}')
          await expect(page.locator('html')).toHaveAttribute('data-usage-idempotency', /^[0-9a-f-]{36}$/)
          await page.getByRole('button', { name: zh ? '刷新用量' : 'Refresh usage', exact: true }).click()
          await expect(days).toHaveValue('137')
          await retention.getByRole('checkbox', { name: zh ? '永久保留' : 'Keep permanently', exact: true }).check()
          await retention.getByRole('button', { name: zh ? '保存保留期' : 'Save retention', exact: true }).click()
          await expect(page.locator('html')).toHaveAttribute('data-usage-retention-write', '{"days":null,"expectedVersion":2}')
          await expect(page.getByRole('region', { name: zh ? '部署控制（只读）' : 'Deployment controls (read only)', exact: true }).getByText('6', { exact: true })).toBeVisible()
          await workspace.getByRole('checkbox', { name: zh ? '请求次数无限' : 'Unlimited requests' }).uncheck()
          await workspace.getByLabel(zh ? '请求次数上限' : 'Request limit', { exact: true }).fill('0')
          await workspace.getByRole('checkbox', { name: zh ? 'Token 无限' : 'Unlimited tokens', exact: true }).uncheck()
          await workspace.getByLabel(zh ? 'Token 上限' : 'Token limit', { exact: true }).fill('5000')
          await workspace.getByRole('checkbox', { name: zh ? '人民币费用无限' : 'Unlimited CNY cost', exact: true }).uncheck()
          await workspace.getByLabel(zh ? '人民币费用上限' : 'CNY cost limit', { exact: true }).fill('0')
          await workspace.getByRole('checkbox', { name: zh ? '启用模型生成' : 'Enable model generation' }).uncheck()
          await workspace.getByRole('button', { name: zh ? '保存工作区策略' : 'Save Workspace policy' }).click()
          await expect(page.getByText(zh ? '工作区策略已保存' : 'Workspace policy saved', { exact: true })).toBeVisible()
          expect(JSON.parse(await page.locator('html').getAttribute('data-usage-control-write') ?? '{}')).toEqual({ expectedVersion: 1, enabled: false, requests: 0, tokens: 5000, cny: 0, automaticRetries: true })
          await expect(page.locator('html')).toHaveAttribute('data-usage-idempotency', /^[0-9a-f-]{36}$/)
          await workspace.getByRole('checkbox', { name: zh ? '请求次数无限' : 'Unlimited requests' }).check()
          await workspace.getByRole('button', { name: zh ? '保存工作区策略' : 'Save Workspace policy' }).click()
          await expect(page.locator('html')).toHaveAttribute('data-usage-control-write', /"requests":null/)
        } else {
          await expect(retention.getByText('Only administrators can change request detail retention.', { exact: true })).toBeVisible()
          await expect(retention.getByRole('checkbox')).toHaveCount(0)
          await expect(retention.getByRole('button', { name: 'Save retention', exact: true })).toHaveCount(0)
          await expect(page.getByRole('region', { name: 'Deployment controls (read only)', exact: true })).toHaveCount(0)
          await expect(workspace.getByRole('button', { name: 'Save Workspace policy' })).toHaveCount(0)
          await expect(workspace.getByText('Only administrators can change Workspace controls.', { exact: true })).toBeVisible()
        }
        await page.getByRole('tab', { name: zh ? '计价说明' : 'Pricing', exact: true }).click()
        await expect(page.getByRole('table', { name: zh ? '计价说明' : 'Pricing', exact: true }).getByText('prices-v2', { exact: true })).toBeVisible()
        await expect(page.getByText('fx-v2', { exact: true })).toBeVisible()
        await expect(page.getByText(zh ? '已清理的明细不能恢复、逐次核对或补算。' : 'Cleaned-up details cannot be restored, reconciled individually or repriced.', { exact: false })).toBeVisible()
        await expect(page.getByRole('textbox')).toHaveCount(0)
        await expect(page.locator('html')).toHaveAttribute('data-usage-credentials', 'same-origin')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(errors).toEqual([])
      })
    }
    test('retained totals and quotas remain visible when all historical details have been cleaned up', async ({ page }) => {
      await page.route('https://synthetic.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
      await page.goto('https://synthetic.test/model-usage')
      await page.setContent(`<html lang="zh-CN" data-usage-administrator="true" data-usage-compacted="true"><body><script>${script}</script></body></html>`)
      await page.getByRole('button', { name: '医院工作台' }).click()
      await page.getByRole('menuitem', { name: '模型用量', exact: true }).click()
      await expect(page.getByRole('region', { name: '已派发请求', exact: true })).toContainText('3')
      await expect(page.getByRole('region', { name: '已知 Token', exact: true })).toContainText('120')
      await expect(page.getByText('当前没有可查看的请求明细', { exact: true })).toBeVisible()
      await expect(page.getByText('暂无模型调用', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '查看请求详情', exact: true })).toHaveCount(0)
      await page.getByRole('tab', { name: '额度与策略', exact: true }).click()
      const workspace = page.getByRole('region', { name: '工作区控制', exact: true })
      await expect(workspace.getByText('累计已用请求', { exact: true }).locator('..')).toContainText('3')
      await expect(workspace.getByText('剩余请求', { exact: true }).locator('..')).toContainText('7')
      const retention = page.getByRole('region', { name: '明细保留期', exact: true })
      await expect(retention.getByText('已清理明细', { exact: true }).locator('..')).toContainText('3')
      await retention.getByRole('checkbox', { name: '永久保留', exact: true }).check()
      await retention.getByRole('button', { name: '保存保留期', exact: true }).click()
      await expect(retention.getByText('明细保留期已保存', { exact: true })).toBeVisible()
      await page.getByRole('tab', { name: '用量总览', exact: true }).click()
      await expect(page.getByText('当前没有可查看的请求明细', { exact: true })).toBeVisible()
      await expect(page.getByText('已清理的明细不能恢复、逐次核对或补算。', { exact: false })).toBeVisible()
    })
    test('explicit repricing preserves original pricing and shows a separate versioned revision', async ({ page }) => {
      await page.route('https://synthetic.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
      await page.goto('https://synthetic.test/model-usage')
      await page.setContent(`<html lang="zh-CN" data-usage-administrator="true" data-usage-known="true"><body><script>${script}</script></body></html>`)
      await page.getByRole('button', { name: '医院工作台' }).click()
      await page.getByRole('menuitem', { name: '模型用量', exact: true }).click()
      await page.getByRole('button', { name: '查看请求详情' }).click()
      const detail = page.getByRole('region', { name: '请求详情', exact: true })
      await detail.getByRole('button', { name: '按当前价表补算', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '按当前价表补算', exact: true })
      await dialog.getByLabel('依据引用', { exact: true }).fill('ticket:reprice-1')
      await dialog.getByRole('button', { name: '确认补算', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(detail.getByText('0.00042', { exact: true })).toBeVisible()
      await expect(detail.getByText('prices-v2', { exact: true })).toBeVisible()
      await expect(detail.getByText('fx-v2', { exact: true })).toBeVisible()
      await expect(detail.getByText('ticket:reprice-1', { exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-usage-correction-kind', 'reprice')
      await expect(detail.getByRole('button', { name: '按当前价表补算', exact: true })).toHaveCount(0)
    })
  })
}
