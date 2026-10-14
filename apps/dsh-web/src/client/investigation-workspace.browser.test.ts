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

async function mount(page: Page, version: string, mode: 'empty' | 'existing' | 'recommendations') {
  const { script, styles } = await buildFixture(version)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
  await page.goto('http://localhost/')
  expect(z.object({ ready: z.literal(true) }).parse(await readJsonFromBrowser(page,
    `<!doctype html><html data-fixture-mode="${mode}"><head><meta charset="utf-8"><style>body{margin:0}</style><style data-fixture>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`,
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

for (const version of ['18', '19']) {
  test.describe(`investigation workspace on React ${version}`, () => {
    test.beforeAll(async () => { await buildFixture(version) })

    for (const scenario of [
      { kind: 'laboratory', tab: '检验 0', title: '检验建议', label: '合成完整检验组合与扩展指标名称', issue: '开具检验申请' },
      { kind: 'imaging', tab: '放射检查 0', title: '放射检查建议', label: '胸部 CT 平扫', issue: '签发申请' },
      { kind: 'pathology', tab: '病理会诊 0', title: '病理会诊建议', label: '乳腺切片病理会诊', issue: '签发申请' },
    ] as const) {
      test(`adopts ${scenario.kind} recommendations into editable drafts before the doctor issues them on React ${version}`, async ({ page }) => {
        await mount(page, version, 'recommendations')
        await page.setViewportSize({ width: 390, height: 900 })
        await page.evaluate(() => {
          document.getElementById('investigation-host')!.style.width = '390px'
          window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale: 'zh-CN', theme: 'light', fontSize: 'large' } }))
        })
        await page.getByRole('tab', { name: scenario.tab, exact: true }).click()
        const panel = page.getByRole('region', { name: scenario.title, exact: true })
        await panel.getByText('查看依据', { exact: true }).click()
        await expect(panel.getByRole('link', { name: '合成检查建议来源', exact: true })).toHaveAttribute('href', 'https://example.test/investigation-guideline')
        await expect(panel.getByText('合成来源条款：长中文仅验证检查建议引用、医生草稿与正式开立入口。', { exact: true })).toBeVisible()
        await expect(panel.getByText('合成病例依据：来源与当前病例绑定，不代表已开立检查。', { exact: true })).toBeVisible()
        await panel.getByRole('button', { name: `采纳 ${scenario.label}`, exact: true }).click()
        const issue = page.getByRole('button', { name: scenario.issue, exact: true })
        if (scenario.kind === 'laboratory') {
          await expect(page.getByRole('region', { name: '检验申请', exact: true }).getByText('合成静脉血标本', { exact: true })).toBeVisible()
          await expect(page.getByText('临床评估', { exact: true })).toBeVisible()
        } else {
          const input = page.getByRole('textbox', { name: scenario.kind === 'imaging' ? '检查指征' : '会诊目的', exact: true })
          await expect(input).toHaveValue(scenario.kind === 'imaging' ? '合成建议检查指征，需医生核对。' : '合成建议复核既往手术切片，需医生核对。')
          if (scenario.kind === 'pathology') {
            await expect(page.getByRole('combobox', { name: '送检的既往手术', exact: true })).toContainText('乳腺病灶切除术')
          }
          await input.fill('医生手改的合成申请内容，刷新建议必须保留。')
        }
        await panel.getByRole('button', { name: '刷新建议', exact: true }).click()
        await expect.poll(async () => doctorRecommendationStateSchema.parse(await page.evaluate(async kind =>
          await (await fetch(`/api/his/v1/doctor/cases/synthetic-case/recommendations/${kind}`)).json(), scenario.kind,
        )).generation).toBe(2)
        if (scenario.kind !== 'laboratory') {
          await expect(page.getByRole('textbox', { name: scenario.kind === 'imaging' ? '检查指征' : '会诊目的', exact: true }))
            .toHaveValue('医生手改的合成申请内容，刷新建议必须保留。')
          await page.getByRole('button', { name: '保存草稿', exact: true }).click()
        }
        await expect(issue).toBeEnabled()
        await expect.poll(async () => {
          const detail = await readCase(page)
          return scenario.kind === 'laboratory' ? detail.laboratoryRequests?.draft : scenario.kind === 'imaging' ? detail.imagingRequests?.draft : detail.pathologyRequests?.draft
        }).toBeDefined()
        const draft = await readCase(page)
        expect(draft.laboratoryRequests?.requests).toEqual([])
        expect(draft.imagingRequests?.requests).toEqual([])
        expect(draft.pathologyRequests?.requests).toEqual([])
        if (scenario.kind === 'laboratory') expect(draft.laboratoryRequests?.draft).toMatchObject({ catalogItemId: 'synthetic-lab', indicationCode: 'clinical-evaluation' })
        else if (scenario.kind === 'imaging') expect(draft.imagingRequests?.draft).toMatchObject({ indication: '医生手改的合成申请内容，刷新建议必须保留。', service: { id: 'imaging-chest-ct-plain' } })
        else expect(draft.pathologyRequests?.draft).toMatchObject({ purpose: '医生手改的合成申请内容，刷新建议必须保留。', sourceProcedure: { sourceReference: 'urn:uuid:procedure-1' } })
        await expect(panel.getByRole('button', { name: `采纳 ${scenario.label}`, exact: true })).toBeDisabled()
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
        const request = scenario.kind === 'laboratory' ? issued.laboratoryRequests?.requests[0] : scenario.kind === 'imaging' ? issued.imagingRequests?.requests[0] : issued.pathologyRequests?.requests[0]
        expect(request).toMatchObject({ status: 'issued', serviceRequestId: `service-request-${scenario.kind}-1` })
        const append = page.getByRole('button', { name: '追加申请', exact: true })
        await append.click()
        const dialog = page.getByRole('dialog', { name: '追加申请', exact: true })
        await expect(dialog).toBeVisible()
        expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(append).toBeFocused()
        await expectNoFixtureErrors(page)
      })
    }

    test(`opens the inline investigation catalog, issues and appends through the Surface on React ${version}`, async ({ page }) => {
      await mount(page, version, 'empty')
      const catalog = page.getByRole('textbox', { name: '搜索检验目录' })
      await expect(catalog).toBeVisible()
      await expect(page.getByRole('region', { name: '申请列表', exact: true })).toHaveCount(0)
      await forEachAppearance(page, ['zh-CN', 'en-US'], async locale => {
        await expect(page.getByRole('textbox', { name: locale === 'zh-CN' ? '搜索检验目录' : 'Search laboratory catalog' })).toBeVisible()
        const nextPage = page.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: locale === 'zh-CN' ? '下一页' : 'Next page', exact: true })
        await nextPage.scrollIntoViewIfNeeded()
        await expect(nextPage).toBeInViewport()
        const panel = page.locator('[data-agent-section="laboratory"]')
        const overflow = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }))
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1)
      })
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.evaluate(() => {
        document.getElementById('investigation-host')!.style.width = '1280px'
        window.dispatchEvent(new CustomEvent('investigation-appearance', { detail: { locale: 'zh-CN', theme: 'light', fontSize: 'standard' } }))
      })
      await page.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: '下一页', exact: true }).click()
      await expect(page.getByRole('button', { name: '选择 合成目录项目 19 SYN-LAB', exact: true })).toBeVisible()
      await page.locator('[data-agent-catalog="laboratory"]').getByRole('button', { name: '上一页', exact: true }).click()
      await catalog.fill('第二')
      await expect(page.getByRole('button', { name: '选择 合成第二检验项目 SYN-SECOND', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '选择 合成完整检验组合与扩展指标名称 SYN-LAB', exact: true })).toHaveCount(0)
      await catalog.fill('')
      const selection = page.getByRole('button', { name: '选择 合成完整检验组合与扩展指标名称 SYN-LAB' })
      await expect(selection).toHaveAttribute('aria-pressed', 'false')
      await selection.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('region', { name: '检验申请', exact: true }).getByText('合成静脉血标本')).toBeVisible()
      const issue = page.getByRole('button', { name: '开具检验申请', exact: true })
      await expect(issue).toBeEnabled()
      await issue.click()
      await expect(page.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已开具', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText('当前合成结论 issued-1', { exact: true })).toHaveCount(0)
      await page.evaluate(() => window.dispatchEvent(new Event('investigation-release-report')))
      await expect(page.getByText('当前合成结论 issued-1', { exact: false })).toBeVisible()
      await page.getByRole('tab', { name: '放射检查 0', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '搜索放射目录' })).toBeVisible()
      await expect(catalog).toBeHidden()
      await page.getByRole('tab', { name: '病理会诊 0', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: '搜索病理目录' })).toBeVisible()
      await page.getByRole('tab', { name: '检验 1', exact: true }).click()
      const append = page.getByRole('button', { name: '追加申请', exact: true })
      await append.click()
      const dialog = page.getByRole('dialog', { name: '追加申请', exact: true })
      await expect(dialog.getByRole('textbox', { name: '搜索检验目录' })).toBeVisible()
      expect(await page.evaluate(() => document.querySelector('[role="dialog"]') === null)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(append).toBeFocused()
      await append.click()
      await dialog.getByRole('button', { name: '选择 合成第二检验项目 SYN-SECOND' }).click()
      const appendIssue = dialog.getByRole('button', { name: '开具检验申请', exact: true })
      await expect(appendIssue).toBeEnabled()
      await appendIssue.click()
      await expect(dialog).toBeHidden()
      await expect(append).toBeFocused()
      const list = page.getByRole('region', { name: '申请列表', exact: true })
      await expect(list.getByRole('button', { name: '合成第二检验项目 已开具', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(list.getByRole('button', { name: '合成完整检验组合与扩展指标名称 已报告', exact: true })).toBeVisible()
      await expectNoFixtureErrors(page)
    })

    for (const locale of ['zh-CN', 'en-US'] as const) {
      test(`keeps investigation lists, dialogs and report ends reachable in ${locale} across Surface appearance settings on React ${version}`, async ({ page }) => {
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
          const append = page.getByRole('button', { name: zh ? '追加申请' : 'Add request', exact: true })
          await append.click()
          const dialog = page.getByRole('dialog', { name: zh ? '追加申请' : 'Add request', exact: true })
          await expect(dialog.getByRole('textbox', { name: zh ? '搜索检验目录' : 'Search laboratory catalog' })).toBeVisible()
          const nextPage = dialog.getByRole('button', { name: zh ? '下一页' : 'Next page', exact: true })
          await nextPage.scrollIntoViewIfNeeded()
          await expect(nextPage).toBeInViewport()
          const dialogOverflow = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
            left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
          expect(dialogOverflow.scrollWidth).toBeLessThanOrEqual(dialogOverflow.width + 1)
          expect(dialogOverflow.left).toBeGreaterThanOrEqual(0)
          expect(dialogOverflow.right).toBeLessThanOrEqual(width + 1)
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          await expect(append).toBeFocused()
        })
        await expectNoFixtureErrors(page)
      })
    }
  })
}
