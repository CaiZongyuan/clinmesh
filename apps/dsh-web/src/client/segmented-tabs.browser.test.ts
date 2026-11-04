import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, { script: string; styles: string }>()
async function buildFixture(version: string) {
  const existing = artifacts.get(version)
  if (existing !== undefined) return existing
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
    build: { write: false, lib: {
      entry: fileURLToPath(new URL('./segmented-tabs.browser.fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'SegmentedTabsContract',
    } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing segmented tabs browser fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

async function mount(page: Page, version: string) {
  const { script, styles } = await buildFixture(version)
  await page.setViewportSize({ width: 900, height: 700 })
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
  ))).toEqual({ ready: true })
}

const box = async (locator: Locator) => {
  const rect = await locator.evaluate(element => element.getBoundingClientRect().toJSON() as Record<'x' | 'y' | 'width' | 'height', number>)
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
}
const background = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).backgroundColor)
const indicator = (list: Locator) => list.locator('[data-slot="tabs-indicator"]')

for (const version of ['18', '19']) {
  test(`segmented tabs mark the active tab with a moving indicator and view switches drop the option check (${version})`, async ({ page }) => {
    await mount(page, version)
    for (const theme of ['light', 'dark']) {
      const root = page.locator(`[data-theme-root="${theme}"]`)
      const queue = root.getByRole('tablist', { name: '队列' })
      // 选中块与底槽颜色不同，并贴合当前页签；切换后移到新页签。
      await expect(indicator(queue)).toBeVisible()
      expect(await background(indicator(queue))).not.toBe(await background(queue))
      await expect.poll(() => box(indicator(queue))).toEqual(await box(queue.getByRole('tab', { name: '在诊' })))
      await queue.getByRole('tab', { name: '完诊' }).click()
      await expect.poll(() => box(indicator(queue))).toEqual(await box(queue.getByRole('tab', { name: '完诊' })))
      // 2×2 网格中指示器同时对准新页签所在的行和列。
      const status = root.getByRole('tablist', { name: '缴费状态' })
      await status.getByRole('tab', { name: '结果未知' }).click()
      await expect.poll(() => box(indicator(status))).toEqual(await box(status.getByRole('tab', { name: '结果未知' })))
      // 下划线贴在当前页签底边下方，随切换移动。
      const sections = root.getByRole('tablist', { name: '工作分区' })
      await sections.getByRole('tab', { name: '检查' }).click()
      const tab = await box(sections.getByRole('tab', { name: '检查' }))
      await expect.poll(async () => { const line = await box(indicator(sections)); return [line.x, line.width, line.height] }).toEqual([tab.x, tab.width, 2])
      // 门诊/住院是视图切换：选中项无勾、不是实心主色；表单选项仍实心带勾。
      const mode = root.getByRole('group', { name: '门诊与住院' })
      const outpatient = mode.getByRole('button', { name: '门诊', exact: true })
      await expect(outpatient).toHaveAttribute('aria-pressed', 'true')
      expect(await outpatient.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none')
      expect(await background(outpatient)).not.toBe(await background(mode))
      const option = root.getByRole('group', { name: '合成选项' }).getByRole('button', { name: '甲', exact: true })
      expect(await option.evaluate(element => getComputedStyle(element, '::before').content)).toContain('✓')
    }
    // 减少动态效果时不做过渡，指示器直接到位。
    const transition = () => indicator(page.getByRole('tablist', { name: '队列' }).first()).evaluate(element => getComputedStyle(element).transitionProperty)
    expect(await transition()).not.toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await transition()).toBe('none')
  })
}
