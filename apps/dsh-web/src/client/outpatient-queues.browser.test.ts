import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'
import { buildSurfaceStyles } from '../surface-styles.ts'

const require = createRequire(import.meta.url)
for (const version of ['18', '19']) test.describe(`门诊队列 React ${version}`, () => {
  let script: string
  let styles: string
  test.beforeAll(async () => {
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
      build: { write: false, lib: { entry: fileURLToPath(new URL('./outpatient-queues.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'OutpatientQueueContract' } },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : [])
    const chunk = outputs.find(output => output.type === 'chunk')
    if (chunk?.type !== 'chunk') throw new Error('Missing outpatient queue fixture')
    script = chunk.code
    styles = await buildSurfaceStyles()
  })
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 950 })
    await page.setContent(`<!doctype html><html><head><style>body{margin:0}</style><style>${styles}</style></head><body><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`)
  })
  test('切到完诊保留共享滑块并经过中间帧', async ({ page }) => {
    const list = page.getByRole('tablist', { name: '门诊诊疗' })
    const active = list.getByRole('tab', { name: '在诊', exact: true })
    await expect(active).toHaveAttribute('aria-selected', 'true')
    const indicator = list.locator('[data-slot="tabs-indicator"]')
    await expect(indicator).toBeVisible()
    await expect.poll(() => indicator.evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(Math.round((await active.boundingBox())!.x))
    const original = await indicator.elementHandle()
    const completed = list.getByRole('tab', { name: '完诊', exact: true })
    const sample = completed.evaluate(element => new Promise<{ start: number; end: number; middle: number | undefined; same: boolean; connected: boolean; elapsed: number }>(resolve => {
      const list = element.closest('[data-slot="tabs-list"]')!
      const indicator = list.querySelector('[data-slot="tabs-indicator"]')!
      const root = element.getRootNode() as ShadowRoot
      const start = indicator.getBoundingClientRect().x
      const end = element.getBoundingClientRect().x
      element.addEventListener('click', () => requestAnimationFrame(firstFrame => {
        // Sample rendered frames: timers may run before Chromium advances the animation timeline.
        root.querySelector('[data-slot="tabs-indicator"]')?.getBoundingClientRect()
        const sampleFrame = (time: number) => {
          if (time - firstFrame < 60) { requestAnimationFrame(sampleFrame); return }
          const current = root.querySelector('[data-slot="tabs-indicator"]')
          resolve({ start, end, middle: current?.getBoundingClientRect().x, same: current === indicator, connected: indicator.isConnected, elapsed: time - firstFrame })
        }
        requestAnimationFrame(sampleFrame)
      }), { once: true })
      element.setAttribute('data-motion-ready', 'true')
    }))
    await expect(completed).toHaveAttribute('data-motion-ready', 'true')
    await completed.click()
    const frame = await sample
    await writeFile(test.info().outputPath('slider-60ms.json'), `${JSON.stringify(frame)}\n`)
    await test.info().attach(`滑块60ms-${version}`, { body: JSON.stringify(frame), contentType: 'application/json' })
    expect(frame.same, JSON.stringify(frame)).toBe(true)
    expect(frame.connected).toBe(true)
    expect(frame.middle!).toBeGreaterThan(frame.start + 1)
    expect(frame.middle!).toBeLessThan(frame.end - 1)
    await expect(completed).toBeFocused()
    expect(await original!.evaluate(element => element.isConnected)).toBe(true)
    await expect.poll(() => indicator.evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(Math.round((await list.getByRole('tab', { name: '完诊', exact: true }).boundingBox())!.x))
    const widths = await list.getByRole('tab').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().width)))
    expect(new Set(widths).size).toBe(1)
    await expect(indicator).toHaveCSS('transition-duration', '0.2s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(indicator).toHaveCSS('transition-property', 'none')
    await list.getByRole('tab', { name: '待诊', exact: true }).click()
    await expect(list.getByRole('tab', { name: '待诊', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(list.getByRole('tab', { name: '待诊', exact: true })).toBeFocused()
  })
  test('完整队列号码、输入范围与问诊状态在真实渲染中清晰可用', async ({ page }) => {
    for (const mode of ['row', 'triage', 'pharmacy']) {
      await page.locator('[data-outpatient-fixture-host]').evaluate(element => { element.style.width = '826px' })
      await page.getByRole('button', { name: mode, exact: true }).click()
      const row = page.locator('[data-queue-patient-row]').first()
      await expect(row).toBeVisible()
      const number = mode === 'pharmacy' ? 'CM-RX-20261104-000001' : 'CM-OP-20261104-000001'
      await expect(row).toContainText(number)
      const numberText = mode === 'pharmacy' ? row.getByText(number, { exact: true }) : row.locator('[data-registration-number-value]')
      expect(await numberText.evaluate(element => {
        const rect = element.closest('[data-queue-patient-row]')!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(element)
        return [...range.getClientRects()].every(text => text.left >= rect.left && text.right <= rect.right && text.top >= rect.top && text.bottom <= rect.bottom)
      })).toBe(true)
      if (mode === 'row') await expect(row.getByRole('img')).toHaveCount(0)
      if (mode !== 'pharmacy') {
        const copy = row.getByRole('button', { name: `复制门诊号 ${number}`, exact: true })
        const card = (await row.boundingBox())!
        const button = (await copy.boundingBox())!
        expect(button.x + button.width).toBeLessThanOrEqual(card.x + card.width)
        if (mode === 'row') {
          await copy.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) } }))
          await copy.click()
          await expect(row.getByRole('alert')).toHaveText('复制失败，请手动选择门诊号复制')
        }
      }
      if (mode === 'triage') {
        const input = page.getByLabel('体温（°C）', { exact: true })
        await expect(input).toHaveAccessibleDescription('可录入范围： 30–45')
        await expect(input).toHaveAttribute('min', '30')
        await expect(input).toHaveAttribute('max', '45')
        await expect(input).toHaveAttribute('step', '0.1')
        expect(await input.evaluate(element => {
          const input = element.getBoundingClientRect()
          const range = element.parentElement!.querySelector('[data-slot="field-description"]')!.getBoundingClientRect()
          const style = getComputedStyle(element)
          const context = document.createElement('canvas').getContext('2d')!
          context.font = style.font
          const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          return range.top >= input.top && range.bottom <= input.bottom && range.right < input.right && available > context.measureText('37.0').width
        })).toBe(true)
        await input.fill('46')
        await expect(input).toHaveAccessibleDescription(/请输入30–45范围内的有效数值/)
        await expect(input).toHaveAttribute('aria-invalid', 'true')
      }
    }
    await page.getByRole('button', { name: 'consultation', exact: true }).click()
    const input = page.getByRole('textbox', { name: '向患者提问', exact: true })
    const composer = page.getByRole('group', { name: '向患者提问', exact: true })
    const send = page.getByRole('button', { name: '向患者提问', exact: true })
    await expect(input).toBeEnabled()
    await expect(send).toBeDisabled()
    await expect(composer).toHaveCSS('border-top-style', 'solid')
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: '切换主题', exact: true }).click()
      const cardBackground = await composer.evaluate(element => getComputedStyle(element.parentElement!.closest('.bg-card')!).backgroundColor)
      await expect(composer).toHaveCSS('background-color', cardBackground)
      await input.fill('还有哪些不舒服？')
      await expect(send).toBeEnabled()
      const doctor = page.locator('[data-agent-consultation-message="turn-1"] [data-slot="bubble-content"]')
      const patient = page.locator('[data-agent-consultation-message="turn-0"] [data-slot="bubble-content"]')
      const [doctorBox, patientBox] = await Promise.all([doctor.boundingBox(), patient.boundingBox()])
      expect(doctorBox!.x).toBeGreaterThan(patientBox!.x + 30)
      const background = (element: Element) => getComputedStyle(element).backgroundColor
      expect(await doctor.evaluate(background)).toBe(await send.evaluate(background))
      expect(await patient.evaluate(background)).not.toBe(await doctor.evaluate(background))
    }
    await send.click()
    await expect(input).toBeDisabled()
    await expect(page.getByRole('button', { name: '正在等待患者回答', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '切换只读', exact: true }).click()
    await expect(input).toHaveCount(0)
  })
})
