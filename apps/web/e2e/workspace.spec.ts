import { sessionContextSchema } from '@clinmesh/contracts/his'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

async function signIn(page: Page, origin: string, email: string, password: string, path = '/') {
  await page.goto(`${origin}${path}`)
  await expect(page.getByRole('heading', { name: '登录科灵脉智' })).toBeVisible()
  await page.getByLabel('账户邮箱').fill(email)
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('a registrar signs in from a deep link, retains the session on reload and signs out', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await signIn(page, browserApp.origin, 'registrar@demo.clinmesh.local', browserApp.password, '/registration')
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '分诊护理', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '门诊收费', exact: true })).toHaveCount(0)
  const response = await page.request.get(`${browserApp.origin}/api/auth/context`)
  expect(response.status()).toBe(200)
  expect(sessionContextSchema.parse(await response.json()).actor.roleCode).toBe('registrar')
  await page.reload()
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '登录科灵脉智' })).toBeVisible()
  expect((await page.request.get(`${browserApp.origin}/api/auth/context`)).status()).toBe(401)
  expect(errors).toEqual([])
})

test('an administrator switches the server-bound role and restores it after reload', async ({ page, browserApp }) => {
  await signIn(page, browserApp.origin, 'admin@demo.clinmesh.local', browserApp.password)
  await expect(page.getByRole('heading', { name: '模拟数据', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitemradio', { name: '挂号员 · 挂号员', exact: true }).click()
  await expect(page).toHaveURL(`${browserApp.origin}/registration`)
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  const response = await page.request.get(`${browserApp.origin}/api/auth/context`)
  expect(response.status()).toBe(200)
  expect(sessionContextSchema.parse(await response.json()).actor.roleCode).toBe('registrar')
  await page.reload()
  await expect(page.getByRole('heading', { name: '门诊挂号', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '用户菜单' }).click()
  await page.getByRole('menuitemradio', { name: '管理员 · 管理员', exact: true }).click()
  await expect(page).toHaveURL(`${browserApp.origin}/scenario-data`)
  await expect(page.getByRole('heading', { name: '模拟数据', exact: true })).toBeVisible()
})

test('theme and font size persist on a narrow viewport', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, browserApp.origin, 'registrar@demo.clinmesh.local', browserApp.password, '/settings')
  await expect(page.getByRole('button', { name: '大', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '大', exact: true }).click()
  await page.getByRole('button', { name: '暗色', exact: true }).click()
  const root = page.locator('.clinmesh-web-root')
  await expect(root).toHaveAttribute('data-font-size', 'large')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(root).toHaveCSS('font-size', '16.25px')
  await page.reload()
  await expect(root).toHaveAttribute('data-font-size', 'large')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: '大', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
