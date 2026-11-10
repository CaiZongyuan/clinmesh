import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { openWorkspaceTab } from '../../../web/e2e/workspace-tabs.fixture.ts'
import { readJsonFromBrowser } from '../../../../scripts/browser-contract.ts'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) {
  test(`检查详情事实表与短目录按内容收缩，长目录保留密度和双栏滚动 React ${version}`, async ({ page }) => {
    const react = version === '18' ? 'react18' : 'react'
    const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({ configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] }, build: { write: false, lib: {
        entry: fileURLToPath(new URL('./diagnosis-prescription.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'InvestigationDetailPolish',
      } } })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : [])
    const script = outputs.find(output => output.type === 'chunk')
    if (script?.type !== 'chunk') throw new Error('Missing investigation detail fixture')
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
    await page.goto('http://localhost/')
    await page.setViewportSize({ width: 1101, height: 900 })
    await readJsonFromBrowser(page, `<!doctype html><html data-fixture-mode="polish"><head><style>body{margin:0}</style><style data-fixture>${await buildSurfaceStyles()}</style></head><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    await page.evaluate(() => { document.getElementById('diagnosis-prescription-host')!.style.width = '1101px' })
    await page.getByRole('button', { name: /合成浏览器患者/ }).click()
    await openWorkspaceTab(page, '检验检查')
    await page.getByRole('button', { name: '添加检验', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择检验项目', exact: true })
    const catalog = dialog.locator('[data-order-catalog]')
    const visibleRows = await catalog.locator('ul > li').evaluateAll(elements => elements.filter(element => {
      const row = element.getBoundingClientRect()
      let ancestor = element.parentElement
      while (ancestor) {
        if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(ancestor).overflowY)) {
          const box = ancestor.getBoundingClientRect()
          if (row.top < box.top - 1 || row.bottom > box.bottom + 1) return false
        }
        ancestor = ancestor.parentElement
      }
      return true
    }).length)
    expect(visibleRows).toBeGreaterThanOrEqual(11)
    await expect.poll(async () => Math.round((await dialog.boundingBox())?.height ?? 0)).toBe(720)
    const tallHeight = (await dialog.boundingBox())!.height
    await catalog.getByRole('textbox', { name: '搜索检验目录', exact: true }).fill('合成完整')
    await expect(catalog.locator('ul > li')).toHaveCount(1)
    await catalog.getByRole('button', { name: /选择 合成完整检验组合/ }).click()
    const details = dialog.locator('[data-order-details]')
    await expect(details.getByRole('heading', { name: '合成完整检验组合与扩展指标名称', exact: true })).toBeVisible()
    const facts = details.locator('dl')
    await expect(facts.getByText('门诊价格', { exact: true })).toBeVisible()
    await expect(facts.getByText('合成静脉血标本', { exact: true })).toBeVisible()
    expect(await facts.getByText('标本', { exact: true }).evaluate(element => {
      const label = element.getBoundingClientRect(), value = element.nextElementSibling!.getBoundingClientRect()
      return Math.abs(label.y - value.y) < 2 && value.x > label.right
    })).toBe(true)
    expect((await dialog.boundingBox())!.height).toBeCloseTo(tallHeight, 0)
    if (version === '19' && process.env.CLINMESH_CAPTURE_OUTPATIENT_DETAILS === '1') await dialog.screenshot({ path: test.info().outputPath('outpatient-laboratory-detail.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 826, height: 760 })
    await page.evaluate(() => {
      const host = document.getElementById('diagnosis-prescription-host')!
      host.style.width = '826px'
      host.style.height = '760px'
    })
    await expect(dialog.getByRole('button', { name: '加入检验', exact: true })).toBeInViewport()
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    for (const item of [
      { tab: /^放射检查 \d+$/, trigger: '添加放射检查', title: '选择放射检查', name: '胸部 CT 平扫', code: 'CT-CHEST-PLAIN', field: '检查指征' },
      { tab: /^病理会诊 \d+$/, trigger: '添加病理会诊', title: '选择病理会诊', name: '乳腺切片病理会诊', code: 'PATH-BREAST-SLIDE-CONSULT', field: '会诊目的' },
    ]) {
      await page.getByRole('tab', { name: item.tab }).click()
      await page.getByRole('button', { name: item.trigger, exact: true }).click()
      const current = page.getByRole('dialog', { name: item.title, exact: true })
      await current.locator('[data-order-catalog]').getByRole('button', { name: new RegExp(item.name) }).click()
      await expect(current.locator('[data-order-details]').getByRole('heading', { name: item.name, exact: true })).toBeVisible()
      await expect(current.locator('[data-order-details]').getByText(item.code, { exact: true })).toBeVisible()
      await expect(current.locator('dl').getByText('门诊价格', { exact: true })).toBeVisible()
      expect((await current.boundingBox())!.height).toBeLessThanOrEqual(721)
      await current.getByLabel(item.field, { exact: true }).fill('结合已核实的临床资料评估')
      if (version === '19' && process.env.CLINMESH_CAPTURE_OUTPATIENT_DETAILS === '1') await current.screenshot({ path: test.info().outputPath(`outpatient-${item.code}-detail.png`), animations: 'disabled' })
      const close = current.getByRole('button', { name: item.title === '选择放射检查' || item.title === '选择病理会诊' ? '关闭' : '取消', exact: true })
      await expect(close).toBeInViewport()
      await close.click()
    }
    if (version === '19' && process.env.CLINMESH_CAPTURE_OUTPATIENT_DETAILS === '1') await page.locator('.clinmesh-card-workspace').screenshot({ path: test.info().outputPath('outpatient-doctor-workspace.png'), animations: 'disabled' })
  })
}
