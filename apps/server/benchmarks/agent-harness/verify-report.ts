import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const reportPath = resolve(REPO_ROOT, 'benchmarks', 'agent-harness', 'report.html')
const outDir = process.argv[2] ?? resolve(REPO_ROOT, 'benchmarks', 'agent-harness', 'screenshots')

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  try {
    await page.goto(pathToFileURL(reportPath).href, { waitUntil: 'load' })
    await page.waitForTimeout(300)

    // 1. Light Overview
    await page.click('[data-theme-set="light"]')
    await page.waitForTimeout(150)
    await page.screenshot({ path: resolve(outDir, 'report-overview-light.png'), fullPage: true })

    // Verify interactive filters & metric switcher
    await page.click('[data-effort-filter="off"]')
    await page.selectOption('#bar-metric-select', 'totalTokens')
    await page.waitForTimeout(120)
    const rowsOff = await page.locator('#runs-tbody tr').count()

    await page.click('[data-effort-filter="low"]')
    await page.waitForTimeout(120)
    const rowsLow = await page.locator('#runs-tbody tr').count()

    await page.click('[data-effort-filter="all"]')
    await page.selectOption('#bar-metric-select', 'turn1InputTokens')
    await page.waitForTimeout(120)

    // 2. Matrix tab (Light)
    await page.click('#tab-matrix')
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(outDir, 'report-matrix-light.png'), fullPage: true })

    // 3. Frontend tab (Dark)
    await page.click('[data-theme-set="dark"]')
    await page.click('#tab-frontend')
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(outDir, 'report-frontend-dark.png'), fullPage: true })

    // 4. Jump via matrix cell click into Inspector (Dark)
    await page.click('#tab-matrix')
    await page.waitForTimeout(120)
    await page.locator('#backend-matrix button[data-jump-run*="B6-hybrid-codemode__T3"]').first().click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: resolve(outDir, 'report-inspector-dark.png'), fullPage: true })

    // 5. Methodology tab & keyboard roving tabindex check
    await page.click('#tab-method')
    await page.waitForTimeout(120)
    const tabSelected = await page.getAttribute('#tab-method', 'aria-selected')
    const svgsCount = await page.locator('svg').count()
    const rowsAll = await page.locator('#runs-tbody tr').count()

    console.log(JSON.stringify({
      consoleErrors,
      pageErrors,
      rowsAll,
      rowsOff,
      rowsLow,
      svgsCount,
      tabSelected,
      screenshotsDir: outDir,
    }, null, 2))

    if (consoleErrors.length > 0 || pageErrors.length > 0 || rowsAll !== 48 || rowsOff !== 24 || rowsLow !== 24) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
