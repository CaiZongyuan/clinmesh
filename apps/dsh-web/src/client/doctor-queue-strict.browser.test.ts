import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`医生队列 StrictMode 开发模式 React ${version}`, () => {
  let script: string
  test.beforeAll(async () => {
    const react = version === '18' ? 'react18' : 'react'
    const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({
      configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] },
      build: { write: false, minify: false, lib: {
        entry: fileURLToPath(new URL('./outpatient-queues.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'DoctorQueueStrictContract',
      } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const chunk = outputs.find(output => output.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing StrictMode doctor queue fixture')
    script = chunk.code
  })
  test('effect 与 callback ref 重放后仍保留唯一导航，重新挂载创建新宿主', async ({ page }) => {
    await page.setContent(`<!doctype html><html><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const list = page.getByRole('tablist', { name: '门诊诊疗', exact: true })
    await expect(list).toHaveCount(1)
    await expect(list).toBeVisible()
    const original = await list.elementHandle()
    await list.getByRole('tab', { name: '完诊', exact: true }).click()
    await expect(list.getByRole('tab', { name: '完诊', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(await list.evaluate((element, original) => element === original, original)).toBe(true)
    await page.getByRole('button', { name: 'row', exact: true }).click()
    await expect(list).toHaveCount(0)
    expect(await original!.evaluate(element => element.isConnected)).toBe(false)
    await page.getByRole('button', { name: 'doctor', exact: true }).click()
    await expect(list).toHaveCount(1)
    await expect(list).toBeVisible()
    expect(await list.evaluate((element, original) => element === original, original)).toBe(false)
  })
})
