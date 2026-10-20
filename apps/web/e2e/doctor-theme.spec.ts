import { expect, test } from './fixtures.ts'

test('workspace theme toggle applies dark tokens to the application subtree and persists the choice', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '候诊队列' })).toBeVisible()
  const workspace = page.locator('.clinmesh-web-root')
  await expect(workspace).toBeVisible()
  // 测试浏览器默认浅色系统偏好：初始渲染为亮色 token。
  await expect(workspace).not.toHaveClass(/dark/)
  const lightBackground = await workspace.evaluate(element => getComputedStyle(element).backgroundColor)
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('region', { name: '外观' }).getByLabel('暗色').click()
  await page.goto(`${browserApp.origin}/consultation`)
  // 深色 token 作用于应用子树；standalone 同时在 <html> 保留 class 供 no-flash 启动脚本使用。
  await expect(workspace).toHaveClass(/dark/)
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
  const darkBackground = await workspace.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(darkBackground).not.toBe(lightBackground)
  // 偏好持久化：刷新后保持暗色。
  await page.reload()
  await expect(workspace).toHaveClass(/dark/)
  // 恢复亮色，避免影响同浏览器 profile 的其他用例。
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('region', { name: '外观' }).getByLabel('亮色').click()
  await expect(workspace).not.toHaveClass(/dark/)
})
