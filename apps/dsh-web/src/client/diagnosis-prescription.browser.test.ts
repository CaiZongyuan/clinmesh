import { openWorkspaceTab } from '../../../web/e2e/workspace-tabs.fixture.ts'
import { doctorRecommendationStateSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { z } from 'zod'
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
async function mount(page: Page, version: string, mode: 'polish' | 'empty' | 'existing' | 'recommendations' | 'failed' | 'recovery' | 'retry-disabled' | 'catalog-split', multiple = false) {
  const { script, styles } = await buildFixture(version)
  // 宿主为 1440（容纳三栏建议栈后保持开单/检查双栏合同），视口需一致，否则文档出现横向滚动。
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto('http://localhost/')
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html data-fixture-mode="${mode}" data-fixture-multiple="${multiple}"><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
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
  const diagnosis = page.getByRole('tab', { name: locale === 'zh-CN' ? '诊断' : 'Diagnosis', exact: true, includeHidden: true })
  // 属性先于 transition-all 的字号过渡生效；实际字体到位后再点击页签。
  await expect(diagnosis)
    .toHaveCSS('font-size', { standard: '14px', larger: '15.75px', large: '17.5px' }[fontSize])
  // 等待 ResizeObserver 用最终宽度收纳页签，再从「更多」菜单选中目标入口。
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  if (!await diagnosis.isVisible()) { await page.getByRole('button', { name: locale === 'zh-CN' ? '更多' : 'More', exact: true }).click(); await page.getByRole('menuitem').filter({ has: page.getByText(locale === 'zh-CN' ? '诊断' : 'Diagnosis', { exact: true }) }).click() }
  await expect(diagnosis).toBeVisible()
}
async function selectCaseSection(page: Page, locale: 'zh-CN' | 'en-US', section: 'diagnosis' | 'prescription') {
  const name = section === 'diagnosis' ? locale === 'zh-CN' ? '诊断' : 'Diagnosis' : locale === 'zh-CN' ? '处方' : 'Prescription'
  const tab = page.getByRole('tab', { name, exact: true })
  if (!await tab.isVisible()) { await page.getByRole('button', { name: locale === 'zh-CN' ? '更多' : 'More', exact: true }).click(); await page.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click() }
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
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

for (const version of ['18', '19']) test.describe(`visit number on React ${version}`, () => {
  test.beforeAll(async () => { await buildFixture(version) })
  test(`reads and copies the complete visit number in the narrow shared Surface on React ${version}`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await mount(page, version, 'empty')
    const banner = page.getByRole('region', { name: '当前患者', exact: true })
    const value = banner.locator('[data-registration-number-value]')
    await expect(value).toHaveText('CM-OP-20261020-1234567')
    await expect(banner).not.toContainText('SYNTHETIC-1')
    for (const locale of ['zh-CN', 'en-US'] as const) for (const fontSize of ['standard', 'large'] as const) {
      await appearance(page, locale, 'light', fontSize, 390)
      const current = page.getByRole('region', { name: locale === 'zh-CN' ? '当前患者' : 'Current patient', exact: true })
      await expectTextFits(current.locator('[data-registration-number-value]'))
      await expect(current).toContainText(locale === 'zh-CN' ? '主诉：合成主诉' : 'Chief complaint：合成主诉')
      const bounds = await current.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
      await current.getByRole('button', { name: `${locale === 'zh-CN' ? '复制门诊号' : 'Copy visit number'} CM-OP-20261020-1234567`, exact: true }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('CM-OP-20261020-1234567')
    }
    await expectNoFixtureErrors(page)
  })
})

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

async function expectWorkspaceColumns(page: Page, hasRecords: boolean) {
  const workspace = page.locator('[data-doctor-order-workspace]:visible')
  await expect(workspace).toHaveAttribute('data-has-records', String(hasRecords))
  const bounds = await workspace.evaluate(element => {
    const entry = element.querySelector('[data-order-entry]')!.getBoundingClientRect()
    const pending = element.querySelector('[data-order-pending]')!.getBoundingClientRect()
    const records = element.querySelector('[data-order-records]')?.getBoundingClientRect()
    return { entryWidth: entry.width, pendingWidth: pending.width, recordsWidth: records?.width ?? 0,
      entryBottom: entry.bottom, pendingTop: pending.top, recordsTop: records?.top ?? 0 }
  })
  if (hasRecords) expect(bounds.recordsWidth).toBeGreaterThan(0)
  else expect(bounds.pendingWidth).toBeGreaterThan(0)
  if (bounds.entryWidth > 0 && bounds.pendingWidth > 1) expect(bounds.pendingTop).toBeGreaterThanOrEqual(bounds.entryBottom - 1)
}

for (const version of ['18', '19']) test.describe(`diagnosis and prescription on React ${version}`, () => {
  test.describe.configure({ mode: 'default' })
  test.beforeAll(async () => { await buildFixture(version) })

  test(`settles tab typography before clicking after a narrow-to-wide appearance change on React ${version}`, async ({ page }) => {
    await mount(page, version, 'empty')
    await appearance(page, 'zh-CN', 'light', 'standard', 390)
    const tab = page.getByRole('tab', { name: '诊断', exact: true })
    // 拉开真实 CSS 字号过渡，确定性覆盖属性已更新而点击目标仍在移动的窗口。
    await tab.evaluate(element => { element.style.transitionDuration = '1s' })
    await appearance(page, 'zh-CN', 'light', 'larger', 1280)
    expect(await tab.evaluate(element => getComputedStyle(element).fontSize)).toBe('15.75px')
    await selectCaseSection(page, 'zh-CN', 'diagnosis')
    await expect(page.getByRole('region', { name: '填写诊断', exact: true })).toBeVisible()
    await expectNoFixtureErrors(page)
  })

  test(`continues a retry-disabled pending task on React ${version}`, async ({ page }) => {
    await mount(page, version, 'retry-disabled')
    await openWorkspaceTab(page, '诊断')
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    expect(await readRecommendations(page, 'diagnosis')).toMatchObject({ status: 'pending', generation: 1, recovery: { canContinue: true } })
    await expect(panel.getByRole('button', { name: '继续原任务', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: '继续原任务', exact: true }).click()
    await expect(panel.getByText(/助手暂未完成本轮建议准备，不影响手动开具与接诊/)).toBeVisible()
    expect(await readRecommendations(page, 'diagnosis')).toMatchObject({ generation: 1, recovery: { status: 'exhausted', canContinue: false } })
    await expectNoFixtureErrors(page)
  })
  test(`continues the original task and regenerates after exhaustion on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recovery')
    await openWorkspaceTab(page, '诊断')
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    await expect(panel.getByText(/上次请求结果未知/)).toBeVisible()
    await panel.getByRole('button', { name: '依据与说明', exact: true }).click()
    const details = page.getByRole('dialog', { name: '依据与说明', exact: true })
    await expect(details.getByText(/上次请求结果未知/)).toBeVisible()
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    await panel.getByRole('button', { name: '继续原任务', exact: true }).click()
    await expect(panel.getByText(/助手暂未完成本轮建议准备，不影响手动开具与接诊/)).toBeVisible()
    expect(await readRecommendations(page, 'diagnosis')).toMatchObject({ generation: 1, recovery: { status: 'exhausted' } })
    await expect(panel.getByRole('button', { name: '继续原任务', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    expect(await readRecommendations(page, 'diagnosis')).toMatchObject({ generation: 2, recovery: { status: 'completed' } })
    await expectNoFixtureErrors(page)
  })
  test(`shows both AI medications as issued records and selects the second detail on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations', true)
    await openWorkspaceTab(page, '处方')
    await expectWorkspaceColumns(page, false)
    const panel = page.getByRole('region', { name: '待开具处方', exact: true })
    await expect(panel.getByRole('checkbox')).toHaveCount(2)
    await expect(panel.getByRole('checkbox').nth(0)).toBeChecked()
    await expect(panel.getByRole('checkbox').nth(1)).toBeChecked()
    expect((await readCase(page)).medicationConclusion?.prescription).toBeUndefined()
    await panel.getByRole('button', { name: /^开具处方/ }).click()
    await expect.poll(async () => (await readCase(page)).medicationConclusion?.prescription?.items.length).toBe(2)
    await expectWorkspaceColumns(page, true)
    const list = page.getByRole('region', { name: '药品列表', exact: true })
    await expect(list.getByRole('row')).toHaveCount(3)
    await expect(list.getByRole('cell', { name: '合成第二药品', exact: true })).toBeVisible()
    await expect(list).toContainText('30片/盒')
    await expect(panel.getByRole('checkbox')).toHaveCount(0)
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(async () => (await readRecommendations(page, 'prescription')).generation).toBe(2)
    await expect(panel.getByRole('checkbox')).toHaveCount(0)
    await expectPanelBounded(page, 'prescription')
    await expectNoFixtureErrors(page)
  })
  test(`resurfaces a removed proposal with changed evidence without selecting it on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations')
    await appearance(page, 'zh-CN', 'light', 'large', 390)
    await openWorkspaceTab(page, '诊断')
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
    await openWorkspaceTab(page, '诊断')
    await expectWorkspaceColumns(page, false)
    await appearance(page, 'zh-CN', 'light', 'large', 390)
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
    await dialog.getByText('合成病例来源一', { exact: true }).click()
    await expect(dialog.getByText('合成病例第一条依据：仅验证来源展开与页面接线。', { exact: true })).toBeVisible()
    await dialog.getByText('合成病例来源二', { exact: true }).click()
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
    const remaining = panel.getByRole('checkbox', { name: '选择合成第二诊断', exact: true })
    await expect(remaining).toBeVisible()
    await expect(remaining).not.toBeChecked()
    await remaining.click()
    await expect(remaining).toBeChecked()
    // 三栏建议栈占位后，双栏开单合同需 ≥1312 宿主宽度。
    await appearance(page, 'zh-CN', 'light', 'standard', 1440)
    await expectWorkspaceColumns(page, true)
    await expectNoFixtureErrors(page)
  })

  test(`requires explicit missing prescription fields and preserves manual edits through refresh and failure on React ${version}`, async ({ page }) => {
    await mount(page, version, 'recommendations')
    await appearance(page, 'zh-CN', 'dark', 'large', 390)
    await openWorkspaceTab(page, '处方')
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
    await expect.poll(async () => (await readCase(page)).medicationConclusion?.draft).toEqual({
      items: [{ catalogItemId: 'synthetic-product-1', doseText: '10 mg', frequencyCode: 'QD', courseDays: 7, quantity: 2 }],
    })
    expect((await readCase(page)).medicationConclusion?.prescription).toBeUndefined()
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

  test(`discards unconfirmed catalog and editor inputs after cancelling the composer on React ${version}`, async ({ page }) => {
    await mount(page, version, 'empty')
    await openWorkspaceTab(page, '诊断')
    const addDiagnosis = page.getByRole('button', { name: '添加诊断', exact: true })
    await addDiagnosis.click()
    const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
    const diagnosisSearch = diagnosisDialog.getByRole('textbox', { name: '搜索疾病目录', exact: true })
    await diagnosisSearch.fill('第二')
    await diagnosisSearch.press('Enter')
    await diagnosisDialog.getByRole('button', { name: '选择 合成第二诊断 SYN-D2', exact: true }).click()
    await expect(diagnosisDialog.getByRole('heading', { name: '合成第二诊断', exact: true })).toBeVisible()
    await diagnosisDialog.getByRole('textbox', { name: '诊断备注', exact: true }).fill('弹窗中填写后取消的合成备注。')
    await diagnosisDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(diagnosisDialog).toHaveCount(0)
    await expect(addDiagnosis).toBeFocused()
    // 未确认关闭即弃置：页签列表不出现条目，草稿不落库，重开弹窗回到空搜索。
    await expect(page.getByRole('region', { name: '待确认诊断', exact: true }).getByRole('button', { name: /^编辑诊断 / })).toHaveCount(0)
    expect((await readCase(page)).diagnosis?.draft).toBeUndefined()
    await addDiagnosis.click()
    await expect(diagnosisDialog.getByRole('textbox', { name: '搜索疾病目录', exact: true })).toHaveValue('')
    await diagnosisDialog.getByRole('button', { name: '取消', exact: true }).click()
    await openWorkspaceTab(page, '处方')
    const addMedication = page.getByRole('button', { name: '添加药品', exact: true })
    await addMedication.click()
    const medicationDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await medicationDialog.getByRole('button', { name: '切换至国家参考目录', exact: true }).click()
    const medicationSearch = medicationDialog.getByRole('textbox', { name: '搜索药品目录', exact: true })
    await medicationSearch.fill('第二')
    await medicationSearch.press('Enter')
    await medicationDialog.getByRole('button', { name: /^选择 合成第二药品/ }).click()
    await medicationDialog.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await medicationDialog.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    await medicationDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(medicationDialog).toHaveCount(0)
    await expect(addMedication).toBeFocused()
    await expect(page.getByRole('region', { name: '待开具处方', exact: true }).getByRole('button', { name: /^编辑药品 / })).toHaveCount(0)
    expect((await readCase(page)).medicationConclusion?.draft).toBeUndefined()
    await expectNoFixtureErrors(page)
  })

  test(`keeps all queue tab text inside equal buttons with two-digit counts on React ${version}`, async ({ page }) => {
    await mount(page, version, 'polish')
    for (const width of [1101, 826]) for (const theme of ['light', 'dark'] as const) {
      await appearance(page, 'zh-CN', theme, 'standard', width)
      const nav = page.getByRole('tablist', { name: '门诊诊疗', exact: true })
      for (const label of ['在诊', '待诊', '完诊']) await expect(nav.getByRole('tab', { name: label, exact: true })).toContainText('12')
      const bounds = await nav.getByRole('tab').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const text: Array<{ left: number; right: number; top: number; bottom: number }> = []
        let node
        while ((node = walker.nextNode())) if (node.textContent?.trim()) {
          const range = document.createRange(); range.selectNodeContents(node)
          const rect = range.getBoundingClientRect(); text.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
        }
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, text }
      }))
      expect(Math.max(...bounds.map(item => item.width)) - Math.min(...bounds.map(item => item.width))).toBeLessThanOrEqual(1)
      for (const tab of bounds) for (const text of tab.text) {
        expect(text.left).toBeGreaterThanOrEqual(tab.left - 1); expect(text.right).toBeLessThanOrEqual(tab.right + 1)
        expect(text.top).toBeGreaterThanOrEqual(tab.top - 1); expect(text.bottom).toBeLessThanOrEqual(tab.bottom + 1)
      }
    }
  })

  test(`keeps multi-line pathology and imaging candidate text and unavailability reasons inside each row on React ${version}`, async ({ page }) => {
    await mount(page, version, 'polish')
    for (const width of [1101, 826]) {
      await appearance(page, 'zh-CN', 'light', 'standard', width)
      await openWorkspaceTab(page, '检验检查')
      await page.getByRole('tab', { name: /^病理会诊 \d+$/ }).click()
      await page.getByRole('button', { name: '添加病理会诊', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '选择病理会诊', exact: true })
      const rows = dialog.locator('[data-order-catalog] ul > li')
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(1).getByRole('button')).toBeDisabled()
      await expect(rows.nth(1).getByText('本院当前未开展', { exact: true })).toBeVisible()
      await expect(rows.nth(1)).toContainText('无可送检的既往手术')
      const bounds = await rows.getByRole('button').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const text: Array<{ top: number; bottom: number }> = []
        let node
        while ((node = walker.nextNode())) if (node.textContent?.trim()) {
          const range = document.createRange(); range.selectNodeContents(node)
          const rect = range.getBoundingClientRect(); text.push({ top: rect.top, bottom: rect.bottom })
        }
        return { top: box.top, bottom: box.bottom, text }
      }))
      for (const button of bounds) for (const text of button.text) {
        expect(text.top).toBeGreaterThanOrEqual(button.top - 1)
        expect(text.bottom).toBeLessThanOrEqual(button.bottom + 1)
      }
      expect(bounds[0]!.bottom).toBeLessThanOrEqual(bounds[1]!.top)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await page.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
      await page.getByRole('button', { name: '添加放射检查', exact: true }).click()
      const imaging = page.getByRole('dialog', { name: '选择放射检查', exact: true })
      const unavailable = imaging.getByRole('button', { name: /合成非常长的冠状动脉/ })
      await expect(unavailable).toBeDisabled()
      expect(await unavailable.evaluate(button => {
        const box = button.getBoundingClientRect(), walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
        const reason = '本院当前未开展'
        let node
        while ((node = walker.nextNode())) {
          const start = node.textContent?.indexOf(reason) ?? -1
          if (start < 0) continue
          const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + reason.length)
          const rect = range.getBoundingClientRect()
          return rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
        }
        return false
      })).toBe(true)
      await imaging.getByRole('button', { name: '取消', exact: true }).click()
    }
  })

  test(`explains the missing indication and distinguishes an unavailable action on React ${version}`, async ({ page }) => {
    await mount(page, version, 'polish')
    await appearance(page, 'zh-CN', 'light', 'standard', 826)
    await openWorkspaceTab(page, '检验检查')
    await page.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
    await page.getByRole('button', { name: '添加放射检查', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择放射检查', exact: true })
    await dialog.locator('[data-order-catalog]').getByRole('button', { name: /^胸部 CT/ }).click()
    const action = dialog.getByRole('button', { name: '加入放射检查', exact: true })
    await expect(action).toBeDisabled()
    await expect(action).toHaveCSS('border-style', 'dashed')
    await expect(dialog.getByRole('status')).toContainText('还差：检查指征')
    if (version === '19') await dialog.screenshot({ path: test.info().outputPath('selected-missing-indication.png'), animations: 'disabled' })
    const indication = dialog.getByRole('textbox', { name: '检查指征', exact: true })
    await indication.fill('合成持续咳嗽，核对胸部病变。')
    await expect(action).toBeEnabled()
    await expect(action).toHaveCSS('border-style', 'solid')
    await indication.fill('   ')
    await expect(action).toBeDisabled()
    await expect(action).toHaveCSS('border-style', 'dashed')
    await expect(dialog.getByRole('status')).toContainText('还差：检查指征')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('tab', { name: /^病理会诊 \d+$/ }).click()
    await page.getByRole('button', { name: '添加病理会诊', exact: true }).click()
    const pathology = page.getByRole('dialog', { name: '选择病理会诊', exact: true })
    await pathology.locator('[data-order-catalog]').getByRole('button', { name: /乳腺切片病理会诊/ }).click()
    const consultation = pathology.getByRole('button', { name: '加入病理会诊', exact: true })
    await expect(consultation).toBeDisabled()
    await expect(consultation).toHaveCSS('border-style', 'dashed')
    await expect(pathology.locator('[data-slot="dialog-footer"]').getByRole('status')).toContainText('会诊目的')
    await pathology.getByRole('textbox', { name: '会诊目的', exact: true }).fill('合成既往乳腺手术病理切片会诊。')
    await expect(consultation).toBeEnabled()
    await pathology.getByRole('button', { name: '取消', exact: true }).click()
  })

  test(`names the missing medication fields before enabling the composer action on React ${version}`, async ({ page }) => {
    await mount(page, version, 'polish')
    await appearance(page, 'zh-CN', 'dark', 'standard', 826)
    await openWorkspaceTab(page, '处方')
    await page.getByRole('button', { name: '添加药品', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await dialog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
    await dialog.locator('[data-order-catalog]').getByRole('button', { name: /^选择 / }).first().click()
    const action = dialog.getByRole('button', { name: '加入处方', exact: true })
    const hint = dialog.locator('[data-slot="dialog-footer"]').getByRole('status')
    await expect(action).toBeDisabled()
    await expect(action).toHaveCSS('border-style', 'dashed')
    await expect(hint).toContainText('剂量')
    await expect(hint).toContainText('频次')
    if (version === '19') await dialog.screenshot({ path: test.info().outputPath('selected-missing-medication-fields.png'), animations: 'disabled' })
    await dialog.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await dialog.getByRole('textbox', { name: '频次', exact: true }).fill('每晚一次')
    await expect(action).toBeEnabled()
    const quantity = dialog.getByRole('spinbutton', { name: '数量', exact: true })
    await quantity.fill('')
    await expect(action).toBeDisabled()
    await expect(hint).toContainText('数量')
    await quantity.fill('3')
    await expect(action).toBeEnabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  })

  test(`matches the two-column order dialogs at both Surface widths and themes on React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    await mount(page, version, 'polish')
    for (const width of [1101, 826]) for (const theme of ['light', 'dark'] as const) {
      await appearance(page, 'zh-CN', theme, 'standard', width)
      for (const item of [
        { section: '诊断', trigger: '添加诊断', title: '选择诊断', button: '加入诊断', density: 12 },
        { section: '处方', trigger: '添加药品', title: '选择药品', button: '加入处方', density: 0 },
        { section: '检验检查', trigger: '添加检验', title: '选择检验项目', button: '加入检验', density: 11 },
        { section: '检验检查', trigger: '添加放射检查', title: '选择放射检查', button: '加入放射检查', density: 0 },
        { section: '检验检查', trigger: '添加病理会诊', title: '选择病理会诊', button: '加入病理会诊', density: 0 },
      ]) {
        await openWorkspaceTab(page, item.section)
        if (item.trigger === '添加检验') await page.getByRole('tab', { name: /^检验 \d+$/ }).click()
        if (item.trigger === '添加放射检查') await page.getByRole('tab', { name: /^放射检查 \d+$/ }).click()
        if (item.trigger === '添加病理会诊') await page.getByRole('tab', { name: /^病理会诊 \d+$/ }).click()
        await page.getByRole('button', { name: item.trigger, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: item.title, exact: true })
        const catalog = dialog.locator('[data-order-catalog]')
        const searchInset = await catalog.getByRole('textbox').first().evaluate(input => {
          const field = input.getBoundingClientRect(), pane = input.closest('[data-order-catalog]')!.getBoundingClientRect()
          return { left: field.left - pane.left, top: field.top - pane.top }
        })
        expect(searchInset.left).toBeGreaterThanOrEqual(8)
        expect(searchInset.top).toBeGreaterThanOrEqual(8)
        const [left, right] = await dialog.evaluate(element => ['[data-order-catalog]', '[data-order-details]'].map(selector => {
          const box = element.querySelector(selector)!.getBoundingClientRect()
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        }))
        expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1)
        expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(1)
        expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        const action = dialog.getByRole('button', { name: item.button, exact: true })
        await expect(action).toBeDisabled(); await expect(action).toHaveCSS('border-style', 'dashed')
        await expect(dialog.getByText('请先从左侧选择项目', { exact: true })).toBeVisible()
        if (width === 1101 && item.density > 0) {
          const rows = catalog.locator('ul > li'); await expect(rows.first()).toBeVisible()
          const visible = await rows.evaluateAll(elements => elements.filter(element => {
            const row = element.getBoundingClientRect()
            let parent = element.parentElement
            while (parent) {
              if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(parent).overflowY)) {
                const box = parent.getBoundingClientRect()
                if (row.top < box.top - 1 || row.bottom > box.bottom + 1) return false
              }
              parent = parent.parentElement
            }
            return true
          }).length)
          expect(visible).toBeGreaterThanOrEqual(item.density)
        }
        await page.screenshot({ path: test.info().outputPath(`composer-${item.title}-${width}-${theme}.png`), animations: 'disabled' })
        const details = dialog.locator('[data-order-details]')
        let lastField: Locator
        if (item.title === '选择诊断') {
          await catalog.getByRole('button', { name: /^选择 / }).first().click()
          lastField = details.getByRole('textbox', { name: '诊断备注', exact: true })
          await lastField.fill('合成诊断备注，用于核对两栏表单的末尾字段。'.repeat(10))
        } else if (item.title === '选择药品') {
          await catalog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
          await catalog.getByRole('button', { name: /^选择 / }).first().click()
          await details.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
          await details.getByRole('textbox', { name: '频次', exact: true }).fill('每晚睡前一次')
          lastField = details.getByRole('spinbutton', { name: '数量', exact: true })
          await lastField.fill('3')
        } else if (item.title === '选择检验项目') {
          await catalog.getByRole('button', { name: /^选择 / }).first().click()
          lastField = details.locator('#laboratory-composer-indication')
        } else {
          await catalog.getByRole('button', { name: item.title === '选择放射检查' ? /^胸部 CT/ : /乳腺切片病理会诊/ }).click()
          lastField = details.getByRole('textbox', { name: item.title === '选择放射检查' ? '检查指征' : '会诊目的', exact: true })
          await lastField.fill('合成检查目的，核对既往病史和本次诊疗问题。'.repeat(10))
        }
        await expect(catalog.getByRole('button', { pressed: true })).toHaveCount(1)
        await expect(action).toBeEnabled()
        await details.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(lastField).toBeVisible()
        const reachable = await lastField.evaluate(element => {
          const box = element.getBoundingClientRect(), pane = element.closest('[data-order-details]')!.getBoundingClientRect()
          return box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1 && box.left >= pane.left - 1 && box.right <= pane.right + 1
        })
        expect(reachable).toBe(true)
        await page.screenshot({ path: test.info().outputPath(`composer-${item.title}-${width}-${theme}-selected.png`), animations: 'disabled' })
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
      }
    }
    await expectNoFixtureErrors(page)
  })

  test(`renders composer catalog row names with nonzero width at both breakpoints on React ${version}`, async ({ page }) => {
    // 回归合同：目录行截断段不得因尺寸包含塌缩为 0 宽（2026-10 批次 6 曾让三页签目录项目名全部不可见）。
    await mount(page, version, 'empty')
    for (const width of [1280, 390]) {
      await test.step(`viewport ${width}`, async () => {
        await appearance(page, 'zh-CN', 'light', 'standard', width)
        await openWorkspaceTab(page, '诊断')
        await page.getByRole('button', { name: '添加诊断', exact: true }).click()
        const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
        const diagnosisNames = diagnosisDialog.locator('[data-agent-catalog="diagnosis"] ul li strong')
        await expect(diagnosisNames.first()).toBeVisible()
        for (let index = 0; index < await diagnosisNames.count(); index += 1) {
          expect(await diagnosisNames.nth(index).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
        }
        await diagnosisDialog.getByRole('button', { name: '取消', exact: true }).click()
        await expect(diagnosisDialog).toHaveCount(0)
        await openWorkspaceTab(page, '检验检查')
        await page.getByRole('button', { name: '添加检验', exact: true }).click()
        const laboratoryDialog = page.getByRole('dialog', { name: '选择检验项目', exact: true })
        const laboratoryNames = laboratoryDialog.locator('[data-agent-catalog="laboratory"] ul li strong')
        await expect(laboratoryNames.first()).toBeVisible()
        for (let index = 0; index < await laboratoryNames.count(); index += 1) {
          expect(await laboratoryNames.nth(index).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
        }
        await laboratoryDialog.getByRole('button', { name: '取消', exact: true }).click()
        await expect(laboratoryDialog).toHaveCount(0)
        await openWorkspaceTab(page, '处方')
        await page.getByRole('button', { name: '添加药品', exact: true }).click()
        const medicationDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
        await medicationDialog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
        const medicationNames = medicationDialog.locator('[data-agent-medication-name]')
        await expect(medicationNames.first()).toBeVisible()
        for (let index = 0; index < await medicationNames.count(); index += 1) {
          expect(await medicationNames.nth(index).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
        }
        await medicationDialog.getByRole('button', { name: '取消', exact: true }).click()
        await expect(medicationDialog).toHaveCount(0)
      })
    }
    await expectNoFixtureErrors(page)
  })

  test(`keeps long diagnosis edits within the viewport and focuses confirmed details on React ${version}`, async ({ page }) => {
    await mount(page, version, 'existing')
    await appearance(page, 'zh-CN', 'light', 'standard', 390)
    await openWorkspaceTab(page, '诊断')
    await page.getByRole('button', { name: '修改已确认诊断', exact: true }).click()
    const panel = page.getByRole('region', { name: '待确认诊断', exact: true })
    await panel.getByRole('button', { name: `编辑诊断 ${diagnosisName}` }).click()
    const dialog = page.getByRole('dialog', { name: '编辑诊断', exact: true })
    const note = dialog.getByRole('textbox', { name: '诊断备注', exact: true })
    await expect(note).toHaveValue('合成临床备注，长中文文字与多个检查依据应完整展示。'.repeat(8))
    await note.fill('x\n'.repeat(250))
    const bounds = await dialog.evaluate(element => ({
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
      width: element.clientWidth, scrollWidth: element.scrollWidth,
    }))
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(390)
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const openPendingDiagnosis = panel.getByRole('button', { name: `查看待开具 ${diagnosisName}`, exact: true })
    await openPendingDiagnosis.click()
    const edit = page.getByRole('region', { name: '待开具项目详情', exact: true })
    await expect(edit.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('x\n'.repeat(250).trim())
    expect(await edit.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
    const list = page.getByRole('region', { name: '诊断列表', exact: true })
    await expect(list.getByRole('cell', { name: diagnosisName, exact: true })).toBeVisible()
    // 资料刷新会把“调整”改为“核对”，通过稳定的条目入口重开详情。
    await page.evaluate(() => window.dispatchEvent(new Event('diagnosis-prescription-change-evidence')))
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByRole('button', { name: '核对', exact: true }).first()).toBeVisible()
    await openPendingDiagnosis.click()
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await expect(panel.getByRole('button', { name: /^确认选中诊断/ })).toHaveCount(0)
    await expect(edit.getByRole('button', { name: /^确认选中诊断/ })).toHaveCount(1)
    await edit.getByRole('button', { name: /^确认选中诊断/ }).click()
    await expect.poll(async () => (await readCase(page)).diagnosis?.confirmation?.revisionNumber).toBe(2)
    expect((await readCase(page)).diagnosis?.confirmation?.entries[0]?.note).toBe('x\n'.repeat(250).trim())
    await expect(list).toContainText('x\n'.repeat(250).trim())
    await expect(list.getByRole('cell', { name: '合成第二诊断', exact: true })).toBeVisible()
    await expectNoFixtureErrors(page)
  })

  test(`adds manual diagnoses and products through one list while Agent preparation is failed on React ${version}`, async ({ page }) => {
    await mount(page, version, 'failed')
    await appearance(page, 'zh-CN', 'light', 'large', 390)
    await openWorkspaceTab(page, '诊断')
    expect((await readRecommendations(page, 'diagnosis')).status).toBe('failed')
    await page.getByRole('button', { name: '添加诊断', exact: true }).click()
    const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
    await diagnosisDialog.getByRole('button', { name: `选择 ${diagnosisName} SYN-D1`, exact: true }).click()
    await diagnosisDialog.getByRole('textbox', { name: '诊断备注', exact: true }).fill('手动添加后的合成备注。')
    await diagnosisDialog.getByRole('button', { name: '加入诊断', exact: true }).click()
    await expect(diagnosisDialog).toHaveCount(0)
    const diagnoses = page.getByRole('region', { name: '待确认诊断', exact: true })
    await expect(diagnoses.getByRole('button', { name: `编辑诊断 ${diagnosisName}` })).toBeVisible()
    await expect(diagnoses.getByRole('checkbox')).toHaveCount(1)
    await diagnoses.getByRole('button', { name: '调整', exact: true }).click()
    // 无已确认记录时缺少详情宿主，调整走「调整项目」弹窗而不是页内详情区。
    const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
    await expect(edit.getByRole('textbox', { name: '备注', exact: true })).toHaveValue('手动添加后的合成备注。')
    await edit.getByRole('textbox', { name: '备注', exact: true }).fill('统一清单更新后的合成备注。')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await diagnoses.getByRole('button', { name: `编辑诊断 ${diagnosisName}` }).click()
    const editDialog = page.getByRole('dialog', { name: '编辑诊断', exact: true })
    await expect(editDialog.getByRole('textbox', { name: '诊断备注', exact: true })).toHaveValue('统一清单更新后的合成备注。')
    await editDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: /^确认选中诊断/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '确认诊断', exact: true })).toHaveCount(0)
    await diagnoses.getByRole('button', { name: /^确认选中诊断/ }).click()
    await expect.poll(async () => (await readCase(page)).diagnosis?.confirmation?.entries[0]?.note).toBe('统一清单更新后的合成备注。')
    await page.getByRole('button', { name: '修改已确认诊断', exact: true }).click()
    await diagnoses.getByRole('button', { name: `编辑诊断 ${diagnosisName}` }).click()
    await editDialog.getByRole('textbox', { name: '诊断备注', exact: true }).fill('确认后更新的合成备注。')
    await editDialog.getByRole('button', { name: '保存修改', exact: true }).click()
    await diagnoses.getByRole('button', { name: /^确认选中诊断/ }).click()
    await expect.poll(async () => (await readCase(page)).diagnosis?.confirmation?.revisionNumber).toBe(2)
    await openWorkspaceTab(page, '处方')
    expect((await readRecommendations(page, 'prescription')).status).toBe('failed')
    await expect(page.getByRole('region', { name: '待开具处方', exact: true }).getByRole('status')).toHaveText('更新或提交未完成，草稿已保留。')
    await page.getByRole('button', { name: '添加药品', exact: true }).click()
    const medicationDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await medicationDialog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
    // 同一通用名按组展示，包装经行内「包装」下拉切换后再选择该行。
    const packaging = medicationDialog.getByRole('combobox', { name: new RegExp(`^包装 ${medicationName}`) })
    await packaging.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('option', { name: '20片/盒', exact: true }).click()
    await medicationDialog.getByRole('button', { name: new RegExp(`^选择 ${medicationName} 10 mg 20片/盒`) }).click()
    await medicationDialog.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await medicationDialog.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    await medicationDialog.getByRole('button', { name: '加入处方', exact: true }).click()
    await expect(medicationDialog).toHaveCount(0)
    const prescriptions = page.getByRole('region', { name: '待开具处方', exact: true })
    await expect(prescriptions.getByRole('button', { name: `编辑药品 ${medicationName}` })).toBeVisible()
    await expect(prescriptions.getByRole('checkbox')).toHaveCount(1)
    await prescriptions.getByRole('button', { name: '调整', exact: true }).click()
    await expect(edit.getByRole('textbox', { name: '每次剂量', exact: true })).toHaveValue('每次一片')
    await edit.getByRole('textbox', { name: '每次剂量', exact: true }).fill('每次两片')
    await edit.getByRole('spinbutton', { name: '疗程（天）', exact: true }).fill('7')
    await edit.getByRole('spinbutton', { name: '数量', exact: true }).fill('2')
    await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
    await prescriptions.getByRole('button', { name: `编辑药品 ${medicationName}` }).click()
    const editMedicationDialog = page.getByRole('dialog', { name: '编辑药品', exact: true })
    await expect(editMedicationDialog.getByRole('textbox', { name: '剂量', exact: true })).toHaveValue('每次两片')
    // 编辑表单头部以「厂家 · 规格 · 包装」整行呈现当前包装；目录分组行的包装选择器是行内局部状态，不回显已选包装。
    await expect(editMedicationDialog.getByText('合成制药有限公司与很长的生产企业名称 · 10 mg · 20片/盒', { exact: true })).toBeVisible()
    await editMedicationDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: /^开具处方（/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '正式开具处方', exact: true })).toHaveCount(0)
    await prescriptions.getByRole('button', { name: /^开具处方/ }).click()
    await expect.poll(async () => (await readCase(page)).medicationConclusion?.prescription?.items[0]?.catalogItemId).toBe('synthetic-product-2')
    expect((await readCase(page)).medicationConclusion?.prescription?.items[0]).toMatchObject({ doseText: '每次两片', courseDays: 7, quantity: 2,
      referenceProduct: { id: 'synthetic-product-2', packageDescription: '20片/盒' } })
    const medicationList = page.getByRole('region', { name: '药品列表', exact: true })
    await expect(medicationList.getByRole('cell', { name: medicationName, exact: true })).toBeVisible()
    await expect(medicationList).toContainText('20片/盒')
    await expectPanelBounded(page, 'prescription')
    await expectNoFixtureErrors(page)
  })

  test(`keeps composer catalogs, shared editors and the sole final action reachable in every appearance on React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    await mount(page, version, 'empty')
    await openWorkspaceTab(page, '诊断')
    await page.getByRole('button', { name: '添加诊断', exact: true }).click()
    const diagnosisDialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
    await diagnosisDialog.getByRole('button', { name: `选择 ${diagnosisName} SYN-D1`, exact: true }).click()
    await diagnosisDialog.getByRole('textbox', { name: '诊断备注', exact: true }).fill('长中文合成备注，验证字号与容器缩放时编辑内容不会丢失。'.repeat(10))
    await diagnosisDialog.getByRole('button', { name: '加入诊断', exact: true }).click()
    await expect(diagnosisDialog).toHaveCount(0)
    await expect(page.locator('[data-agent-section="diagnosis"]').getByText('草稿已自动保存', { exact: true })).toBeVisible()
    await openWorkspaceTab(page, '处方')
    await page.getByRole('button', { name: '添加药品', exact: true }).click()
    const medicationDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await medicationDialog.getByRole('tab', { name: '国家参考目录', exact: true }).click()
    await medicationDialog.getByRole('button', { name: new RegExp(`^选择 ${medicationName} 10 mg 10片/盒`) }).click()
    await medicationDialog.getByRole('textbox', { name: '剂量', exact: true }).fill('每次一片')
    await medicationDialog.getByRole('textbox', { name: '频次', exact: true }).fill('每日两次')
    await medicationDialog.getByRole('button', { name: '加入处方', exact: true }).click()
    await expect(page.locator('[data-agent-section="prescription"]').getByText('草稿已自动保存', { exact: true })).toBeVisible()
    await forEachAppearance(page, async (locale, width) => {
      const zh = locale === 'zh-CN'
      for (const section of ['diagnosis', 'prescription'] as const) {
        await selectCaseSection(page, locale, section)
        const pendingPanel = page.getByRole('region', { name: section === 'diagnosis' ? zh ? '待确认诊断' : 'Diagnoses to confirm' : zh ? '待开具处方' : 'Prescription to issue', exact: true })
        await pendingPanel.getByRole('button', { name: section === 'diagnosis'
          ? `${zh ? '编辑诊断' : 'Edit diagnosis'} ${diagnosisName}`
          : `${zh ? '编辑药品' : 'Edit medication'} ${medicationName}` }).click()
        const dialog = page.getByRole('dialog', { name: section === 'diagnosis' ? zh ? '编辑诊断' : 'Edit diagnosis' : zh ? '编辑药品' : 'Edit medication', exact: true })
        const search = dialog.getByRole('textbox', { name: section === 'diagnosis' ? zh ? '搜索疾病目录' : 'Search diagnosis catalog' : zh ? '搜索药品目录' : 'Search medication catalog' })
        await expect(search).toBeVisible()
        if (section === 'diagnosis') await expect(dialog.getByRole('textbox', { name: zh ? '诊断备注' : 'Diagnosis note', exact: true }))
          .toHaveValue('长中文合成备注，验证字号与容器缩放时编辑内容不会丢失。'.repeat(10))
        else await expect(dialog.getByRole('textbox', { name: zh ? '频次' : 'Frequency', exact: true })).toHaveValue('每日两次')
        const bounds = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
          left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
        expect(bounds.left).toBeGreaterThanOrEqual(0)
        expect(bounds.right).toBeLessThanOrEqual(width + 1)
        await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        const final = page.getByRole('button', { name: section === 'diagnosis' ? zh ? /^确认选中诊断/ : /^Confirm selected diagnoses/ : zh ? /^开具处方（/ : /^Issue prescription（/ })
        await expect(final).toHaveCount(1)
        await final.scrollIntoViewIfNeeded()
        await expect(final).toBeInViewport()
        await expectPanelBounded(page, section)
      }
    })
    await expectNoFixtureErrors(page)
  })

  test(`preserves confirmed lists, read-only medication details and catalog focus across narrow appearances on React ${version}`, async ({ page }) => {
    test.setTimeout(60_000)
    await mount(page, version, 'existing')
    await forEachAppearance(page, async (locale, width) => {
      await selectCaseSection(page, locale, 'diagnosis')
      const diagnosisList = page.getByRole('region', { name: locale === 'zh-CN' ? '诊断列表' : 'Diagnosis list', exact: true })
      await expect(diagnosisList).toBeVisible()
      await expect(diagnosisList.getByRole('cell', { name: diagnosisName, exact: true })).toBeVisible()
      const note = diagnosisList.getByRole('cell', { name: '合成临床备注，长中文文字与多个检查依据应完整展示。'.repeat(8), exact: true }).first()
      await note.scrollIntoViewIfNeeded()
      await expect(note).toBeInViewport()
      await expectPanelBounded(page, 'diagnosis')
      const add = page.getByRole('button', { name: locale === 'zh-CN' ? '添加诊断' : 'Add diagnosis', exact: true })
      await add.scrollIntoViewIfNeeded()
      await add.click()
      const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '选择诊断' : 'Select diagnosis', exact: true })
      await expect(dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索疾病目录' : 'Search diagnosis catalog' })).toBeVisible()
      expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      const dialogBounds = await dialog.evaluate(element => ({
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scrollWidth: element.scrollWidth,
      }))
      expect(dialogBounds.left).toBeGreaterThanOrEqual(0)
      expect(dialogBounds.right).toBeLessThanOrEqual(width)
      expect(dialogBounds.scrollWidth).toBeLessThanOrEqual(dialogBounds.width + 1)
      await dialog.getByRole('button', { name: locale === 'zh-CN' ? '取消' : 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(add).toBeFocused()

      await selectCaseSection(page, locale, 'prescription')
      const medicationList = page.getByRole('region', { name: locale === 'zh-CN' ? '药品列表' : 'Medication list', exact: true })
      await expect(medicationList).toBeVisible()
      await expect(medicationList.getByRole('cell', { name: medicationName, exact: true })).toBeVisible()
      await expect(medicationList).toContainText('20片/盒')
      await expectPanelBounded(page, 'prescription')
    })
    await appearance(page, 'zh-CN', 'light', 'standard', 390)
    await openWorkspaceTab(page, '诊断')
    await page.getByRole('button', { name: '添加诊断', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择诊断', exact: true })
    await dialog.getByRole('button', { name: '选择 合成追加诊断 SYN-D3', exact: true }).click()
    await dialog.getByRole('textbox', { name: '诊断备注', exact: true }).fill('弹窗中编辑的合成备注。')
    await dialog.getByRole('button', { name: '加入诊断', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '添加诊断', exact: true })).toBeFocused()
    const pending = page.getByRole('region', { name: '待确认诊断', exact: true })
    await pending.getByRole('button', { name: '编辑诊断 合成追加诊断', exact: true }).click()
    const editDialog = page.getByRole('dialog', { name: '编辑诊断', exact: true })
    await expect(editDialog.getByRole('textbox', { name: '诊断备注', exact: true })).toHaveValue('弹窗中编辑的合成备注。')
    await editDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(editDialog).toHaveCount(0)
    await expectNoFixtureErrors(page)
  })

  test(`returns to confirmed lists when the Surface is narrower than the viewport on React ${version}`, async ({ page }) => {
    await mount(page, version, 'existing')
    await appearance(page, 'zh-CN', 'dark', 'larger', 1280)
    // 宿主比视口窄且病例内容区窄于 760px（没有右栏后 1200px 宿主的内容区约 930px）。
    await page.evaluate(() => { document.getElementById('diagnosis-prescription-host')!.style.width = '1000px' })
    expect(page.viewportSize()?.width).toBe(1280)
    for (const kind of ['diagnosis', 'prescription'] as const) {
      const tab = page.getByRole('tab', { name: kind === 'diagnosis' ? '诊断' : '处方', exact: true })
      const list = page.getByRole('region', { name: kind === 'diagnosis' ? '诊断列表' : '药品列表', exact: true })
      await tab.click()
      await expect(list).toBeVisible()
      await expect(list.getByRole('cell', { name: kind === 'diagnosis' ? diagnosisName : medicationName, exact: true })).toBeVisible()
      await page.getByRole('tab', { name: kind === 'diagnosis' ? '处方' : '诊断', exact: true }).click()
      await tab.click()
      await expect(list).toBeVisible()
    }
  })

  test(`splits hospital pharmacy and national reference catalogs, blocks cross-source mixing, and renders specific prescription conflict reasons at 1101px and 826px on React ${version}`, async ({ page }) => {
    await mount(page, version, 'catalog-split')
    await openWorkspaceTab(page, '处方')
    await page.getByRole('button', { name: '添加药品', exact: true }).click()
    const firstDialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    await expect(firstDialog.getByRole('tab', { name: '本院药房', exact: true })).toHaveAttribute('aria-selected', 'true')
    const localCandidate = firstDialog.getByRole('button', { name: '选择 磷酸奥司他韦胶囊', exact: true })
    await expect(localCandidate.locator('[data-agent-medication-name]')).toHaveText('磷酸奥司他韦胶囊')
    await expect(localCandidate).toContainText('75 mg · 10粒/盒')
    await expect(localCandidate).toContainText('¥16.80')
    await localCandidate.click()
    await firstDialog.getByRole('button', { name: '加入处方', exact: true }).click()
    await expect(firstDialog).toHaveCount(0)
    await expect(page.locator('[data-agent-section="prescription"]').getByText('草稿已自动保存', { exact: true })).toBeVisible()

    for (const locale of ['zh-CN', 'en-US'] as const) for (const width of [1101, 826]) for (const theme of ['light', 'dark'] as const) {
      const zh = locale === 'zh-CN'
      await appearance(page, locale, theme, 'standard', width)
      await selectCaseSection(page, locale, 'prescription')
      await page.getByRole('button', { name: zh ? '添加药品' : 'Add medication', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: zh ? '选择药品' : 'Select medication', exact: true })
      const localTab = dialog.getByRole('tab', { name: zh ? '本院药房' : 'Hospital pharmacy', exact: true })
      const referenceTab = dialog.getByRole('tab', { name: zh ? '国家参考目录' : 'National reference', exact: true })
      await expect(localTab).toHaveAttribute('aria-selected', 'true')
      await referenceTab.click()
      await expect(referenceTab).toHaveAttribute('aria-selected', 'true')
      const notice = dialog.getByText(
        zh
          ? '国家参考目录药品仅生成电子外延处方，不在本院收费与药房发药。'
          : 'National reference medications generate external electronic prescriptions only and are not billed or dispensed at this hospital.',
        { exact: true },
      )
      await expect(notice).toBeVisible()
      await expectTextFits(notice)
      const disabledCandidate = dialog.getByRole('button', { name: new RegExp(`^${zh ? '选择' : 'Select'} ${medicationName}`) })
      await expect(disabledCandidate).toBeDisabled()
      const expectedDisableReason = zh
        ? '已含本院药房药品，需与本院处方分开开具'
        : 'Issue separately from hospital pharmacy items'
      expect(await disabledCandidate.evaluate((button, reason) => {
        const box = button.getBoundingClientRect()
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const start = node.textContent?.indexOf(reason) ?? -1
          if (start < 0) continue
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + reason.length)
          const rect = range.getBoundingClientRect()
          return rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
        }
        return false
      }, expectedDisableReason)).toBe(true)
      expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('diagnosis-prescription-fail-reason', {
        detail: { reason: 'PRESCRIPTION_DIAGNOSIS_NOT_ALLOWED' },
      })))
      const panel = page.getByRole('region', { name: zh ? '待开具处方' : 'Prescription to issue', exact: true })
      await panel.getByRole('button', { name: zh ? /^开具处方/ : /^Issue prescription/ }).click()
      const errorBanner = panel.getByText(
        zh
          ? '已确认的诊断不在该药品允许的目录范围内。请调整诊断或更换药品。'
          : 'The confirmed diagnosis is not in the allowlist for this medication. Adjust the diagnosis or choose another medication.',
        { exact: true },
      )
      await expect(errorBanner).toBeVisible()
      await expectTextFits(errorBanner)
      await expectPanelBounded(page, 'prescription')
    }
    await expectNoFixtureErrors(page)
  })

  test(`searches national reference medications with a single-character keyword and preserves Agent attributes on React ${version}`, async ({ page }) => {
    await mount(page, version, 'catalog-split')
    await openWorkspaceTab(page, '处方')
    await page.getByRole('button', { name: '添加药品', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择药品', exact: true })
    const searchBox = dialog.getByRole('textbox', { name: '搜索药品目录', exact: true })
    await searchBox.fill('第')
    await dialog.getByRole('button', { name: '执行药品目录搜索', exact: true }).click()
    await dialog.getByRole('button', { name: '切换至国家参考目录', exact: true }).click()
    await expect(dialog.getByRole('tab', { name: '国家参考目录', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(dialog.locator('[data-agent-medication-name]')).toHaveCount(1)
    await expect(dialog.locator('[data-agent-medication-name]').first()).toHaveText('合成第二药品')
    await expect(dialog.locator('[data-agent-medication-package]').first()).toBeVisible()
    await expectNoFixtureErrors(page)
  })
})
