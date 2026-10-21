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
        await page.getByRole('tab', { name: zh ? '额度与策略' : 'Quotas and policy' }).click()
        const workspace = page.getByRole('region', { name: zh ? '工作区控制' : 'Workspace controls', exact: true })
        await expect(workspace.getByText(zh ? '无限' : 'Unlimited', { exact: true })).toHaveCount(4)
        if (scenario.administrator) {
          await expect(page.getByRole('region', { name: zh ? '部署控制（只读）' : 'Deployment controls (read only)', exact: true }).getByText('6', { exact: true })).toBeVisible()
          await workspace.getByRole('checkbox', { name: zh ? '请求次数无限' : 'Unlimited requests' }).uncheck()
          await workspace.getByLabel(zh ? '请求次数上限' : 'Request limit', { exact: true }).fill('0')
          await workspace.getByRole('checkbox', { name: zh ? '启用模型生成' : 'Enable model generation' }).uncheck()
          await workspace.getByRole('button', { name: zh ? '保存工作区策略' : 'Save Workspace policy' }).click()
          await expect(page.getByText(zh ? '工作区策略已保存' : 'Workspace policy saved', { exact: true })).toBeVisible()
          expect(JSON.parse(await page.locator('html').getAttribute('data-usage-control-write') ?? '{}')).toEqual({ expectedVersion: 1, enabled: false, requests: 0, automaticRetries: true })
          await expect(page.locator('html')).toHaveAttribute('data-usage-idempotency', /^[0-9a-f-]{36}$/)
          await workspace.getByRole('checkbox', { name: zh ? '请求次数无限' : 'Unlimited requests' }).check()
          await workspace.getByRole('button', { name: zh ? '保存工作区策略' : 'Save Workspace policy' }).click()
          await expect(page.locator('html')).toHaveAttribute('data-usage-control-write', /"requests":null/)
        } else {
          await expect(page.getByRole('region', { name: 'Deployment controls (read only)', exact: true })).toHaveCount(0)
          await expect(workspace.getByRole('button', { name: 'Save Workspace policy' })).toHaveCount(0)
          await expect(workspace.getByText('Only administrators can change Workspace controls.', { exact: true })).toBeVisible()
        }
        await expect(page.locator('html')).toHaveAttribute('data-usage-credentials', 'same-origin')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(errors).toEqual([])
      })
    }
  })
}
