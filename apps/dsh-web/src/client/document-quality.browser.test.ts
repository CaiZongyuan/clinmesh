import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { checkClinicalDocumentQualityRequestSchema,
  type ClinicalDocumentQualityControlState } from '@clinmesh/contracts/his'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
const source = '合成患者原文：我对青霉素过敏。今天上午体温38.5℃，请完整核对来源和测量时间。'
const emptyChecks = [
  ['无问题-已更新', 'ready'], ['无问题-检查中', 'pending'], ['无问题-未完成', 'incomplete'],
  ['无问题-失败', 'failed'], ['无问题-暂不可用', 'unavailable'], ['无问题-已过期', 'stale'],
] as const
const state = (): ClinicalDocumentQualityControlState => ({
  caseId: 'quality-case', encounterId: 'quality-encounter', draftVersion: 1,
  documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1,
  stale: false, status: 'ready', notices: [], checkedAt: '2026-10-15T09:00:00+08:00',
  issues: ([
    ['missing-field', 'chiefComplaint', 'needs-completion', '主诉缺少持续时间，请根据已有信息补充。'],
    ['omission', 'allergyHistory', 'needs-completion', '过敏史遗漏患者已经陈述的药物过敏信息。'],
    ['inconsistency', 'physicalExamination', 'needs-verification', '同一时间的体温记录需要核对，保留原文和来源。'],
    ['agent-source', 'assessment', 'needs-verification', 'Agent 新增的事实缺少可核对来源，请由医生核实。'],
  ] as const).map(([kind, field, classification, message], index) => ({
    id: `quality-${index}`, kind, field, classification, message,
    explanation: { impact: '正文未明确区分已知来源和待核实内容，阅读者可能误解其确定程度。',
      suggestion: '核对相关原文、时间与来源后补录已知信息或修订措辞；未知内容保留不确定性。' },
    basis: { kind: 'project', label: '合成浏览器质控依据，仅验证交互与来源展示。' },
    evidence: [{ id: `source-${index}`, kind: 'patient', label: '患者原回答', text: source,
      recordedAt: '2026-10-15T09:00:00+08:00' }, ...(field === 'physicalExamination' ? [{ id: 'current-temperature',
        kind: 'document' as const, label: '当前病历', field, text: '体温36.5℃' }] : [])],
    relatedFingerprint: 'c'.repeat(64), status: 'open',
  })),
})

const fixtureScripts = new Map<string, string>()
let styles: string
test.beforeAll(async () => {
  for (const version of ['18', '19']) {
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./document-quality.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'DocumentQuality' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing document quality fixture')
    fixtureScripts.set(version, script.code)
  }
  styles = await buildSurfaceStyles()
})

