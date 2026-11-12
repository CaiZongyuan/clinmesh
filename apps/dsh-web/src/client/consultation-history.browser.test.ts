import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) {
  test(`edits directly recorded history without source controls inside a ShadowRoot on React ${version}`, async ({ page }) => {
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto('http://localhost/')
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
    await expect(page.getByText('自动记录来源', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toHaveCount(0)
    expect(await page.getByLabel('现病史', { exact: true }).evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await page.getByRole('button', { name: '模拟历史病例', exact: true }).click()
    await page.getByRole('button', { name: '补录历史回答', exact: true }).click()
    await page.getByRole('button', { name: '模拟整理失败', exact: true }).click()
    await expect(page.getByRole('button', { name: '问诊自动记录', exact: true })).toHaveText('问诊自动记录')
    await expect(page.getByText(/病史整理失败|自动记录超时|未通过校验/)).toHaveCount(0)
    await page.getByRole('button', { name: '问诊自动记录', exact: true }).click()
    await expect(page.getByText('部分内容尚未写入病历，问诊原文已保存。可重试或直接编辑病历。', { exact: true })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
    await expect(page.getByLabel('控制结果')).toHaveText('pause,resume,backfill,retry')
    await expect(page.locator('[data-clinical-document-field="historyOfPresentIllness"] [data-required-indicator]')).toHaveText('*')
    await expect(page.locator('[data-clinical-document-field="familyHistory"] [data-required-indicator]')).toHaveCount(0)
    for (const [label, key] of [['月经史', 'menstrualHistory'], ['孕产史', 'obstetricHistory']] as const) {
      await expect(page.getByLabel(label, { exact: true })).not.toHaveAttribute('required', '')
      await expect(page.locator(`[data-clinical-document-field="${key}"] [data-required-indicator]`)).toHaveCount(0)
    }
    await page.getByRole('button', { name: '切换默认免填', exact: true }).click()
    const collapsedBar = page.locator('[data-reproductive-history-disclosure="collapsed"]')
    await expect(collapsedBar).toBeVisible()
    expect(await collapsedBar.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    const hpiLabelColor = await page.locator('[data-clinical-document-field="historyOfPresentIllness"] [data-slot="field-label"]').evaluate(node => getComputedStyle(node).color)
    const collapsedTitleColor = await collapsedBar.getByText('月经史、孕产史', { exact: true }).evaluate(node => getComputedStyle(node).color)
    expect(collapsedTitleColor).not.toBe(hpiLabelColor)
    for (const field of ['月经史', '孕产史']) await expect(page.getByLabel(field, { exact: true })).not.toBeVisible()
    await collapsedBar.getByRole('button', { name: /展开/ }).click()
    const expandedBar = page.locator('[data-reproductive-history-disclosure="expanded"]')
    await expect(expandedBar).toBeVisible()
    expect(await expandedBar.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    for (const field of ['月经史', '孕产史']) {
      await expect(expandedBar.getByText(field, { exact: true })).toHaveCount(1)
      expect(await expandedBar.getByText(field, { exact: true }).evaluate(node => getComputedStyle(node).color)).toBe(collapsedTitleColor)
      await expect(page.getByLabel(field, { exact: true })).toBeVisible()
    }
    const allergyBottom = (await page.getByLabel('过敏史', { exact: true }).boundingBox())!.y
    const menstrualTop = (await page.getByLabel('月经史', { exact: true }).boundingBox())!.y
    const examTopBeforeType = (await page.getByLabel('体格检查', { exact: true }).boundingBox())!.y
    expect(allergyBottom).toBeLessThan(menstrualTop)
    expect(menstrualTop).toBeLessThan(examTopBeforeType)
    await page.getByLabel('月经史', { exact: true }).fill('补')
    await expect(expandedBar.getByRole('button', { name: '收起', exact: true })).toHaveCount(0)
    const examTopAfterType = (await page.getByLabel('体格检查', { exact: true }).boundingBox())!.y
    expect(Math.abs(examTopAfterType - examTopBeforeType)).toBeLessThanOrEqual(0.5)
    await page.getByLabel('月经史', { exact: true }).fill('')
    await expandedBar.getByRole('button', { name: '收起', exact: true }).click()
    await expect(collapsedBar).toBeVisible()
    await page.getByRole('button', { name: '切换默认免填', exact: true }).click()
    await expect(page.locator('[data-reproductive-history-disclosure]')).toHaveCount(0)
    await page.getByRole('button', { name: '核实文书类型', exact: true }).click()
    await page.getByLabel('核实依据', { exact: true }).fill('医生确认本次为专科初诊。')
    await page.getByRole('dialog').getByRole('button', { name: '核实文书类型', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    for (const [field, key] of [['月经史', 'menstrualHistory'], ['孕产史', 'obstetricHistory']] as const) {
      const textarea = page.getByLabel(field, { exact: true })
      expect(await textarea.evaluate(element => element.tagName)).toBe('TEXTAREA')
      await expect(textarea).toHaveAttribute('required', '')
      await expect(page.locator(`[data-clinical-document-field="${key}"] [data-required-indicator]`)).toHaveText('*')
      await expect(textarea).toHaveAttribute('maxlength', '4000')
      await expect(textarea).toHaveValue('')
    }
    await page.getByRole('button', { name: '模拟自动记录', exact: true }).click()
    for (const [field, value] of Object.entries({
      chiefComplaint: '自述头晕六天', historyOfPresentIllness: '医生核对：头晕五天。',
      priorMedicalHistory: '合成长病史记录。'.repeat(80), familyHistory: '患者自述父亲患高血压。',
      allergyHistory: '患者自述青霉素用药后出现皮疹。', menstrualHistory: '患者自述已绝经。', obstetricHistory: '患者自述孕2产2。', physicalExamination: '双肺呼吸音清，未闻及啰音。',
      auxiliaryExamination: '检验报告：血钾正常。', assessment: '头晕待查。', disposition: '先完善检查。', followUp: '三日后复诊。',
    })) await expect(page.locator(`[data-clinical-document-field="${field}"]`).getByRole('textbox')).toHaveValue(value)
    await expect(page.getByLabel('家族史', { exact: true })).toHaveValue('患者自述父亲患高血压。')
    await expect(page.getByLabel('过敏史', { exact: true })).toHaveValue('患者自述青霉素用药后出现皮疹。')
    const obstetricField = page.locator('[data-clinical-document-field="obstetricHistory"]')
    const menstrualField = page.locator('[data-clinical-document-field="menstrualHistory"]')
    // Preceding fields keep these updates out of view. Their reminders must
    // survive until the doctor scrolls to them, including inside a ShadowRoot.
    const clockStart = new Date('2026-10-14T09:00:00Z')
    await page.clock.install({ time: clockStart })
    await page.clock.pauseAt(new Date(clockStart.getTime() + 1_000))
    await page.clock.fastForward(6_000)
    await expect(obstetricField.getByRole('status')).toHaveText('已更新')
    await obstetricField.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await expect(menstrualField.getByRole('textbox')).not.toBeInViewport()
    await expect(obstetricField.locator('[data-clinical-document-update]')).toHaveAttribute('data-clinical-document-update', 'visible')
    const flow = obstetricField.locator('.clinical-document-update-flow')
    expect(await flow.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none')
    expect(await flow.evaluate(element => getComputedStyle(element, '::before').animationPlayState)).toBe('running')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await flow.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.clock.runFor(3_000)
    await page.getByRole('button', { name: '切换病历显示', exact: true }).click()
    await expect(obstetricField).toHaveCount(0)
    await page.clock.fastForward(10_000)
    await page.getByRole('button', { name: '切换病历显示', exact: true }).click()
    await obstetricField.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await expect(menstrualField.getByRole('textbox')).not.toBeInViewport()
    await expect(obstetricField.locator('[data-clinical-document-update]')).toHaveAttribute('data-clinical-document-update', 'visible')
    await page.clock.runFor(1_000)
    expect(await obstetricField.locator('[data-clinical-document-update]').getAttribute('data-clinical-document-update')).toBe('fading')
    await page.clock.fastForward(800)
    await expect(obstetricField.getByRole('status')).toHaveCount(0)
    await menstrualField.getByRole('textbox').scrollIntoViewIfNeeded()
    await expect(menstrualField.locator('[data-clinical-document-update]')).toHaveAttribute('data-clinical-document-update', 'visible')
    await page.clock.runFor(1_000)
    expect(await menstrualField.locator('[data-clinical-document-update]').getAttribute('data-clinical-document-update')).toBe('visible')
    await page.clock.runFor(3_000)
    expect(await menstrualField.locator('[data-clinical-document-update]').getAttribute('data-clinical-document-update')).toBe('fading')
    await page.clock.fastForward(800)
    await expect(menstrualField.getByRole('status')).toHaveCount(0)
    for (const dark of [false, true]) {
      await page.locator('[data-clinmesh-app]').evaluate((element, dark) => element.classList.toggle('dark', dark), dark)
      const sizes: number[] = []
      for (const font of ['standard', 'larger', 'large']) {
        await page.locator('[data-clinmesh-app]').evaluate((element, font) => element.setAttribute('data-font-size', font), font)
        const family = page.locator('[data-clinical-document-field="familyHistory"]')
        sizes.push(await family.getByRole('textbox').evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
        for (let language = 0; language < 2; language++) {
          for (const field of ['priorMedicalHistory', 'menstrualHistory', 'obstetricHistory', 'familyHistory', 'allergyHistory']) {
            const element = page.locator(`[data-clinical-document-field="${field}"]`)
            // The update outline extends one pixel; the text control itself must fit.
            expect(await element.evaluate(node => node.scrollWidth - node.clientWidth), field).toBeLessThanOrEqual(1)
            expect(await element.getByRole('textbox').evaluate(node => node.getBoundingClientRect().right <= node.parentElement!.getBoundingClientRect().right + 0.5), field).toBe(true)
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
    await expect(page.locator('[data-clinical-document-field="familyHistory"] dd')).toHaveText('患者自述父亲患高血压。')
    await expect(page.locator('[data-clinical-document-field="menstrualHistory"] dd')).toHaveText('患者自述已绝经。')
    await expect(page.locator('[data-clinical-document-field="obstetricHistory"] dd')).toHaveText('患者自述孕2产2。')
    await expect(page.locator('[data-clinical-document-field="physicalExamination"] dd')).toHaveText('双肺呼吸音清，未闻及啰音。')
    await expect(page.locator('[data-clinical-document-field="auxiliaryExamination"] dd')).toHaveText('检验报告：血钾正常。')
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
