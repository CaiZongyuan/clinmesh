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
    expect(await pending.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}
