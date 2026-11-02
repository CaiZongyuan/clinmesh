import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`分诊助手字段 React ${version}`, () => {
  let script: string
  let styles: string
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./triage-draft.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'TriageDraftContract' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => {
      if (!('output' in output)) throw new Error('Unexpected browser watcher')
      return output.output
    })
    const chunk = outputs.find(output => output.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing triage fixture')
    script = chunk.code
    styles = await buildSurfaceStyles()
  })
  test('真实页面draft工具逐字段标记助手来源，人工修改及切换页签保留归属', async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const fill = page.getByRole('button', { name: '助手填写', exact: true })
    await expect(fill).toBeEnabled()
    await fill.click()
    await expect(page.getByLabel('助手填写结果')).toHaveText('填写完成')
    const complaint = page.getByLabel('主诉', { exact: true })
    const temperature = page.getByLabel('体温（°C）', { exact: true })
    const pulse = page.getByLabel('脉搏（次/分）', { exact: true })
    await expect(complaint).toHaveValue('助手填写的主诉')
    await expect(complaint).toHaveCSS('border-top-style', 'dashed')
    await expect(temperature).toHaveCSS('border-top-style', 'dashed')
    const acuity = page.getByRole('group', { name: '分诊级别', exact: true })
    await expect(acuity).toHaveCSS('outline-style', 'dashed')
    await acuity.getByRole('button', { name: '三级 · 急症', exact: true }).click()
    await expect(acuity).not.toHaveCSS('outline-style', 'dashed')
    await complaint.fill('人工核实的主诉')
    await expect(complaint).toHaveCSS('border-top-style', 'solid')
    await expect(temperature).toHaveCSS('border-top-style', 'dashed')
    await temperature.fill('37.2')
    await expect(temperature).toHaveCSS('border-top-style', 'solid')
    await expect(pulse).toHaveCSS('border-top-style', 'dashed')
    await page.getByRole('button', { name: '选择病例 合成分诊患者二', exact: true }).click()
    await expect(complaint).toHaveValue('')
    await expect(temperature).toHaveValue('37.0')
    await page.getByRole('button', { name: '选择病例 合成分诊患者', exact: true }).click()
    await expect(complaint).toHaveValue('人工核实的主诉')
    await expect(pulse).toHaveCSS('border-top-style', 'dashed')
    await page.getByRole('tab', { name: '已分诊', exact: true }).click()
    await page.getByRole('tab', { name: '待分诊', exact: true }).click()
    await expect(complaint).toHaveValue('人工核实的主诉')
    await expect(complaint).toHaveCSS('border-top-style', 'solid')
    await expect(pulse).toHaveCSS('border-top-style', 'dashed')
    await fill.click()
    await expect(complaint).toHaveValue('助手填写的主诉')
    await expect(complaint).toHaveCSS('border-top-style', 'dashed')
    await page.getByRole('button', { name: '切换数据世代', exact: true }).click()
    await expect(complaint).toHaveValue('')
    await expect(complaint).toHaveCSS('border-top-style', 'solid')
  })
})
