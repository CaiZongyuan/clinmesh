import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`reviews sourced history corrections inside a ShadowRoot on React ${version}`, async ({ page }) => {
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./consultation-history.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'ConsultationHistory' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing history fixture')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const css = await buildSurfaceStyles()
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const pending = page.locator('[data-consultation-addition="pending"]')
    await expect(page.getByText('自动记录超时，患者回答已保存，请根据问诊原文补充病史。', { exact: true })).toBeVisible()
    await expect(pending).toContainText('原内容：医生核对：头晕五天。')
    await expect(pending).toContainText('患者原回答：刚才说错了，头晕是六天。')
    const accept = page.getByRole('button', { name: '接受替换', exact: true })
    await expect(accept).toBeDisabled()
    await page.getByRole('button', { name: '模拟保存编辑' }).click()
    await expect(accept).toBeEnabled()
    await accept.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('核对结果')).toHaveText('synthetic-correction:accept')
    await page.getByRole('button', { name: '忽略建议', exact: true }).click()
    await expect(page.getByLabel('核对结果')).toHaveText('synthetic-correction:accept,synthetic-correction:ignore')
    const applied = page.locator('[data-consultation-addition="applied"]')
    await expect(applied).toContainText('自动更正')
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    const source = page.getByRole('dialog', { name: '患者原回答', exact: true })
    await expect(source).toBeInViewport({ ratio: 1 })
    await expect(source.locator('blockquote')).toHaveText('刚才说错了，头晕是六天。\n' + '我站起来会更明显，休息后会缓解。\n'.repeat(45) + '最后补充：夜间也会头晕。')
    expect(await source.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    expect(await source.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const scrolling = source.locator('blockquote').locator('..')
    expect(await scrolling.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await scrolling.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await scrolling.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)).toBe(true)
    expect(await source.locator('blockquote').evaluate(element => element.getBoundingClientRect().bottom
      <= element.parentElement!.getBoundingClientRect().bottom + 1)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(source).toHaveCount(0)
    await applied.getByRole('button', { name: '确认已核对', exact: true }).click()
    await expect(applied).toContainText('已核对')
    await applied.getByRole('button', { name: '撤销此条', exact: true }).click()
    await expect(page.locator('[data-consultation-addition="undone"]')).toContainText('已撤销')
    await expect(page.getByLabel('核对结果')).toHaveText('synthetic-correction:accept,synthetic-correction:ignore,synthetic-applied:confirm,synthetic-applied:undo')
    const pause = page.getByRole('button', { name: '暂停自动整理', exact: true })
    await pause.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'paused')
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'processing')
    await page.getByRole('button', { name: '模拟历史病例', exact: true }).click()
    await expect(page.getByText('已有问诊可补录，点击后才整理历史回答。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '补录历史回答', exact: true }).click()
    await page.getByRole('button', { name: '模拟整理失败', exact: true }).click()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'failed')
    await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
    await expect(page.getByLabel('控制结果')).toHaveText('pause,resume,backfill,retry')
    expect(await pending.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}
