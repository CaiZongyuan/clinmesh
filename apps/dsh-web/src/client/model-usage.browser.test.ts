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
    for (const scenario of [{ locale: 'zh-CN', theme: 'dark', width: 390 }, { locale: 'en-US', theme: 'light', width: 1280 }]) {
      test(`opens from host Settings at ${scenario.width}px in ${scenario.locale}`, async ({ page }) => {
        const zh = scenario.locale === 'zh-CN'
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.setViewportSize({ width: scenario.width, height: 844 })
        await page.setContent(`<html lang="${scenario.locale}" data-theme="${scenario.theme}"><body><script>${script}</script></body></html>`)
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
        await page.getByRole('button', { name: zh ? '应用筛选' : 'Apply filters' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-usage-filter', /caseId=case-synthetic/)
        await page.getByRole('button', { name: zh ? '查看请求详情' : 'View request detail' }).click()
        const detail = page.getByRole('region', { name: zh ? '请求详情' : 'Request detail', exact: true })
        await expect(detail).toBeFocused()
        await expect(detail.getByText(zh ? '已派发' : 'Dispatched', { exact: true })).toBeVisible()
        await expect(detail.getByText('historical-actual-model', { exact: true })).toBeVisible()
        await expect(detail.getByText('turn-a', { exact: true })).toBeVisible()
        await expect(detail.getByText('document-c', { exact: true })).toBeVisible()
        await page.getByRole('tab', { name: zh ? '额度与策略' : 'Quotas and policy' }).click()
        await expect(page.getByText(zh ? '无限' : 'Unlimited', { exact: true })).toHaveCount(3)
        await expect(page.getByRole('switch')).toHaveCount(0)
        await expect(page.locator('html')).toHaveAttribute('data-usage-credentials', 'same-origin')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(errors).toEqual([])
      })
    }
  })
}
