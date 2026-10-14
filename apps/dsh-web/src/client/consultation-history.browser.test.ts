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
    const superseded = page.locator('[data-consultation-addition="superseded"]')
    await page.locator('[data-consultation-field-suggestions] > details > summary').click()
    await expect(superseded).toContainText('已被更正')
    await expect(superseded).not.toContainText('请手工核对病历后确认')
    await expect(superseded.getByRole('button', { name: '确认已核对', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-consultation-unreviewed]')).toHaveAttribute('data-consultation-unreviewed', '2')
    await page.getByRole('button', { name: '问诊自动记录', exact: true }).click()
    await expect(page.getByText('自动记录超时，患者回答已保存，请根据问诊原文补充病史。', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pending.locator('dt')).toHaveText(['当前内容', '拟应用内容'])
    await expect(pending.locator('dd').first()).toHaveText('医生核对：头晕五天。')
    await expect(pending).toContainText('更正建议')
    await expect(pending).toContainText('仅替换下方所示当前片段')
    const panel = page.locator('[data-consultation-field-suggestions="historyOfPresentIllness"]')
    await expect(panel.getByRole('heading', { name: '自动整理建议', exact: true })).toBeVisible()
    await expect(panel.getByRole('status')).toHaveText('待处理 2')
    expect(await panel.evaluate(element => {
      const style = getComputedStyle(element)
      return parseFloat(style.borderTopWidth) > 0 && parseFloat(style.paddingTop) > 0
    })).toBe(true)
    expect(await pending.evaluate(element => element.closest('[data-clinical-document-field]')?.getAttribute('data-clinical-document-field'))).toBe('historyOfPresentIllness')
    const accept = page.getByRole('button', { name: '应用建议', exact: true })
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
    const scrolling = source.locator('[data-consultation-source-content]')
    expect(await scrolling.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await scrolling.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await scrolling.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)).toBe(true)
    expect(await source.locator('blockquote').evaluate(element => element.getBoundingClientRect().bottom
      <= element.closest('[data-consultation-source-content]')!.getBoundingClientRect().bottom + 1)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(source).toHaveCount(0)
    expect(await applied.getByRole('button', { name: '查看来源', exact: true }).evaluate(element => (element.getRootNode() as ShadowRoot).activeElement === element)).toBe(true)
    await page.getByRole('button', { name: '模拟跨轮总结', exact: true }).click()
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source).toContainText('Agent 病史总结：自述头晕六天；夜间亦会头晕，否认胸痛')
    await expect(source.locator('blockquote')).toHaveCount(2)
    await expect(source.locator('blockquote').last()).toHaveText('晚上也会头晕，但是胸口不痛。')
    await expect(source).toContainText('医生提问：夜间是否头晕，有没有胸痛？')
    await expect(source.locator('mark')).toHaveText(['刚才说错了，头晕是六天。', '晚上也会头晕，但是胸口不痛。'])
    expect(await source.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '模拟重复引用', exact: true }).click()
    await applied.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source.locator('blockquote')).toHaveText('我之前没有发热。发热。')
    await expect(source.locator('mark')).toHaveText('发热。')
    expect(await source.locator('blockquote').evaluate(element => element.firstChild?.textContent)).toBe('我之前没有发热。')
    await page.keyboard.press('Escape')
    await applied.getByRole('button', { name: '确认已核对', exact: true }).click()
    await expect(applied).toContainText('已应用')
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
    await page.getByRole('button', { name: '问诊自动记录', exact: true }).click()
    await expect(page.getByText('已有问诊可补录，点击后才整理历史回答。', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '补录历史回答', exact: true }).click()
    await page.getByRole('button', { name: '模拟整理失败', exact: true }).click()
    await expect(page.locator('[data-consultation-recording]')).toHaveAttribute('data-consultation-recording', 'failed')
    await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
    await expect(page.getByLabel('控制结果')).toHaveText('pause,resume,backfill,retry')
    expect(await pending.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    for (const font of ['small', 'default', 'large']) {
      await page.locator('[data-clinmesh-app]').evaluate((element, font) => { element.setAttribute('data-font-size', font) }, font)
      for (let language = 0; language < 2; language++) {
        const field = page.locator('[data-clinical-document-field="historyOfPresentIllness"]')
        expect(await field.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        await field.getByRole('textbox').scrollIntoViewIfNeeded()
        await expect(field.getByRole('textbox')).toBeInViewport()
        await page.getByRole('button', { name: '切换语言', exact: true }).click()
      }
    }
    await page.getByRole('button', { name: '模拟字段建议', exact: true }).click()
    const chief = page.locator('[data-clinical-document-field="chiefComplaint"]')
    const prior = page.locator('[data-clinical-document-field="priorMedicalHistory"]')
    const family = page.locator('[data-clinical-document-field="familyHistory"]')
    const allergy = page.locator('[data-clinical-document-field="allergyHistory"]')
    await expect(chief.locator('[data-consultation-addition="pending"]')).toContainText('自述头晕六天')
    await expect(prior.locator('[data-consultation-addition="pending"]')).toContainText('合成长病史建议。'.repeat(80))
    await expect(chief.getByRole('textbox')).toHaveValue('')
    await expect(prior.getByRole('textbox')).toHaveValue('')
    await expect(family.locator('[data-consultation-addition="pending"]')).toHaveCount(2)
    await expect(family.getByRole('status')).toHaveText('待处理 2')
    await expect(allergy.locator('[data-consultation-addition="pending"]')).toContainText('青霉素用药后出现皮疹')
    await expect(family.getByRole('textbox')).toHaveValue('')
    await expect(allergy.getByRole('textbox')).toHaveValue('')
    for (const field of [chief, prior, family, allergy]) {
      expect(await field.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const apply = field.getByRole('button', { name: '应用建议', exact: true }).last()
      await apply.scrollIntoViewIfNeeded()
      await expect(apply).toBeInViewport()
      expect(await apply.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.getRootNode() instanceof ShadowRoot
          && (element.getRootNode() as ShadowRoot).elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === element
      })).toBe(true)
    }
    for (const dark of [false, true]) {
      await page.locator('[data-clinmesh-app]').evaluate((element, dark) => element.classList.toggle('dark', dark), dark)
      const fontSizes: number[] = []
      for (const font of ['standard', 'larger', 'large']) {
        await page.locator('[data-clinmesh-app]').evaluate((element, font) => element.setAttribute('data-font-size', font), font)
        fontSizes.push(await family.getByRole('textbox').evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
        for (let language = 0; language < 2; language++) {
          for (const field of [prior, family, allergy]) {
            expect(await field.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
            expect(await field.getByRole('textbox').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36)
            const sourceButton = field.getByRole('button', { name: language === 0 ? '查看来源' : 'View source', exact: true }).last()
            await sourceButton.scrollIntoViewIfNeeded()
            await expect(sourceButton).toBeInViewport()
          }
          await page.getByRole('button', { name: '切换语言', exact: true }).click()
        }
      }
      expect(fontSizes[1]).toBeGreaterThan(fontSizes[0]!)
      expect(fontSizes[2]).toBeGreaterThan(fontSizes[1]!)
    }
    await expect(page.locator('[data-clinical-document-field="physicalExamination"] [data-consultation-field-suggestions]')).toHaveCount(0)
    await page.getByRole('button', { name: '模拟应用失败', exact: true }).click()
    await chief.getByRole('button', { name: '应用建议', exact: true }).click()
    await expect(chief.getByRole('alert')).toBeVisible()
    await expect(prior.getByRole('alert')).toHaveCount(0)
    await expect(chief.getByRole('textbox')).toHaveValue('')
    await page.getByRole('button', { name: '模拟签署准备', exact: true }).click()
    await expect(chief.getByRole('button', { name: '应用建议', exact: true })).toBeDisabled()
    await expect(prior.getByRole('button', { name: '忽略建议', exact: true })).toBeDisabled()
    await chief.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(source).toHaveCount(0)
    await page.getByRole('button', { name: '模拟已签内容', exact: true }).click()
    await expect(prior.locator('[data-consultation-addition="pending"]')).toContainText('合成长病史建议。')
    await expect(prior.getByRole('button', { name: '应用建议', exact: true })).toHaveCount(0)
    await prior.getByRole('button', { name: '查看来源', exact: true }).click()
    await expect(source).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(source).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
