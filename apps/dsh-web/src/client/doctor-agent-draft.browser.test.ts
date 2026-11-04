import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`医生真实草稿工具 React ${version}`, () => {
  let script: string
  let css: string
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./doctor-agent-draft.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'DoctorAgentDraft' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const chunk = outputs.find(output => output.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing doctor agent fixture')
    script = chunk.code
    css = await buildSurfaceStyles()
  })
  test(`生产医生草稿工具保留逐字段及逐患者来源 React ${version}`, async ({ page }) => {
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto('http://localhost/')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const fill = page.getByRole('button', { name: '助手填写', exact: true })
    await expect(fill).toBeEnabled()
    await fill.click()
    await expect(page.getByLabel('助手填写结果').first()).toHaveText('填写完成')
    const history = page.getByLabel('现病史', { exact: true })
    const assessment = page.getByLabel('评估', { exact: true })
    await expect(history).toHaveValue('助手整理：咽痛两天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'dashed')
    await expect(assessment).toHaveCSS('border-top-style', 'dashed')
    await history.fill('医生核对：咽痛三天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'solid')
    await expect(assessment).toHaveCSS('border-top-style', 'dashed')
    const diagnosis = page.getByRole('tab', { name: '诊断', exact: true })
    if (!await diagnosis.isVisible()) await page.getByRole('button', { name: '更多', exact: true }).click()
    await diagnosis.click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(history).toHaveValue('医生核对：咽痛三天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'solid')
    await expect(assessment).toHaveCSS('border-top-style', 'dashed')
    await page.getByRole('button', { name: '选择病例 草稿患者2', exact: true }).click()
    await expect(page.getByRole('region', { name: '当前患者' }).getByRole('heading', { name: '草稿患者2', exact: true })).toBeVisible()
    await expect(history).toHaveValue('初始病史。')
    await expect(history).toHaveCSS('border-top-style', 'solid')
    await expect(assessment).toHaveCSS('border-top-style', 'solid')
    await page.getByRole('button', { name: '选择病例 草稿患者1', exact: true }).click()
    await expect(history).toHaveValue('医生核对：咽痛三天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'solid')
    await expect(assessment).toHaveCSS('border-top-style', 'dashed')
    await fill.click()
    await expect(history).toHaveValue('助手整理：咽痛两天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'dashed')
    await page.getByRole('button', { name: '拒绝人工保存', exact: true }).click()
    await history.fill('岗位甲未提交的私人工作稿')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => Number(await page.getByLabel('人工保存拒绝次数').textContent())).toBeGreaterThan(0)
    await page.getByRole('button', { name: '切换医生岗位', exact: true }).click()
    await expect(page.getByLabel('当前医生岗位')).toHaveText('role-doctor-2')
    await expect(history).toHaveValue('助手整理：咽痛两天，无呼吸困难。')
    await expect(history).toHaveCSS('border-top-style', 'solid')
    await expect(assessment).toHaveCSS('border-top-style', 'solid')
    await page.getByRole('button', { name: '助手填写诊断', exact: true }).click()
    await expect(page.getByLabel('助手填写结果').nth(1)).toHaveText('填写完成')
    if (!await diagnosis.isVisible()) await page.getByRole('button', { name: '更多', exact: true }).click()
    await diagnosis.click()
    const editDiagnosis = page.getByRole('button', { name: '编辑诊断 合成急性咽炎', exact: true })
    await editDiagnosis.click()
    const dialog = page.getByRole('dialog', { name: '编辑诊断', exact: true })
    const note = dialog.locator('#diagnosis-composer-note')
    await expect(note).toHaveValue('助手建议：结合咽部查体核对。')
    await expect(note).toHaveCSS('border-top-style', 'dashed')
    await note.fill('本次修改不保留')
    await expect(note).toHaveValue('本次修改不保留')
    await expect(note).toHaveCSS('border-top-style', 'solid')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await editDiagnosis.click()
    await expect(note).toHaveValue('助手建议：结合咽部查体核对。')
    await expect(note).toHaveCSS('border-top-style', 'dashed')
    await expect(dialog.getByLabel('诊断类型', { exact: true })).toHaveCSS('outline-style', 'dashed')
    await note.fill('医生确认：咽部充血。')
    await expect(note).toHaveValue('医生确认：咽部充血。')
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await editDiagnosis.click()
    await expect(note).toHaveValue('医生确认：咽部充血。')
    await expect(note).toHaveCSS('border-top-style', 'solid')
    await expect(dialog.getByLabel('诊断类型', { exact: true })).toHaveCSS('outline-style', 'dashed')
    expect(errors).toEqual([])
  })
})
