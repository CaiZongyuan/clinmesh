import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationStateSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
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
      entry: fileURLToPath(new URL('./diagnosis-prescription.browser.fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'DiagnosisPrescriptionContract',
    } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing diagnosis prescription browser fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}
async function mount(page: Page, version: string, mode: 'empty' | 'existing' | 'recommendations') {
  const { script, styles } = await buildFixture(version)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto('http://localhost/')
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html data-fixture-mode="${mode}"><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
  ))).toEqual({ ready: true })
  await page.getByRole('button', { name: /合成浏览器患者/ }).click()
}
async function appearance(page: Page, locale: 'zh-CN' | 'en-US', theme: 'light' | 'dark', fontSize: 'standard' | 'larger' | 'large', width: number) {
  await page.setViewportSize({ width, height: 900 })
  await page.evaluate(({ locale, theme, fontSize, width }) => {
    document.getElementById('diagnosis-prescription-host')!.style.width = `${width}px`
    window.dispatchEvent(new CustomEvent('diagnosis-prescription-appearance', { detail: { locale, theme, fontSize } }))
  }, { locale, theme, fontSize, width })
  const root = page.locator('[data-clinmesh-app="web"]')
  await expect(root).toHaveAttribute('lang', locale)
  await expect(root).toHaveAttribute('data-font-size', fontSize)
  await expect(root).toHaveAttribute('data-theme', theme)
}
async function expectNoFixtureErrors(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('diagnosis-prescription-errors')))
  const actual = z.object({ errors: z.array(z.string()) }).parse(JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8')))
  expect(actual.errors).toEqual([])
}
async function expectPanelBounded(page: Page, section: 'diagnosis' | 'prescription') {
  const panel = page.locator(`[data-agent-section="${section}"]`)
  const bounds = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
}
async function scrollWithinPanel(locator: Locator) {
  await locator.evaluate(element => {
    const panel = element.closest<HTMLElement>('[data-agent-section]')
    if (panel === null) throw new Error('Missing active doctor section')
    panel.scrollTop += element.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}
async function expectTextFits(locator: Locator) {
  const bounds = await locator.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    return { textLeft: text.left, textRight: text.right, boxLeft: box.left, boxRight: box.right }
  })
  expect(bounds.textLeft).toBeGreaterThanOrEqual(bounds.boxLeft - 1)
  expect(bounds.textRight).toBeLessThanOrEqual(bounds.boxRight + 1)
}
async function forEachAppearance(page: Page, verify: (locale: 'zh-CN' | 'en-US', width: number) => Promise<void>) {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      for (const fontSize of ['standard', 'larger', 'large'] as const) {
        for (const width of [1280, 390]) {
          await test.step(`${locale} ${theme} ${fontSize} ${width}`, async () => {
            await appearance(page, locale, theme, fontSize, width)
            await verify(locale, width)
          })
        }
      }
    }
  }
}
const diagnosisName = '合成诊断与需要完整显示的复杂中文名称'
const medicationName = '合成药品与需要完整显示的复杂中文通用名称'
async function readCase(page: Page) {
  return doctorCaseDetailSchema.parse(await page.evaluate(async () =>
    await (await fetch('/api/his/v1/doctor/cases/synthetic-case')).json(),
  ))
}
async function readRecommendations(page: Page, kind: DoctorRecommendationKind) {
  return doctorRecommendationStateSchema.parse(await page.evaluate(async kind =>
    await (await fetch(`/api/his/v1/doctor/cases/synthetic-case/recommendations/${kind}`)).json(), kind,
  ))
}

