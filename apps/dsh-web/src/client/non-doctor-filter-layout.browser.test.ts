import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { startBrowserServer } from '../../../server/tests/browser-server.ts'
import { buildNonDoctorCard, mountNonDoctorCard } from './non-doctor-card.browser.artifact.ts'

for (const version of ['18', '19']) test.describe(`role filters on React ${version}`, () => {
  test.beforeAll(async () => { await buildNonDoctorCard(version) })
  for (const role of ['registrar', 'pharmacist'] as const) for (const width of [720, 400, 944]) for (const locale of role === 'registrar' && width === 720 ? ['en-US', 'zh-CN'] as const : ['en-US'] as const) {
    const fontSize = locale === 'en-US' ? 'large' : 'normal'
    test(`${role} keeps full filter text visible and pointer reachable at ${width} ${locale} ${fontSize}`, async ({ page }) => {
      const server = await startBrowserServer(fileURLToPath(new URL('../../../web/', import.meta.url)))
      try {
        await page.setViewportSize({ width, height: 900 })
        await mountNonDoctorCard(page, version, server, role, {}, { locale })
        const labels = role === 'registrar'
          ? locale === 'zh-CN' ? ['待挂号', '检索', '建档'] as const : ['Awaiting registration', 'Search', 'Create record'] as const
          : ['Pending', 'Dispensed'] as const
        const tabs = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: labels[0], exact: true }) })
        await expect(tabs).toBeVisible()
        await page.locator('.clinmesh-web-root').evaluate((element, options) => {
          element.setAttribute('data-font-size', options.fontSize)
          const tree = element.getRootNode()
          if (!(tree instanceof ShadowRoot) || !(tree.host instanceof HTMLElement)) throw new Error('Expected Surface host')
          tree.host.style.width = `${options.width}px`
        }, { width, fontSize })
        // 800px 以下队列收起为浮层，筛选页签在队列里。
        if (width < 800) await page.getByRole('button', { name: locale === 'zh-CN' ? '展开队列' : 'Show queue', exact: true }).click()
        await expect(tabs.getByRole('tab').first()).toHaveCSS('font-size', fontSize === 'large' ? '17.5px' : '14px')
        const measurements = await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const text = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
          const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
          let ancestor: Element | null = element.parentElement
          while (ancestor !== null) {
            const style = getComputedStyle(ancestor)
            const box = ancestor.getBoundingClientRect()
            if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
              clip.left = Math.max(clip.left, box.left + ancestor.clientLeft)
              clip.right = Math.min(clip.right, box.left + ancestor.clientLeft + ancestor.clientWidth)
            }
            if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
              clip.top = Math.max(clip.top, box.top + ancestor.clientTop)
              clip.bottom = Math.min(clip.bottom, box.top + ancestor.clientTop + ancestor.clientHeight)
            }
            const tree = ancestor.getRootNode()
            ancestor = ancestor.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null)
          }
          const tree = element.getRootNode()
          const hit = (x: number, y: number) => element.contains(tree instanceof ShadowRoot ? tree.elementFromPoint(x, y) : document.elementFromPoint(x, y))
          return { label: element.textContent, clip, button: element.getBoundingClientRect().toJSON(),
            text: text.map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
              x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2,
              hits: [rect.left + 1, (rect.left + rect.right) / 2, rect.right - 1].map(x => hit(x, (rect.top + rect.bottom) / 2)) })) }
        }))
        const evidence = test.info().outputPath('filter-visibility.json')
        await writeFile(evidence, JSON.stringify({ role, width, version, locale, fontSize, measurements }, null, 2))
        await test.info().attach('filter-visibility', { path: evidence, contentType: 'application/json' })
        for (const [index, label] of labels.entries()) {
          const measured = measurements[index]!
          if (locale === 'zh-CN') expect(measured.text).toHaveLength(1)
          if (label === 'Search') expect(measured.text).toHaveLength(1)
          if (label === 'Awaiting registration') expect(measured.text.length).toBeLessThanOrEqual(2)
          const firstLine = measured.text[0]!
          await page.mouse.click(firstLine.x, firstLine.y)
          const tab = tabs.getByRole('tab', { name: label, exact: true })
          await expect(tab).toBeFocused()
          await expect(tab).toHaveAttribute('aria-selected', 'true')
          for (const text of measured.text) {
            expect(text.left).toBeGreaterThanOrEqual(measured.clip.left)
            expect(text.right).toBeLessThanOrEqual(measured.clip.right)
            expect(text.top).toBeGreaterThanOrEqual(measured.clip.top)
            expect(text.bottom).toBeLessThanOrEqual(measured.clip.bottom)
            expect(text.hits).toEqual([true, true, true])
          }
        }
        if (role === 'registrar') {
          await page.keyboard.press('Home')
          await expect(tabs.getByRole('tab', { name: labels[0], exact: true })).toBeFocused()
          for (const label of labels.slice(1)) {
            await page.keyboard.press('ArrowRight')
            const tab = tabs.getByRole('tab', { name: label, exact: true })
            await expect(tab).toBeFocused()
            await page.keyboard.press('Enter')
            await expect(tab).toHaveAttribute('aria-selected', 'true')
          }
        }
      } finally { await server.close() }
    })
  }
})
