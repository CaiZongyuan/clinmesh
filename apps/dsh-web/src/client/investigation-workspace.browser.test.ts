import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test, type Page } from '@playwright/test'
import { z } from 'zod'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const artifacts = new Map<string, { script: string; styles: string }>()
test.describe.configure({ mode: 'default' })

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
      entry: fileURLToPath(new URL('./investigation-workspace.browser.fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'InvestigationWorkspaceContract',
    } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
  const script = outputs.find(output => output.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('Missing investigation workspace browser fixture')
  const artifact = { script: script.code, styles: await buildSurfaceStyles() }
  artifacts.set(version, artifact)
  return artifact
}

async function mount(page: Page, version: string, mode: 'empty' | 'existing' | 'recommendations' | 'failed', multiple = false) {
  const { script, styles } = await buildFixture(version)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto('http://localhost/')
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html data-fixture-mode="${mode}" data-fixture-multiple="${multiple}"><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
  ))).toEqual({ ready: true })
  try {
    await page.getByRole('button', { name: /合成浏览器患者/ }).click()
  } catch (error) {
    await expectNoFixtureErrors(page)
    throw error
  }
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
}

async function readCase(page: Page) {
  return doctorCaseDetailSchema.parse(await page.evaluate(async () =>
    await (await fetch('/api/his/v1/doctor/cases/synthetic-case')).json(),
  ))
}

async function expectNoFixtureErrors(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('investigation-errors')))
  const actual = z.object({ errors: z.array(z.string()) }).parse(
    JSON.parse(Buffer.from(await page.title(), 'base64').toString('utf8')),
  )
  expect(actual.errors).toEqual([])
}

async function forEachAppearance(page: Page, locales: readonly ('zh-CN' | 'en-US')[], verify: (locale: 'zh-CN' | 'en-US', width: number) => Promise<void>) {
  for (const locale of locales) {
    for (const theme of ['light', 'dark'] as const) {
      for (const fontSize of ['standard', 'larger', 'large'] as const) {
        for (const width of [1280, 390]) {
          await test.step(`${locale} ${theme} ${fontSize} ${width}`, async () => {
            await page.setViewportSize({ width, height: 900 })
            await page.evaluate(({ locale, theme, fontSize, width }) => {
              document.getElementById('investigation-host')!.style.width = `${width}px`
              window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale, theme, fontSize } }))
            }, { locale, theme, fontSize, width })
            const root = page.locator('[data-clinmesh-app="web"]')
            await expect(root).toHaveAttribute('lang', locale)
            await expect(root).toHaveAttribute('data-font-size', fontSize)
            await expect(root).toHaveAttribute('data-theme', theme)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
            await verify(locale, width)
          })
        }
      }
    }
  }
}

async function expectWorkspaceColumns(page: Page, hasRecords: boolean) {
  const workspace = page.locator('[data-doctor-order-workspace]:visible')
  await expect(workspace).toHaveAttribute('data-has-records', String(hasRecords))
  const bounds = await workspace.evaluate(element => {
    const entry = element.querySelector('[data-order-entry]')!.getBoundingClientRect()
    const pending = element.querySelector('[data-order-pending]')!.getBoundingClientRect()
    const details = element.querySelector('[data-order-details]')?.getBoundingClientRect()
    return { entryWidth: entry.width, entryRight: entry.right, pendingWidth: pending.width,
      rightWidth: details?.width ?? pending.width, rightLeft: details?.left ?? pending.left }
  })
  if (hasRecords) expect(bounds.rightWidth).toBeGreaterThan(bounds.entryWidth)
  else expect(bounds.entryWidth).toBeGreaterThan(bounds.pendingWidth)
  expect(bounds.rightLeft).toBeGreaterThanOrEqual(bounds.entryRight)
}

