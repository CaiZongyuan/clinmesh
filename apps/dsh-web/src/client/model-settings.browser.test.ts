import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`operates model settings by keyboard at narrow widths with React ${version}`, async ({ page }) => {
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./model-settings.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'ModelSettingContract' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
      if (!('output' in output)) throw new Error('Unexpected build watcher')
      return output.output
    })
    const script = outputs.find(output => output.type === 'chunk')
    if (!script || script.type !== 'chunk') throw new Error('Missing browser script')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 390, height: 700 })
    for (const language of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) {
      await page.setContent(`<html lang="${language}" style="color-scheme:${theme}"><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
      const select = page.getByLabel(language === 'zh-CN' ? 'ClinMesh 模型' : 'ClinMesh model')
      await expect(select).toBeEnabled()
      await expect(select).toHaveValue('default')
      await select.focus()
      await select.press('ArrowDown')
      await expect(select).toHaveValue(encodeModelRoute({ provider: 'a', model: 'same' }))
      await expect(page.getByRole('status')).toContainText(language === 'zh-CN' ? '已保存' : 'Saved')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    expect(errors).toEqual([])
  })
}
