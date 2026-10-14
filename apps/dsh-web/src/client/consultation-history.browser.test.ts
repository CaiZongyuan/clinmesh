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
    await expect(page.getByRole('button', { name: '应用建议', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '确认已核对', exact: true })).toHaveCount(0)
    const panel = page.locator('[data-consultation-field-sources="historyOfPresentIllness"]')
    await panel.locator('summary').click()
    const applied = panel.locator('[data-consultation-addition="applied"]').last()
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    const source = page.getByRole('dialog', { name: '患者原回答', exact: true })
    await expect(source).toBeVisible()
    await expect(source.locator('mark')).toHaveText('刚才说错了，头晕是六天。')
    expect(await source.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(source).toHaveCount(0)
    await page.getByRole('button', { name: '模拟跨轮总结', exact: true }).click()
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source.locator('blockquote')).toHaveCount(2)
    await expect(source.locator('mark')).toHaveText(['刚才说错了，头晕是六天。', '晚上也会头晕，但是胸口不痛。'])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '模拟重复引用', exact: true }).click()
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source.locator('blockquote')).toHaveText('我之前没有发热。发热。')
    await expect(source.locator('mark')).toHaveText('发热。')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await page.getByRole('button', { name: '模拟历史病例', exact: true }).click()
    await page.getByRole('button', { name: '补录历史回答', exact: true }).click()
    await page.getByRole('button', { name: '模拟整理失败', exact: true }).click()
    await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
    await expect(page.getByLabel('控制结果')).toHaveText('pause,resume,backfill,retry')
    await page.getByRole('button', { name: '模拟自动记录', exact: true }).click()
    await expect(page.getByLabel('家族史', { exact: true })).toHaveValue('患者自述父亲患高血压。')
    await expect(page.getByLabel('过敏史', { exact: true })).toHaveValue('患者自述青霉素用药后出现皮疹。')
    for (const dark of [false, true]) {
      await page.locator('[data-clinmesh-app]').evaluate((element, dark) => element.classList.toggle('dark', dark), dark)
      const sizes: number[] = []
      for (const font of ['standard', 'larger', 'large']) {
        await page.locator('[data-clinmesh-app]').evaluate((element, font) => element.setAttribute('data-font-size', font), font)
        const family = page.locator('[data-clinical-document-field="familyHistory"]')
        sizes.push(await family.getByRole('textbox').evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
        for (let language = 0; language < 2; language++) {
          for (const field of ['priorMedicalHistory', 'familyHistory', 'allergyHistory']) {
            const element = page.locator(`[data-clinical-document-field="${field}"]`)
            expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
            await element.getByRole('textbox').scrollIntoViewIfNeeded()
            await expect(element.getByRole('textbox')).toBeInViewport()
          }
          await page.getByRole('button', { name: '切换语言', exact: true }).click()
        }
      }
      expect(sizes[1]).toBeGreaterThan(sizes[0]!)
      expect(sizes[2]).toBeGreaterThan(sizes[1]!)
    }
    await page.getByRole('button', { name: '模拟签署准备', exact: true }).click()
    await expect(page.getByLabel('家族史', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '模拟已签内容', exact: true }).click()
    const signedSources = page.locator('[data-consultation-field-sources="familyHistory"]')
    await signedSources.locator('summary').click()
    await signedSources.getByRole('button', { name: '查看来源', exact: true }).first().click()
    await expect(source).toBeVisible()
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
}
