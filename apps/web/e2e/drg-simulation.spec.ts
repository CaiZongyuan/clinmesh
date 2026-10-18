import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { createDrgReferenceFixture } from '../../server/tests/fixtures/drg-reference.ts'

const test = base.extend({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-browser-'))
    try {
      const reference = await createDrgReferenceFixture(directory)
      const app = await startBrowserServer(webRoot, { referenceDatabasePath: reference.databasePath })
      try { await use(app) } finally { await app.close() }
    } finally { await rm(directory, { force: true, recursive: true }) }
  },
})

async function enter(page: Page, app: { origin: string, password: string }) {
  await page.goto(`${app.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(app.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '住院 DRG 模拟', exact: true }).click()
  await expect(page.getByRole('heading', { name: '住院 DRG 动态模拟' })).toBeVisible()
}

test('医生在实际入口开具、确认并发症、刷新并查看固定版本费用', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await enter(page, browserApp)
  await page.getByRole('button', { name: '新建合成住院病例' }).click()
  const assessment = page.getByLabel('费用评估', { exact: true })
  await expect(assessment.getByText('¥10,000.00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '加入本次草稿' }).click()
  await page.getByLabel('计价总数量（盒）').fill('2')
  await page.getByLabel('疗程（天）').fill('7')
  await expect(assessment.getByText('¥3,625.00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开具前预览', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '开具前费用预览' })
  await expect(dialog.getByText('¥25.00', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '继续模拟开具' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(assessment.getByText('¥2,425.00', { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'J96.000 急性呼吸衰竭', exact: true }).check()
  await expect(page.getByText('待确认推演', { exact: true })).toBeVisible()
  await expect(assessment.getByText('¥10,000.00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认临床变化并重新分组' }).click()
  await expect(assessment.getByText('¥18,000.00', { exact: true })).toBeVisible()
  await expect(assessment.getByText('¥2,425.00', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '住院 DRG 模拟', exact: true }).click()
  await expect(assessment.getByText('¥18,000.00', { exact: true })).toBeVisible()
  await expect(assessment.getByText('¥2,425.00', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByText('评估历史与固定版本', { exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByText('评估历史与固定版本', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('来源记录可定位查看，未定价项目显示不完整', async ({ page, browserApp }) => {
  await enter(page, browserApp)
  await page.getByRole('tab', { name: '参考数据与模拟映射' }).click()
  await page.getByLabel('编码或名称').fill('J18.900')
  await page.getByRole('button', { name: '查询来源记录' }).click()
  const record = page.locator('details').filter({ has: page.locator('summary', { hasText: 'J18.900 肺炎' }) })
  await record.locator('summary').click()
  await expect(record.locator('pre')).toContainText('pdfPage')
  await page.getByRole('tab', { name: '病例与费用' }).click()
  await page.getByRole('button', { name: '新建合成住院病例' }).click()
  await page.getByLabel('院内模拟项目').click()
  await page.getByRole('option', { name: '奥美拉唑（价格待补全示例） · 盒' }).click()
  await page.getByRole('button', { name: '加入本次草稿' }).click()
  await expect(page.getByLabel('费用评估').getByText('数据不完整', { exact: true })).toBeVisible()
  await expect(page.getByLabel('费用评估').getByText('不完整', { exact: true })).toBeVisible()
})