for (const version of ['18', '19']) {
  test.describe(`investigation workspace on React ${version}`, () => {
    test.beforeAll(async () => { await buildFixture(version) })

    test(`keeps the second AI laboratory request pending after issuing the first on React ${version}`, async ({ page }) => {
      await mount(page, version, 'recommendations', true)
      await expectWorkspaceColumns(page, false)
      const panel = page.getByRole('region', { name: '待开具检验', exact: true })
      const second = panel.getByRole('checkbox', { name: '选择合成第二检验项目', exact: true })
      await expect(panel.getByRole('checkbox')).toHaveCount(2)
      const catalogSearch = page.getByRole('textbox', { name: '搜索检验目录', exact: true })
      await catalogSearch.fill('合成')
      await page.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
      await expect(page.getByRole('button', { name: '选择 合成第二检验项目 SYN-SECOND', exact: true })).toBeVisible()
      await second.uncheck()
      const issue = panel.getByRole('button', { name: /^开具选中项目/ })
      await issue.click()
      await expect.poll(async () => (await readCase(page)).laboratoryRequests?.requests.length).toBe(1)
      await expectWorkspaceColumns(page, true)
      await expect(catalogSearch).toHaveValue('合成')
      await expect(catalogSearch).toBeVisible()
      await expect(page.getByRole('button', { name: '展开目录', exact: true })).toHaveAttribute('aria-expanded', 'false')
      await expect(second).toBeVisible()
      await expect(second).not.toBeChecked()
      const openPending = panel.getByRole('button', { name: '查看待开具 合成第二检验项目', exact: true })
      await openPending.click()
      const pendingDetail = page.getByRole('region', { name: '待开具项目详情', exact: true })
      await expect(pendingDetail).toBeVisible()
      expect(await pendingDetail.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await expect(page.getByRole('dialog', { name: '调整项目', exact: true })).toHaveCount(0)
      await pendingDetail.getByRole('combobox', { name: '检查目的', exact: true }).click()
      await page.getByRole('option', { name: '发热', exact: true }).click()
      const issueFromDetail = pendingDetail.getByRole('button', { name: /^开具选中项目/ })
      await expect(issueFromDetail).toBeDisabled()
      const records = page.getByRole('region', { name: '申请列表', exact: true })
      await records.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已开具', exact: true }).click()
      await expect(pendingDetail).toBeHidden()
      await expect(page.getByRole('region', { name: '申请详情', exact: true })).toBeVisible()
      await openPending.click()
      await expect(pendingDetail.getByRole('combobox', { name: '检查目的', exact: true })).toContainText('发热')
      await expect(issueFromDetail).toBeDisabled()
      await pendingDetail.getByRole('button', { name: '保留本次调整', exact: true }).click()
      await expect(second).toBeChecked()
      await expect(panel.getByRole('button', { name: /^开具选中项目/ })).toHaveCount(0)
      await issueFromDetail.click()
      await expect.poll(async () => (await readCase(page)).laboratoryRequests?.requests.length).toBe(2)
      const list = page.getByRole('region', { name: '申请列表', exact: true })
      await expect(list.getByRole('button', { name: '合成第二检验项目 已开具', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('region', { name: '申请详情', exact: true }).getByRole('heading', { name: '合成第二检验项目', exact: true })).toBeVisible()
      expect((await readCase(page)).laboratoryRequests?.requests.map(item => item.catalogItemId)).toEqual(['synthetic-lab-second', 'synthetic-lab'])
      expect((await readCase(page)).laboratoryRequests?.requests[0]?.indicationCode).toBe('fever')
      await expectNoFixtureErrors(page)
    })

    for (const scenario of [
      { kind: 'laboratory', tab: '检验 0', title: '待开具检验', label: '合成完整检验组合与扩展指标名称', issue: '开具检验申请' },
      { kind: 'imaging', tab: '放射检查 0', title: '待开具放射检查', label: '胸部 CT 平扫', issue: '签发申请' },
      { kind: 'pathology', tab: '病理会诊 0', title: '待开具病理会诊', label: '乳腺切片病理会诊', issue: '签发申请' },
    ] as const) {
      test(`directly issues selected ${scenario.kind} with collapsed reasoning and preserved manual fields on React ${version}`, async ({ page }) => {
        await mount(page, version, 'recommendations')
        await page.setViewportSize({ width: 390, height: 900 })
        await page.evaluate(() => {
          document.getElementById('investigation-host')!.style.width = '390px'
          window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale: 'zh-CN', theme: 'light', fontSize: 'large' } }))
        })
        await page.getByRole('tab', { name: scenario.tab, exact: true }).click()
        const panel = page.getByRole('region', { name: scenario.title, exact: true })
        const issue = panel.getByRole('button', { name: /^开具选中项目/ })
        await expect(panel.getByRole('checkbox', { name: `选择${scenario.label}`, exact: true })).toBeChecked()
        await expect(issue).toBeEnabled()
        await expect(page.getByRole('region', { name: '待核实思路', exact: true })).toHaveCount(0)
        await expect(panel.getByRole('button', { name: /^采纳 / })).toHaveCount(0)
        await panel.getByRole('button', { name: '依据与说明', exact: true }).click()
        const details = page.getByRole('dialog', { name: '依据与说明', exact: true })
        expect(await details.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const thoughts = details.getByRole('region', { name: '待核实思路', exact: true })
        await expect(thoughts.getByText('合成病例依据：来源与当前病例绑定，不代表已开立检查。', { exact: true })).toBeVisible()
        await expect(thoughts.getByText('仅在核实症状与具体情境后，再判断本项检查是否改变处置。', { exact: true })).toBeVisible()
        await expect(thoughts.getByRole('button')).toHaveCount(0)
        await expect(thoughts.getByRole('link')).toHaveCount(0)
        for (const message of ['当前接入指南未支持本项合成思路。', '本项合成思路尚无对应的本院可执行目录身份。',
          '另一合成候选因限定语不成立而未发布。', '合成处理限制示例：本轮未能完整处理额外来源资料。']) {
          await expect(details.getByText(message, { exact: true })).toBeVisible()
        }
        await expect(details.getByRole('link', { name: /合成检查建议来源/ })).toHaveAttribute('href', 'https://example.test/investigation-guideline')
        await expect(details.getByText('合成来源条款：长中文仅验证检查建议引用、医生草稿与正式开立入口。', { exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(details).toHaveCount(0)
        const before = await readCase(page)
        expect(before.laboratoryRequests?.draft).toBeUndefined()
        expect(before.imagingRequests?.draft).toBeUndefined()
        expect(before.pathologyRequests?.draft).toBeUndefined()
        if (scenario.kind !== 'laboratory') {
          await panel.getByRole('button', { name: '调整', exact: true }).click()
          const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
          const input = edit.getByRole('textbox', { name: scenario.kind === 'imaging' ? '检查目的' : '会诊目的', exact: true })
          await expect(input).toHaveValue(scenario.kind === 'imaging' ? '合成建议检查指征，需医生核对。' : '合成建议复核既往手术切片，需医生核对。')
          await input.fill('医生手改的合成申请内容，刷新建议必须保留。')
          await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
        }
        await panel.getByRole('button', { name: '刷新', exact: true }).click()
        await expect.poll(async () => doctorRecommendationStateSchema.parse(await page.evaluate(async kind =>
          await (await fetch(`/api/his/v1/doctor/cases/synthetic-case/recommendations/${kind}`)).json(), scenario.kind,
        )).generation).toBe(2)
        if (scenario.kind !== 'laboratory') {
          await panel.getByRole('button', { name: '调整', exact: true }).click()
          const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
          await expect(edit.getByRole('textbox', { name: scenario.kind === 'imaging' ? '检查目的' : '会诊目的', exact: true }))
            .toHaveValue('医生手改的合成申请内容，刷新建议必须保留。')
          await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
        }
        const draft = await readCase(page)
        expect(draft.laboratoryRequests?.requests).toEqual([])
        expect(draft.imagingRequests?.requests).toEqual([])
        expect(draft.pathologyRequests?.requests).toEqual([])
        expect(draft.laboratoryRequests?.draft).toBeUndefined()
        expect(draft.imagingRequests?.draft).toBeUndefined()
        expect(draft.pathologyRequests?.draft).toBeUndefined()
        const section = page.locator('[data-agent-section="laboratory"]')
        const overflow = await section.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        await issue.click()
        await expect.poll(async () => {
          const detail = await readCase(page)
          return scenario.kind === 'laboratory' ? detail.laboratoryRequests?.requests.length : scenario.kind === 'imaging' ? detail.imagingRequests?.requests.length : detail.pathologyRequests?.requests.length
        }).toBe(1)
        const issued = await readCase(page)
        expect(issued.laboratoryRequests?.requests).toHaveLength(scenario.kind === 'laboratory' ? 1 : 0)
        expect(issued.imagingRequests?.requests).toHaveLength(scenario.kind === 'imaging' ? 1 : 0)
        expect(issued.pathologyRequests?.requests).toHaveLength(scenario.kind === 'pathology' ? 1 : 0)
        const request = scenario.kind === 'laboratory' ? issued.laboratoryRequests?.requests[0] : scenario.kind === 'imaging' ? issued.imagingRequests?.requests[0] : issued.pathologyRequests?.requests[0]
        expect(request).toMatchObject({ status: 'issued', serviceRequestId: `service-request-${scenario.kind}-1` })
        if (scenario.kind === 'laboratory') expect(request).toMatchObject({ catalogItemId: 'synthetic-lab', indicationCode: 'clinical-evaluation' })
        else if (scenario.kind === 'imaging') expect(request).toMatchObject({ indication: '医生手改的合成申请内容，刷新建议必须保留。', service: { id: 'imaging-chest-ct-plain' } })
        else expect(request).toMatchObject({ purpose: '医生手改的合成申请内容，刷新建议必须保留。', sourceProcedure: { sourceReference: 'urn:uuid:procedure-1' } })
        const append = page.getByRole(scenario.kind === 'pathology' ? 'searchbox' : 'textbox', { name: scenario.kind === 'laboratory' ? '搜索检验目录' : scenario.kind === 'imaging' ? '搜索放射目录' : '搜索病理目录', exact: true })
        await append.click()
        const dialog = page.locator('[data-order-entry]:visible')
        await expect(dialog).toBeVisible()
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        const collapse = dialog.getByRole('button', { name: /^(展开目录|收起目录)$/ })
        await collapse.click()
        await expect(dialog).toBeVisible()
        await expect(collapse).toHaveAttribute('aria-expanded', 'false')
        await expect(collapse).toBeFocused()
        await expectNoFixtureErrors(page)
      })
    }

    test(`adds manual investigations, issues from one list and appends through the Surface on React ${version}`, async ({ page }) => {
      await mount(page, version, 'empty')
      await expect(page.getByRole('textbox', { name: '搜索检验目录' })).toBeVisible()
      await expect(page.getByRole('region', { name: '申请列表', exact: true })).toHaveCount(0)
      await expectWorkspaceColumns(page, false)
      const add = page.getByRole('textbox', { name: '搜索检验目录', exact: true })
      await add.click()
      await forEachAppearance(page, ['zh-CN', 'en-US'], async (locale, width) => {
        const dialog = page.locator('[data-order-entry]:visible')
        await expect(dialog.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索检验目录' : 'Search laboratory catalog' })).toBeVisible()
        const nextPage = dialog.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: locale === 'zh-CN' ? '下一页' : 'Next page', exact: true })
        await nextPage.scrollIntoViewIfNeeded()
        await expect(nextPage).toBeInViewport()
        const metrics = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
          left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1)
        expect(metrics.left).toBeGreaterThanOrEqual(0)
        expect(metrics.right).toBeLessThanOrEqual(width + 1)
      })
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.evaluate(() => {
        document.getElementById('investigation-host')!.style.width = '1280px'
        window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale: 'zh-CN', theme: 'light', fontSize: 'standard' } }))
      })
      const dialog = page.locator('[data-order-entry]:visible')
      const catalog = dialog.getByRole('textbox', { name: '搜索检验目录' })
      await dialog.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: '下一页', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '选择 合成目录项目 19 SYN-LAB', exact: true })).toBeVisible()
      await dialog.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: '上一页', exact: true }).click()
      await catalog.fill('第二')
      await expect(dialog.getByRole('button', { name: '选择 合成第二检验项目 SYN-SECOND', exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: '选择 合成完整检验组合与扩展指标名称 SYN-LAB', exact: true })).toHaveCount(0)
      await catalog.fill('')
      const selection = dialog.getByRole('button', { name: '选择 合成完整检验组合与扩展指标名称 SYN-LAB' })
      await expect(selection).toHaveAttribute('aria-pressed', 'false')
      await selection.focus()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('region', { name: '检验申请', exact: true }).getByText('合成静脉血标本')).toBeVisible()
      await expect(dialog.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
      await expect(dialog).toBeVisible()
      await add.focus()
      await expect(add).toBeFocused()
      const panel = page.getByRole('region', { name: '待开具检验', exact: true })
      const issue = panel.getByRole('button', { name: /^开具选中项目/ })
      await expect(issue).toHaveCount(1)
      await expect(issue).toBeEnabled()
      await expect(panel.getByRole('checkbox', { name: '选择合成完整检验组合与扩展指标名称', exact: true })).toBeChecked()
      await issue.click()
      await expect(page.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
      await expectWorkspaceColumns(page, true)
      await expect(page.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已开具', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText('当前合成结论 issued-1', { exact: true })).toHaveCount(0)
      await page.evaluate(() => window.dispatchEvent(new Event('investigation-release-report')))
      await expect(page.getByText('当前合成结论 issued-1', { exact: false })).toBeVisible()
      await page.getByRole('tab', { name: '放射检查 0', exact: true }).click()
      await expect(page.getByRole('region', { name: '开具放射申请', exact: true }).getByRole('textbox', { name: '搜索放射目录' })).toBeVisible()
      await page.getByRole('tab', { name: '病理会诊 0', exact: true }).click()
      await expect(page.getByRole('region', { name: '开具病理会诊', exact: true }).getByRole('searchbox', { name: '搜索病理目录' })).toBeVisible()
      await page.getByRole('tab', { name: '检验 1', exact: true }).click()
      await add.click()
      await expect(dialog.getByRole('textbox', { name: '搜索检验目录' })).toBeVisible()
      expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
      await expect(dialog).toBeVisible()
      await add.focus()
      await expect(add).toBeFocused()
      await add.click()
      await dialog.getByRole('button', { name: '选择 合成第二检验项目 SYN-SECOND' }).click()
      await expect(dialog.getByRole('button', { name: '展开目录', exact: true })).toBeFocused()
      await expect(panel.getByRole('checkbox')).toHaveCount(1)
      await expect(panel.getByRole('checkbox', { name: '选择合成第二检验项目', exact: true })).toBeChecked()
      await issue.click()
      const list = page.getByRole('region', { name: '申请列表', exact: true })
      await expect(list.getByRole('button', { name: '合成第二检验项目 已开具', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(list.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已报告', exact: true })).toBeVisible()
      expect((await readCase(page)).laboratoryRequests?.requests.map(item => item.catalogItemId)).toEqual(['synthetic-lab-second', 'synthetic-lab'])
      await expectNoFixtureErrors(page)
    })

    for (const scenario of [
      { kind: 'imaging', tab: '放射检查 0', add: '添加检查', title: '待开具放射检查', field: '检查目的', formField: '检查指征' },
      { kind: 'pathology', tab: '病理会诊 0', add: '添加病理会诊', title: '待开具病理会诊', field: '会诊目的', formField: '会诊目的' },
    ] as const) {
      test(`adds and edits a manual ${scenario.kind} in one list after Agent failure on React ${version}`, async ({ page }) => {
        await mount(page, version, 'failed')
        await page.setViewportSize({ width: 390, height: 900 })
        await page.evaluate(() => {
          document.getElementById('investigation-host')!.style.width = '390px'
          window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale: 'zh-CN', theme: 'dark', fontSize: 'large' } }))
        })
        await page.getByRole('tab', { name: scenario.tab, exact: true }).click()
        const add = page.getByRole(scenario.kind === 'imaging' ? 'textbox' : 'searchbox', { name: scenario.kind === 'imaging' ? '搜索放射目录' : '搜索病理目录', exact: true })
        await add.click()
        const dialog = page.locator('[data-order-entry]:visible')
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        if (scenario.kind === 'imaging') await dialog.getByRole('button', { name: /^胸部 CT 平扫/ }).click()
        else {
          await dialog.getByRole('radio', { name: '选择乳腺切片病理会诊', exact: true }).check()
          await dialog.getByRole('combobox', { name: '送检的既往手术', exact: true }).click()
          await page.getByRole('option', { name: /乳腺病灶切除术/ }).click()
        }
        await dialog.getByRole('textbox', { name: scenario.formField, exact: true }).fill('手动表单中的合成申请目的。')
        await expect(dialog.getByRole('button', { name: '签发申请', exact: true })).toHaveCount(0)
        const done = dialog.getByRole('textbox', { name: scenario.formField, exact: true })
        await done.scrollIntoViewIfNeeded()
        await expect(done).toBeInViewport()
        await done.click()
        await expect(dialog).toBeVisible()
        await add.focus()
        await expect(add).toBeFocused()
        const panel = page.getByRole('region', { name: scenario.title, exact: true })
        await expect(panel.getByRole('checkbox')).toHaveCount(1)
        await panel.getByRole('button', { name: '调整', exact: true }).click()
        const edit = page.getByRole('dialog', { name: '调整项目', exact: true })
        await expect(edit.getByRole('textbox', { name: scenario.field, exact: true })).toHaveValue('手动表单中的合成申请目的。')
        await edit.getByRole('textbox', { name: scenario.field, exact: true }).fill('统一清单调整后的合成申请目的。')
        await edit.getByRole('button', { name: '保留本次调整', exact: true }).click()
        await add.click()
        await expect(dialog.getByRole('textbox', { name: scenario.formField, exact: true })).toHaveValue('统一清单调整后的合成申请目的。')
        if (scenario.kind === 'pathology') await expect(dialog.getByRole('combobox', { name: '送检的既往手术', exact: true })).toContainText('乳腺病灶切除术')
        await expect(page.getByRole('button', { name: /^开具选中项目/ })).toHaveCount(1)
        await panel.getByRole('button', { name: /^开具选中项目/ }).click()
        await expect.poll(async () => {
          const detail = await readCase(page)
          return scenario.kind === 'imaging' ? detail.imagingRequests?.requests.length : detail.pathologyRequests?.requests.length
        }).toBe(1)
        const detail = await readCase(page)
        if (scenario.kind === 'imaging') expect(detail.imagingRequests?.requests[0]).toMatchObject({ indication: '统一清单调整后的合成申请目的。', service: { id: 'imaging-chest-ct-plain' } })
        else expect(detail.pathologyRequests?.requests[0]).toMatchObject({ purpose: '统一清单调整后的合成申请目的。', sourceProcedure: { sourceReference: 'urn:uuid:procedure-1' } })
        await expectNoFixtureErrors(page)
      })
    }

    for (const locale of ['zh-CN', 'en-US'] as const) {
      test(`keeps investigation lists, inline catalogs and report ends reachable in ${locale} across Surface appearance settings on React ${version}`, async ({ page }) => {
        await mount(page, version, 'existing')
        const categories = page.getByRole('tablist', { name: '检查分类' })
        await expect(categories).toBeVisible()
        await expect(page.getByText('当前合成结论 first', { exact: false })).toBeVisible()
        await expect(page.getByText('当前合成结论 second', { exact: false })).toHaveCount(0)
        await page.getByRole('button', { name: '合成第二检验项目 已报告', exact: true }).click()
        await expect(page.getByText('当前合成结论 second', { exact: false })).toBeVisible()
        await expect(page.getByText('当前合成结论 first', { exact: false })).toHaveCount(0)
        await page.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已报告', exact: true }).click()
        await forEachAppearance(page, [locale], async (locale, width) => {
          const zh = locale === 'zh-CN'
          const panel = page.locator('[data-agent-section="laboratory"]')
          const detail = page.getByRole('region', { name: zh ? '申请详情' : 'Request detail', exact: true })
          await expect(detail).toBeVisible()
          const table = detail.locator('[data-slot="table-container"]').first()
          const end = table.locator('tr').last()
          await end.scrollIntoViewIfNeeded()
          const metrics = await panel.evaluate(element => {
            const table = element.querySelector<HTMLElement>('[aria-label="申请详情"] [data-slot="table-container"], [aria-label="Request detail"] [data-slot="table-container"]')!
            const bounds = element.getBoundingClientRect()
            const last = table.querySelector('tbody tr:last-child')!.getBoundingClientRect()
            table.scrollLeft = table.scrollWidth
            return {
              panelWidth: element.clientWidth, panelScrollWidth: element.scrollWidth,
              tableWidth: table.clientWidth, tableScrollWidth: table.scrollWidth,
              tableScrollLeft: table.scrollLeft, panelScrollLeft: element.scrollLeft,
              endVisible: last.top >= bounds.top - 1 && last.bottom <= bounds.bottom + 1,
            }
          })
          expect(metrics).toMatchObject({ panelScrollLeft: 0, endVisible: true })
          expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelWidth + 1)
          if (width === 390) {
            expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableWidth)
            expect(metrics.tableScrollLeft).toBeGreaterThan(0)
          }
          const history = detail.locator('details')
          await expect(history).not.toHaveAttribute('open')
          await history.locator('summary').scrollIntoViewIfNeeded()
          await expect(history.locator('summary')).toBeInViewport()
          const acknowledge = page.getByRole('button', { name: new RegExp(`^${zh ? '确认已阅' : 'Acknowledge report'}`) })
          await acknowledge.scrollIntoViewIfNeeded()
          await expect(acknowledge).toBeInViewport()
          const append = page.getByRole('textbox', { name: zh ? '搜索检验目录' : 'Search laboratory catalog', exact: true })
          await append.click()
          const dialog = page.locator('[data-order-entry]:visible')
          await expect(dialog.getByRole('textbox', { name: zh ? '搜索检验目录' : 'Search laboratory catalog' })).toBeVisible()
          const nextPage = dialog.getByRole('button', { name: zh ? '下一页' : 'Next page', exact: true })
          await nextPage.scrollIntoViewIfNeeded()
          await expect(nextPage).toBeInViewport()
          const dialogOverflow = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
            left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
          expect(dialogOverflow.scrollWidth).toBeLessThanOrEqual(dialogOverflow.width + 1)
          expect(dialogOverflow.left).toBeGreaterThanOrEqual(0)
          expect(dialogOverflow.right).toBeLessThanOrEqual(width + 1)
          const collapse = dialog.getByRole('button', { name: /^(展开目录|收起目录|Expand catalog|Collapse catalog)$/ })
          await collapse.click()
          await expect(dialog).toBeVisible()
          await expect(collapse).toHaveAttribute('aria-expanded', 'false')
          await expect(collapse).toBeFocused()
        })
        await expectNoFixtureErrors(page)
      })
    }
  })
}
