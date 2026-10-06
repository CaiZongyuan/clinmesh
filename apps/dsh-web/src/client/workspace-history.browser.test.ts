import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)

for (const version of ['18', '19']) {
  test(`keeps workspace history reachable and keyboard usable with React ${version}`, async ({ page }) => {
    const react = version === '18' ? 'react18' : 'react'
    const reactDom = version === '18' ? 'react-dom18' : 'react-dom'
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic', jsxDev: false },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [
        { find: /^react$/, replacement: require.resolve(react) },
        { find: 'react/jsx-runtime', replacement: require.resolve(`${react}/jsx-runtime`) },
        { find: 'react-dom/client', replacement: require.resolve(`${reactDom}/client`) },
        { find: /^react-dom$/, replacement: require.resolve(reactDom) },
      ] },
      build: {
        write: false,
        lib: { entry: fileURLToPath(new URL('./workspace-history.browser.fixture.tsx', import.meta.url)), formats: ['iife'], name: 'WorkspaceHistoryContract' },
      },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => {
      if (!('output' in output)) throw new Error('Unexpected browser build watcher')
      return output.output
    })
    const script = outputs.find((output) => output.type === 'chunk')
    if (!script || script.type !== 'chunk') throw new Error('Missing workspace history browser fixture')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1000, height: 700 })
    await page.setContent(`<!doctype html><html><body><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>`)
    const trigger = page.getByRole('button', { name: '会话历史', exact: true })
    const panel = page.getByRole('dialog', { name: '工作区与会话', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(panel).toBeVisible()
    await expect(page.getByRole('combobox', { name: '选择工作区' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole('button', { name: '合成门诊讨论', exact: true }).focus()
    await page.keyboard.press('Tab')
    const rowActions = page.getByRole('button', { name: '合成门诊讨论的操作', exact: true })
    await expect(rowActions).toBeFocused()
    await page.keyboard.press('Enter')
    const rename = page.getByRole('button', { name: '重命名', exact: true })
    await expect(rename).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(rename).toHaveCount(0)
    await expect(rowActions).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rename).toBeFocused()
    await page.keyboard.press('Enter')
    const form = page.getByRole('dialog', { name: '重命名会话', exact: true })
    const name = page.getByRole('textbox', { name: '会话名称' })
    await expect(name).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(form.getByRole('button', { name: '保存', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(name).toBeFocused()
    await name.fill('取消的合成名称')
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(page.getByRole('button', { name: '合成门诊讨论', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await trigger.click()
    const advanced = page.getByRole('button', { name: '更多选项', exact: true })
    await advanced.focus()
    await page.keyboard.press('Enter')
    const addWorkspace = page.getByRole('button', { name: '新增工作区', exact: true })
    await expect(addWorkspace).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(addWorkspace).toHaveCount(0)
    await expect(advanced).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()

    for (const viewport of [{ width: 1000, height: 700 }, { width: 360, height: 480 }]) {
      await page.setViewportSize(viewport)
      for (const nativeLabel of ['宿主右栏', '宿主文件', '宿主更多']) {
        const native = page.getByRole('button', { name: nativeLabel, exact: true })
        const nativeBounds = await native.boundingBox()
        expect(nativeBounds).not.toBeNull()
        for (const control of [trigger, page.getByRole('button', { name: '新会话', exact: true })]) {
          const bounds = await control.boundingBox()
          expect(bounds).not.toBeNull()
          const overlaps = bounds!.x < nativeBounds!.x + nativeBounds!.width && bounds!.x + bounds!.width > nativeBounds!.x &&
            bounds!.y < nativeBounds!.y + nativeBounds!.height && bounds!.y + bounds!.height > nativeBounds!.y
          expect(overlaps, `会话入口必须让出${nativeLabel}`).toBe(false)
        }
        await native.click()
      }
      for (const background of ['rgb(250, 250, 250)', 'rgb(30, 35, 40)']) {
        await trigger.click()
        await expect(panel).toBeVisible()
        expect(await panel.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(background)
        const bounds = await panel.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
        await page.getByRole('searchbox', { name: '搜索会话' }).fill('合成')
        await expect(page.getByRole('button', { name: '合成门诊讨论', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(trigger).toBeFocused()
        await page.getByRole('button', { name: '切换主题', exact: true }).click()
      }
    }

    await trigger.click()
    await page.getByRole('button', { name: '卸载插件', exact: true }).click()
    await expect(trigger).toHaveCount(0)
    await expect(panel).toHaveCount(0)
    await expect(page.locator('style[data-clinmesh-history-styles]')).toHaveCount(0)
    await expect(page.getByLabel('插件释放状态')).toHaveText('已释放')
    expect(errors).toEqual([])
  })
}
