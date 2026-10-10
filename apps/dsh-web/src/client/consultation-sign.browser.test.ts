import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`reviews omissions and recovers signing inside a ShadowRoot on React ${version}`, async ({ page }) => {
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./consultation-sign.browser.fixture.tsx', import.meta.url)),
        formats: ['iife'], name: 'ConsultationSigning' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing signing fixture')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${await buildSurfaceStyles()}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.getByRole('button', { name: '模拟重连恢复', exact: true }).click()
    await expect(page.getByText('签署准备尚未结束', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
    await expect(page.getByLabel('签署结果')).toHaveText('cancelled')
    await page.getByRole('button', { name: '模拟取消失败', exact: true }).click()
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
    await expect(dialog).toBeInViewport({ ratio: 1 })
    expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(dialog).toContainText('待整理 2')
    await expect(dialog).toContainText('整理失败 1')
    await expect(dialog).toContainText('自动整理已暂停')
    await expect(dialog).toContainText('待核对冲突 1')
    const commit = dialog.getByRole('button', { name: '确认签署病历', exact: true })
    await expect(commit).toBeDisabled()
    const checkbox = dialog.getByRole('checkbox')
    await checkbox.focus()
    await page.keyboard.press('Space')
    await expect(commit).toBeEnabled()
    await dialog.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('服务暂时无法完成请求，请稍后重试。')
    await dialog.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(commit).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await commit.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel('签署结果')).toHaveText('signed:true')
    await page.getByRole('button', { name: 'Agent 签署提案', exact: true }).click()
    await expect(commit).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await expect(commit).toBeEnabled()
    await page.getByRole('button', { name: '切换宿主语言', exact: true }).evaluate(element => (element as HTMLButtonElement).click())
    const translated = page.getByRole('alertdialog', { name: 'Confirm medical record signature', exact: true })
    await expect(translated).toContainText('Review consultation history before signing')
    await expect(translated).toContainText('Chief complaint')
    await expect(translated.getByRole('checkbox')).toBeChecked()
    await translated.getByRole('button', { name: 'Confirm medical record signature', exact: true }).click()
    await expect(translated).toHaveCount(0)
    await expect(page.getByLabel('签署结果')).toHaveText('agent:true')
    expect(errors).toEqual([])
  })
}
