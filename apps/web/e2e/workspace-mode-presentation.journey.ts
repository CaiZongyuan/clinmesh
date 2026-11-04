import { expect, type Page } from '@playwright/test'

export async function runWorkspaceModePresentation(page: Page, app: { origin: string; password: string }, surface?: {
  mount(): Promise<void>
  appearance(theme: 'light' | 'dark'): Promise<void>
}) {
  for (const role of ['cashier', 'pharmacist']) {
    const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin }, data: { email: `${role}@demo.clinmesh.local`, password: app.password },
    })
    expect(login.status()).toBe(200)
    for (const [width, theme] of [[1101, 'light'], [826, 'dark']] as const) {
      await page.setViewportSize({ width, height: 900 })
      if (surface) {
        await surface.mount()
        await surface.appearance(theme)
      } else {
        await page.goto(`${app.origin}/${role === 'cashier' ? 'billing' : 'pharmacy'}`)
        await page.getByRole('button', { name: '用户菜单' }).click()
        await page.getByRole('menuitemradio', { name: theme === 'dark' ? '暗色' : '亮色', exact: true }).click()
        await page.keyboard.press('Escape')
      }
      const mode = page.getByRole('combobox', { name: '门诊与住院', exact: true })
      await expect(mode).toBeVisible()
      await expect(mode).toContainText('门诊')
      const shape = await mode.evaluate(element => {
        const css = getComputedStyle(element)
        return [css.height, css.borderRadius, css.borderStyle, css.fontSize]
      })
      for (const destination of ['住院', '门诊']) {
        await mode.click()
        await page.getByRole('option', { name: destination, exact: true }).click()
        await expect(mode).toBeVisible()
        await expect(mode).toContainText(destination)
        await expect(page.getByRole('group', { name: '门诊与住院', exact: true })).toHaveCount(0)
        expect(await mode.evaluate(element => {
          const css = getComputedStyle(element)
          return [css.height, css.borderRadius, css.borderStyle, css.fontSize]
        })).toEqual(shape)
      }
    }
  }
}