for (const version of ['18', '19']) {
  test(`resurfaces a removed proposal with changed evidence without selecting it on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations')
    await appearance(page, 'zh-CN', 'light', 'large', 390)
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    const secondary = panel.getByRole('checkbox', { name: '选择合成第二诊断', exact: true })
    await expect(secondary).toBeChecked()
    await panel.getByRole('button', { name: '移除合成第二诊断', exact: true }).click()
    await expect(secondary).toHaveCount(0)
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await readRecommendations(page, 'diagnosis')).generation).toBe(2)
    await expect(secondary).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('diagnosis-prescription-change-evidence')))
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await readRecommendations(page, 'diagnosis')).generation).toBe(3)
    await expect(secondary).toBeVisible()
    await expect(secondary).not.toBeChecked()
    await expect(panel.getByText('请核对新资料', { exact: true })).toBeVisible()
    await expect(panel.getByRole('checkbox', { name: `选择${diagnosisName}`, exact: true })).toBeChecked()
    await secondary.click()
    await expect(secondary).toBeChecked()
    await panel.getByRole('button', { name: /^确认选中诊断/ }).click()
    await expect.poll(async () => (await readCase(page)).diagnosis?.confirmation?.entries.length).toBe(2)
    await expectNoFixtureErrors(page)
  })

  test(`keeps sources collapsed and directly confirms selected diagnoses in ShadowRoot on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations')
    await appearance(page, 'zh-CN', 'light', 'large', 390)
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    const evidence = panel.getByRole('button', { name: '依据与说明', exact: true })
    const dialog = page.getByRole('dialog', { name: '依据与说明', exact: true })
    await expect(panel.getByRole('checkbox')).toHaveCount(2)
    await expect(panel.getByRole('checkbox').nth(0)).toBeChecked()
    await expect(panel.getByRole('checkbox').nth(1)).toBeChecked()
    await expect(page.getByRole('link', { name: /WS\/T 872/ })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /^采纳 / })).toHaveCount(0)
    await evidence.click()
    expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    for (const label of ['国家标准', '卫生行业标准', '诊疗方案', '临床指南', '药品说明书']) {
      await expect(dialog.getByText(label, { exact: true }).first()).toBeVisible()
    }
    const standard = dialog.getByRole('link', { name: /WS\/T 872/ }).first()
    await expect(standard).toHaveAttribute('href', /^https:\/\/www\.nhc\.gov\.cn\//)
    await expect(standard).toHaveAttribute('rel', 'noreferrer noopener')
    await expect(dialog.getByText('符合高血压诊断的患者，应进行首次评估，询问病史、进行体格检查和血尿常规、生化及心电图检测。', { exact: true }).first()).toBeVisible()
    await expect(dialog.getByText('合成病例第一条依据：仅验证来源展开与页面接线。', { exact: true })).toBeVisible()
    await expect(dialog.getByText('合成病例第二条依据：需要医生继续核实。', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(evidence).toBeFocused()
    await expectPanelBounded(page, 'diagnosis')
    expect((await readCase(page)).diagnosis?.draft).toBeUndefined()
    expect((await readCase(page)).diagnosis?.confirmation).toBeUndefined()
    await panel.getByRole('checkbox').nth(1).click()
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await readRecommendations(page, 'diagnosis')).generation).toBe(2)
    await expect(panel.getByRole('checkbox').nth(1)).not.toBeChecked()
    await panel.getByRole('button', { name: /^确认选中诊断/ }).click()
    await expect.poll(async () => (await readCase(page)).diagnosis?.confirmation?.entries.length).toBe(1)
    expect((await readCase(page)).diagnosis?.confirmation?.entries[0]).toMatchObject({ catalogItemId: 'synthetic-diagnosis-1', role: 'primary' })
    expect((await readCase(page)).medicationConclusion?.prescription).toBeUndefined()
    await expectNoFixtureErrors(page)
  })

  test(`requires explicit missing prescription fields and preserves manual edits through refresh and failure on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations')
    await appearance(page, 'zh-CN', 'dark', 'large', 390)
    await page.getByRole('tab', { name: '处方', exact: true }).click()
    const panel = page.getByRole('region', { name: '待开具处方', exact: true })
    const issue = panel.getByRole('button', { name: /^开具处方/ })
    await expect(issue).toBeDisabled()
    await expect(panel.getByText('用法用量待补充', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '依据与说明', exact: true }).click()
    const evidence = page.getByRole('dialog', { name: '依据与说明', exact: true })
    await expect(evidence.getByRole('link', { name: /络活喜/ }))
      .toHaveAttribute('href', 'https://www.viatris.cn/-/media/project/viatris-sites/product-document/02norvasc.pdf')
    await page.keyboard.press('Escape')
    await panel.getByRole('button', { name: '调整', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
    expect(await edit.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    const dose = edit.getByRole('textbox', { name: '每次剂量', exact: true })
    const course = edit.getByRole('spinbutton', { name: '疗程（天）', exact: true })
    const quantity = edit.getByRole('spinbutton', { name: '数量', exact: true })
    await expect(dose).toHaveValue('5 mg')
    await expect(edit.getByRole('combobox', { name: '频次', exact: true })).toContainText('每日一次')
    await expect(course).toHaveValue('')
    await expect(quantity).toHaveValue('')
    expect((await readCase(page)).medicationConclusion?.draft).toBeUndefined()
    await dose.fill('10 mg')
    await course.fill('7')
    await quantity.fill('2')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await expect(issue).toBeEnabled()
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await readRecommendations(page, 'prescription')).generation).toBe(2)
    await panel.getByRole('button', { name: '调整', exact: true }).click()
    await expect(dose).toHaveValue('10 mg')
    await expect(course).toHaveValue('7')
    await expect(quantity).toHaveValue('2')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    expect((await readCase(page)).medicationConclusion?.draft).toBeUndefined()
    await page.evaluate(() => window.dispatchEvent(new Event('diagnosis-prescription-fail-confirmation')))
    await issue.click()
    await expect(panel.getByText(/更新或提交未完成/)).toBeVisible()
    expect((await readCase(page)).medicationConclusion?.prescription).toBeUndefined()
    await panel.getByRole('button', { name: '调整', exact: true }).click()
    await expect(dose).toHaveValue('10 mg')
    await expect(course).toHaveValue('7')
    await expect(quantity).toHaveValue('2')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await issue.click()
    await expect.poll(async () => (await readCase(page)).medicationConclusion?.prescription?.items[0]?.quantity).toBe(2)
    expect((await readCase(page)).medicationConclusion?.prescription?.items[0]).toMatchObject({
      doseText: '10 mg', courseDays: 7, quantity: 2, medicationRequestId: 'synthetic-medication-request-0',
    })
    await expectPanelBounded(page, 'prescription')
    await expectNoFixtureErrors(page)
  })

  test(`restores the inline catalog search after cancelling a replacement on React ${version}`, async ({ page }) => {
    await mount(page, version, 'empty')
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const diagnosisCatalog = page.locator('[data-agent-section="diagnosis"] [data-agent-catalog="diagnosis"]')
    const diagnosisSearch = diagnosisCatalog.getByRole('textbox', { name: '搜索疾病目录' })
    await diagnosisSearch.fill('第二')
    await diagnosisCatalog.getByRole('button', { name: '选择 合成第二诊断 SYN-D2', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认诊断', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '更换诊断', exact: true }).click()
    const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
    await diagnosisDialog.getByRole('textbox', { name: '搜索疾病目录' }).fill('追加')
    await expect(diagnosisDialog.getByRole('button', { name: '选择 合成追加诊断 SYN-D3', exact: true })).toBeVisible()
    await diagnosisDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(diagnosisSearch).toHaveValue('第二')
    await expect(diagnosisCatalog.getByRole('button', { name: '选择 合成第二诊断 SYN-D2', exact: true })).toBeVisible()
    await expect(diagnosisCatalog.getByRole('button', { name: '选择 合成追加诊断 SYN-D3', exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '诊断详情', exact: true })
      .getByRole('heading', { name: '合成第二诊断', exact: true })).toBeVisible()

    await page.getByRole('tab', { name: '处方', exact: true }).click()
    const medicationCatalog = page.locator('[data-agent-section="prescription"] [data-agent-catalog="medication"]')
    const medicationSearch = medicationCatalog.getByRole('textbox', { name: '搜索药品目录' })
    await medicationSearch.fill('第二')
    await medicationCatalog.getByRole('button', { name: /^选择 合成第二药品/ }).click()
    await page.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await page.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    await expect(page.getByRole('button', { name: '正式开具处方', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '更换药品', exact: true }).click()
    const medicationDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await medicationDialog.getByRole('textbox', { name: '搜索药品目录' }).fill('复杂')
    await expect(medicationDialog.getByRole('button', { name: new RegExp(`^选择 ${medicationName}`) })).toBeVisible()
    await medicationDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(medicationSearch).toHaveValue('第二')
    await expect(medicationCatalog.getByRole('button', { name: /^选择 合成第二药品/ })).toBeVisible()
    await expect(medicationCatalog.getByRole('button', { name: new RegExp(`^选择 ${medicationName}`) })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '剂量', exact: true })).toHaveValue('每次一片')
    await expectNoFixtureErrors(page)
  })

  test(`keeps a multiline diagnosis confirmation within the viewport and focuses selected details on React ${version}`, async ({ page }) => {
    await mount(page, version, 'existing')
    await appearance(page, 'zh-CN', 'light', 'standard', 390)
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const list = page.getByRole('region', { name: '诊断列表', exact: true })
    await list.getByRole('button', { name: new RegExp(diagnosisName) }).click()
    await page.getByRole('textbox', { name: '诊断备注', exact: true }).fill('x\n'.repeat(250))
    const confirm = page.getByRole('button', { name: '确认诊断', exact: true })
    await expect(confirm).toBeEnabled()
    await confirm.click()
    const dialog = page.getByRole('alertdialog', { name: '确认诊断版本', exact: true })
    await expect(dialog).toBeVisible()
    const bounds = await dialog.evaluate(element => ({ top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom, height: element.getBoundingClientRect().height }))
    expect(bounds.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(900)
    const scrollToActions = async () => {
      await dialog.evaluate(element => {
        element.scrollTop = element.scrollHeight
        return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      })
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
      await expect(dialog.getByRole('button', { name: '确认诊断版本', exact: true })).toBeInViewport()
    }
    await scrollToActions()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '诊断备注', exact: true })).toHaveValue('x\n'.repeat(250))
    await confirm.click()
    await scrollToActions()
    await dialog.getByRole('button', { name: '确认诊断版本', exact: true }).click()
    await expect(page.getByText(/诊断已确认 · 第 2 版/)).toBeVisible()
    await page.getByRole('button', { name: '返回诊断列表', exact: true }).click()
    await list.getByRole('button', { name: /合成第二诊断/ }).click()
    await expect(page.getByRole('region', { name: '诊断详情', exact: true })
      .getByRole('heading', { name: '合成第二诊断', exact: true })).toBeFocused()
    await expectNoFixtureErrors(page)
  })

  test(`selects catalogs explicitly, confirms diagnoses and issues medication through the Surface on React ${version}`, async ({ page }) => {
    await mount(page, version, 'empty')
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '搜索疾病目录' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '诊断备注', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: `选择 ${diagnosisName} SYN-D1`, exact: true }).click()
    await page.getByRole('textbox', { name: '诊断备注', exact: true }).fill('合成浏览器编辑备注，确认后仍可修订。')
    const confirm = page.getByRole('button', { name: '确认诊断', exact: true })
    await expect(confirm).toBeEnabled()
    await confirm.click()
    const confirmation = page.getByRole('alertdialog', { name: '确认诊断版本', exact: true })
    await expect(confirmation.getByText(`SYN-D1 · ${diagnosisName}`, { exact: true })).toBeVisible()
    await confirmation.getByRole('button', { name: '确认诊断版本', exact: true }).click()
    await expect(page.getByRole('region', { name: '诊断列表', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '诊断备注', exact: true })).toHaveValue('合成浏览器编辑备注，确认后仍可修订。')
    await page.getByRole('textbox', { name: '诊断备注', exact: true }).fill('确认后更新的合成备注。')
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await confirmation.getByRole('button', { name: '确认诊断版本', exact: true }).click()
    await expect(page.getByText(/诊断已确认 · 第 2 版/)).toBeVisible()

    await page.getByRole('tab', { name: '处方', exact: true }).click()
    const catalog = page.locator('[data-agent-catalog="medication"]')
    await expect(catalog.getByRole('textbox', { name: '搜索药品目录' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '剂量', exact: true })).toHaveCount(0)
    const packaging = catalog.getByRole('combobox', { name: /^包装 合成药品/ })
    await packaging.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('option', { name: '20片/盒', exact: true }).click()
    await catalog.getByRole('button', { name: new RegExp(`^选择 ${medicationName} 10 mg 20片/盒`) }).click()
    await page.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await page.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    const issue = page.getByRole('button', { name: '正式开具处方', exact: true })
    await expect(issue).toBeEnabled()
    await issue.click()
    const issueDialog = page.getByRole('alertdialog', { name: '确认正式开具处方', exact: true })
    await issueDialog.getByRole('button', { name: '确认开具', exact: true }).click()
    await expect(page.getByRole('region', { name: '药品列表', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '剂量', exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '药品详情', exact: true }).getByText('20片/盒', { exact: true })).toBeVisible()
    await expectNoFixtureErrors(page)
  })

  test(`keeps first-stage catalogs, editors and final actions reachable in every appearance on React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    await mount(page, version, 'empty')
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    await page.getByRole('button', { name: `选择 ${diagnosisName} SYN-D1`, exact: true }).click()
    await page.getByRole('textbox', { name: '诊断备注', exact: true }).fill('长中文合成备注，验证字号与容器缩放时编辑内容不会丢失。'.repeat(10))
    await expect(page.getByRole('button', { name: '确认诊断', exact: true })).toBeEnabled()
    await page.getByRole('tab', { name: '处方', exact: true }).click()
    await page.locator('[data-agent-catalog="medication"]').getByRole('button', { name: new RegExp(`^选择 ${medicationName} 10 mg 10片/盒`) }).click()
    await page.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await page.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    await expect(page.getByRole('button', { name: '正式开具处方', exact: true })).toBeEnabled()
    await forEachAppearance(page, async locale => {
      await page.getByRole('tab', { name: locale === 'zh-CN' ? '诊断' : 'Diagnosis', exact: true }).click()
      const diagnosisCatalog = page.locator('[data-agent-catalog="diagnosis"]')
      await expect(diagnosisCatalog.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索疾病目录' : 'Search diagnosis catalog' })).toBeVisible()
      const note = page.getByRole('textbox', { name: locale === 'zh-CN' ? '诊断备注' : 'Diagnosis note', exact: true })
      await expect(note).toHaveValue('长中文合成备注，验证字号与容器缩放时编辑内容不会丢失。'.repeat(10))
      await scrollWithinPanel(note)
      await expect(note).toBeInViewport()
      const confirm = page.getByRole('button', { name: locale === 'zh-CN' ? '确认诊断' : 'Confirm diagnoses', exact: true })
      await scrollWithinPanel(confirm)
      await expect(confirm).toBeInViewport()
      await expectPanelBounded(page, 'diagnosis')

      await page.getByRole('tab', { name: locale === 'zh-CN' ? '处方' : 'Prescription', exact: true }).click()
      const medicationCatalog = page.locator('[data-agent-catalog="medication"]')
      await expect(medicationCatalog.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索药品目录' : 'Search medication catalog' })).toBeVisible()
      const frequency = page.getByRole('textbox', { name: locale === 'zh-CN' ? '频次' : 'Frequency', exact: true })
      await scrollWithinPanel(frequency)
      await expect(frequency).toBeInViewport()
      const remove = page.getByRole('button', { name: locale === 'zh-CN' ? '移除药品' : 'Remove medication', exact: true })
      await scrollWithinPanel(remove)
      await expect(remove).toBeInViewport()
      const issue = page.getByRole('button', { name: locale === 'zh-CN' ? '正式开具处方' : 'Issue prescription', exact: true })
        .and(page.locator('[aria-haspopup="dialog"]'))
      await scrollWithinPanel(issue)
      await expect(issue).toBeInViewport()
      await expectPanelBounded(page, 'prescription')
    })
    await expectNoFixtureErrors(page)
  })

  test(`preserves confirmed lists, read-only medication details and dialog focus across narrow appearances on React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    await mount(page, version, 'existing')
    await forEachAppearance(page, async (locale, width) => {
      await page.getByRole('tab', { name: locale === 'zh-CN' ? '诊断' : 'Diagnosis', exact: true }).click()
      const diagnosisList = page.getByRole('region', { name: locale === 'zh-CN' ? '诊断列表' : 'Diagnosis list', exact: true })
      const backToDiagnoses = page.getByRole('button', { name: locale === 'zh-CN' ? '返回诊断列表' : 'Back to diagnosis list', exact: true })
      if (width === 390 && await backToDiagnoses.isVisible()) await backToDiagnoses.click()
      await expect(diagnosisList).toBeVisible()
      await diagnosisList.getByRole('button', { name: new RegExp(diagnosisName) }).click()
      const diagnosisDetails = page.getByRole('region', { name: locale === 'zh-CN' ? '诊断详情' : 'Diagnosis details', exact: true })
      await expect(diagnosisDetails).toBeVisible()
      await expectTextFits(diagnosisDetails.getByRole('heading', { name: diagnosisName, exact: true }))
      const note = diagnosisDetails.getByRole('textbox', { name: locale === 'zh-CN' ? '诊断备注' : 'Diagnosis note', exact: true })
      await scrollWithinPanel(note)
      await expect(note).toBeInViewport()
      await expect(note).toHaveValue('合成临床备注，长中文文字与多个检查依据应完整展示。'.repeat(8))
      if (width === 390) {
        await backToDiagnoses.click()
        await expect(diagnosisList.getByRole('textbox')).toBeFocused()
      }
      await expectPanelBounded(page, 'diagnosis')
      const add = page.getByRole('button', { name: locale === 'zh-CN' ? '添加诊断' : 'Add diagnosis', exact: true })
      await add.click()
      const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '添加诊断' : 'Add diagnosis', exact: true })
      await expect(dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索疾病目录' : 'Search diagnosis catalog' })).toBeVisible()
      expect(await page.evaluate(() => document.querySelector('[role="dialog"]') === null)).toBe(true)
      const dialogBounds = await dialog.evaluate(element => ({
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scrollWidth: element.scrollWidth,
      }))
      expect(dialogBounds.left).toBeGreaterThanOrEqual(0)
      expect(dialogBounds.right).toBeLessThanOrEqual(width)
      expect(dialogBounds.scrollWidth).toBeLessThanOrEqual(dialogBounds.width + 1)
      const done = dialog.getByRole('button', { name: locale === 'zh-CN' ? '完成选择' : 'Done selecting', exact: true })
      await expect(done).toBeInViewport()
      await done.click()
      await expect(add).toBeFocused()

      await page.getByRole('tab', { name: locale === 'zh-CN' ? '处方' : 'Prescription', exact: true }).click()
      const medicationList = page.getByRole('region', { name: locale === 'zh-CN' ? '药品列表' : 'Medication list', exact: true })
      const backToMedications = page.getByRole('button', { name: locale === 'zh-CN' ? '返回药品列表' : 'Back to medication list', exact: true })
      if (width === 390 && await backToMedications.isVisible()) await backToMedications.click()
      await expect(medicationList).toBeVisible()
      await medicationList.getByRole('button', { name: `${locale === 'zh-CN' ? '查看药品' : 'View medication'} ${medicationName}`, exact: true }).click()
      const medicationDetails = page.getByRole('region', { name: locale === 'zh-CN' ? '药品详情' : 'Medication details', exact: true })
      await expectTextFits(medicationDetails.getByRole('heading', { name: medicationName, exact: true }))
      await expect(medicationDetails.getByRole('textbox')).toHaveCount(0)
      const instructions = medicationDetails.getByText(locale === 'zh-CN'
        ? '用药明细属于同一张处方，开具与撤回作用于整张处方。'
        : 'Medication orders belong to one prescription. Issuance and withdrawal apply to the entire prescription.', { exact: true })
      await scrollWithinPanel(instructions)
      await expect(instructions).toBeInViewport()
      if (width === 390) {
        await backToMedications.click()
        await expect(medicationList.getByRole('textbox')).toBeFocused()
      }
      await expectPanelBounded(page, 'prescription')
    })
    await appearance(page, 'zh-CN', 'light', 'standard', 390)
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    const add = page.getByRole('button', { name: '添加诊断', exact: true })
    await add.click()
    const dialog = page.getByRole('dialog', { name: '添加诊断', exact: true })
    await expect(dialog.getByRole('textbox', { name: '搜索疾病目录' })).toBeVisible()
    await dialog.getByRole('button', { name: '选择 合成追加诊断 SYN-D3', exact: true }).click()
    await dialog.getByRole('textbox', { name: '诊断备注 3', exact: true }).fill('弹窗中编辑的合成备注。')
    await dialog.getByRole('button', { name: '完成选择', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(add).toBeFocused()
    await expect(page.getByRole('textbox', { name: '诊断备注 3', exact: true })).toHaveValue('弹窗中编辑的合成备注。')
    await expectNoFixtureErrors(page)
  })
}