for (const version of ['18', '19']) test(`shows completion only in details and verification hints in a narrow bilingual ShadowRoot on React ${version}`, async ({ page }) => {
  const scriptCode = fixtureScripts.get(version)
  if (scriptCode === undefined) throw new Error(`Missing React ${version} fixture`)
  const states = new Map<string, ClinicalDocumentQualityControlState>()
  let releaseOld!: () => void
  const held = new Promise<void>(resolve => { releaseOld = resolve })
  let oldRequested = false
  let oldSettled = false
  const errors: string[] = []
  let checks = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.includes('/document-quality-control')) {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }); return
    }
    const requestInput = route.request().method() === 'POST' ? route.request().postDataJSON() as { input: { clientId?: string } } : undefined
    const clientId = requestInput?.input.clientId ?? new URL(route.request().url()).searchParams.get('clientId') ?? ''
    let current = states.get(clientId) ?? state()
    let delay = false
    if (path.endsWith('/actions/check')) {
      checks += 1
      const { input } = checkClinicalDocumentQualityRequestSchema.parse(route.request().postDataJSON())
      current = { ...current, clientId: input.clientId, clientRevision: input.clientRevision }
      const empty = emptyChecks.find(([text]) => input.document?.chiefComplaint === text)
      if (empty !== undefined) {
        current = { ...current, issues: [], status: empty[1] === 'stale' ? 'ready' : empty[1],
          stale: empty[1] === 'stale', notices: ['合成检查状态说明，不代表检查通过。'] }
      } else if (current.issues.length === 0) current = { ...state(), clientId: input.clientId, clientRevision: input.clientRevision }
      if (input.document?.chiefComplaint === '过时病历内容。') {
        current = { ...current, issues: current.issues.map(issue => issue.field === 'chiefComplaint'
          ? { ...issue, classification: 'needs-verification', message: '过时质控提示不应显示。' } : issue) }
        oldRequested = true; delay = true
      } else if (input.document?.chiefComplaint === '头晕三天。') {
        current = { ...current, issues: current.issues.map(issue => issue.field === 'chiefComplaint'
          ? { ...issue, classification: 'needs-verification', message: '当前草稿的质控提示。' } : issue) }
      }
    }
    states.set(clientId, current)
    if (delay) await held
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().method() === 'POST'
      ? { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: current } : current) })
    if (delay) oldSettled = true
  })
  await page.goto('http://localhost/')
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><script>${scriptCode.replaceAll('</script', '<\\/script')}</script></body></html>`)
  const compact = page.locator('[data-document-quality-compact]')
  await expect(compact.getByRole('button', { name: '体格检查的记录不一致，请核对。', exact: true })).toBeVisible()
  await expect(compact.getByRole('button', { name: '另有 1 处', exact: true })).toBeVisible()
  await expect(page.getByText('影响', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-document-quality-field]')).toHaveCount(0)
  const readyChecks = checks
  await page.getByRole('button', { name: '查看合成病例B', exact: true }).click()
  await page.getByRole('button', { name: '返回合成病例A', exact: true }).click()
  await page.getByRole('button', { name: '依据与说明', exact: true }).click()
  await expect(page.locator('[data-document-quality-status]')).toHaveAttribute('data-document-quality-status', 'ready')
  expect(checks).toBe(readyChecks)
  await page.keyboard.press('Escape')
  const location = compact.getByRole('button', { name: '体格检查的记录不一致，请核对。', exact: true })
  await location.focus()
  await page.keyboard.press('Enter')
  const examination = page.getByLabel('体格检查', { exact: true })
  await expect(examination).toBeFocused()
  expect(await examination.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('体温36.5℃')
  const detailsButton = page.getByRole('button', { name: '依据与说明', exact: true })
  await detailsButton.focus()
  await page.keyboard.press('Enter')
  const detailsDialog = page.getByRole('dialog', { name: /^(依据与说明|Basis and details)$/ })
  await expect(detailsDialog).toBeVisible()
  expect(await detailsDialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
  const prior = detailsDialog.locator('[data-document-quality-field="allergyHistory"]')
  await expect(prior).toContainText('待补充')
  await expect(detailsDialog.getByText('待补充', { exact: true })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '查看依据', exact: true })).toHaveCount(0)
  await expect(page.locator('blockquote')).toHaveCount(0)
  const verification = detailsDialog.locator('[data-document-quality-field="physicalExamination"]')
  await expect(verification).toContainText('待核实')
  await expect(verification.getByRole('button', { name: '已核实，保留', exact: true })).toHaveCount(0)
  await expect(verification.getByRole('button', { name: '确认保留', exact: true })).toHaveCount(0)
  await expect(verification.getByLabel('保留原因（选填）', { exact: true })).toHaveCount(0)

  for (const locale of ['zh-CN', 'en-US']) for (const fontSize of ['standard', 'larger', 'large']) for (const width of [340, 700]) {
    await page.evaluate(({ locale, fontSize, width }) => {
      document.getElementById('document-quality-host')!.style.width = `${width}px`
      window.dispatchEvent(new CustomEvent('document-quality-appearance', { detail: { locale, fontSize } }))
    }, { locale, fontSize, width })
    await expect(page.locator('[data-clinmesh-app="web"]')).toHaveAttribute('lang', locale)
    await expect(verification.getByText(locale === 'zh-CN' ? '影响' : 'Impact', { exact: true })).toBeVisible()
    await expect(verification.getByText(locale === 'zh-CN' ? '处理建议' : 'Suggested action', { exact: true })).toBeVisible()
    await expect(prior.getByText(locale === 'zh-CN' ? '待补充' : 'Needs completion', { exact: true })).toBeVisible()
    const fields = page.locator('[data-document-quality-field]')
    await expect(fields).toHaveCount(4)
    for (const field of await fields.all()) expect(await field.evaluate(element => {
      if (element.scrollWidth > element.clientWidth) return false
      const box = element.getBoundingClientRect()
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1))) return false
      }
      return true
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(detailsDialog).toHaveCount(0)
  await expect(page.getByText('Needs completion', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'View evidence', exact: true })).toHaveCount(0)
  const chiefComplaint = page.getByLabel('Chief complaint', { exact: true })
  await chiefComplaint.fill('过时病历内容。')
  await expect.poll(() => oldRequested).toBe(true)
  await chiefComplaint.fill('头晕三天。')
  await expect.poll(() => [...states.values()].some(current => current.issues.some(issue => issue.message === '当前草稿的质控提示。'))).toBe(true)
  releaseOld()
  await expect.poll(() => oldSettled).toBe(true)
  await expect(page.getByText('过时质控提示不应显示。', { exact: true })).toHaveCount(0)
  await expect(chiefComplaint).toHaveValue('头晕三天。')
  await expect(chiefComplaint).toBeFocused()
  for (const [text, status] of emptyChecks) {
    await chiefComplaint.fill(text)
    await expect.poll(() => [...states.values()].some(current => current.issues.length === 0
      && (status === 'stale' ? current.stale : current.status === status))).toBe(true)
    await expect(compact).toHaveCount(0)
    await expect(page.locator('[data-document-quality-status]')).toHaveCount(0)
    await expect(page.getByText('合成检查状态说明，不代表检查通过。', { exact: true })).toHaveCount(0)
    await expect(chiefComplaint).toBeFocused()
    await page.getByRole('button', { name: 'Basis and details', exact: true }).click()
    const explanation = page.getByRole('dialog', { name: 'Basis and details', exact: true })
    await expect(explanation.getByText('合成检查状态说明，不代表检查通过。', { exact: true })).toBeVisible()
    await expect(explanation.locator('[data-document-quality-status]')).toHaveAttribute('data-document-quality-status', status)
    await page.keyboard.press('Escape')
    await expect(explanation).toHaveCount(0)
    const previousChecks = checks
    await page.getByRole('button', { name: '查看合成病例B', exact: true }).click()
    await page.getByRole('button', { name: '返回合成病例A', exact: true }).click()
    await page.getByRole('button', { name: 'Basis and details', exact: true }).click()
    await expect(page.locator('[data-document-quality-status]')).toHaveAttribute('data-document-quality-status', status)
    await page.waitForTimeout(650)
    // A stale result requests current sources again; unchanged completed or failed inputs reuse their request.
    expect(checks).toBe(previousChecks + (status === 'stale' ? 1 : 0))
    await page.keyboard.press('Escape')
  }
  await chiefComplaint.fill('头晕三天。')
  await expect(compact).toBeVisible()
  await page.getByRole('button', { name: 'Basis and details', exact: true }).click()
  const currentDetails = page.getByRole('dialog', { name: 'Basis and details', exact: true })
  await expect(currentDetails.locator('[data-document-quality-field="chiefComplaint"]')).toContainText('当前草稿的质控提示。')
  await expect(currentDetails.getByText('过时质控提示不应显示。', { exact: true })).toHaveCount(0)
  await currentDetails.locator('[data-document-quality-field="allergyHistory"]').getByRole('button', { name: 'Go to field', exact: true }).click()
  await expect(currentDetails).toHaveCount(0)
  await expect(page.getByLabel('Allergy history', { exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Sign medical record', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Confirm medical record signature', exact: true })
  const summary = dialog.getByRole('region', { name: 'Quality summary before signing', exact: true })
  await expect(summary.getByRole('region', { name: 'Document quality checks', exact: true })).toHaveCount(1)
  await expect(summary.getByText('Impact', { exact: true })).toHaveCount(0)
  await summary.locator('summary').filter({ hasText: 'Basis and details' }).click()
  await expect(summary).toContainText('Needs verification')
  await expect(dialog.getByText('Needs completion', { exact: true })).toHaveCount(2)
  await expect(summary.getByRole('region', { name: 'Allergy history quality issues', exact: true })).toContainText('过敏史遗漏患者已经陈述的药物过敏信息。')
  await expect(dialog.getByRole('button', { name: 'View evidence', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Verified, keep text', exact: true })).toHaveCount(0)
  const confirm = dialog.getByRole('button', { name: 'Confirm medical record signature', exact: true })
  await expect(confirm).toBeEnabled()
  expect(await dialog.evaluate(element => element.getRootNode() instanceof ShadowRoot)).toBe(true)
  await confirm.click()
  await expect(page.getByLabel('签署结果')).toHaveText('signed')
  expect(errors).toEqual([])
})
