import { join } from 'node:path'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

test('Step 3.5: default theme parity, Left Primary Rail multi-space switching, Research->Chat handoff, Personal Agent memory CRUD, searchable Settings, multi-theme + Safe Mode, and Ctrl+K Command Palette', async ({ page, webRoot }) => {
  const captureDir = process.env.CLINMESH_CAPTURE_DIR
  const maybeShot = async (name: string) => {
    if (captureDir) {
      await page.screenshot({ path: join(captureDir, `${name}.png`), fullPage: false })
    }
  }

  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  const server = await startBrowserServer(webRoot, {
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: {
      async completeJson(input) {
        if (input.schemaName === 'patient_persona') {
          return { content: JSON.stringify(persona), model: input.model }
        }
        throw new Error('Unexpected direct provider call')
      },
    },
  })

  try {
    await startConsultationCase(server.runtime, server.password, server.origin)

    // 1. Sign in as outpatient doctor & verify exact default ClinMesh theme parity
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await expect(page.getByRole('complementary', { name: '候诊队列' })).toBeVisible()
    // Reset console errors collected during the expected pre-login 401 /api/auth/context check.
    consoleErrors.length = 0
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'default')
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light')
    const defaultBg = await page.locator('.clinmesh-web-root').evaluate(el => getComputedStyle(el).backgroundColor)
    expect(defaultBg).toBe('rgb(245, 246, 247)')
    await maybeShot('01-clinical-default-rail')

    // 2. Verify Left Primary Rail defaults to slim 60px rail and expands/collapses cleanly
    const rail = page.locator('[data-cm="app-rail"]')
    await expect(rail).toBeVisible()
    await expect(rail).toHaveAttribute('data-rail-mode', 'rail')
    const slimWidth = await rail.evaluate(el => Math.round(el.getBoundingClientRect().width))
    expect(slimWidth).toBeGreaterThanOrEqual(52)
    expect(slimWidth).toBeLessThanOrEqual(68)

    await rail.getByRole('button', { name: '展开左侧主导航栏' }).click()
    await expect(rail).toHaveAttribute('data-rail-mode', 'expanded')
    const expandedWidth = await rail.evaluate(el => Math.round(el.getBoundingClientRect().width))
    expect(expandedWidth).toBeGreaterThanOrEqual(180)
    await maybeShot('02-clinical-expanded-rail')
    await rail.getByRole('button', { name: '折叠为极窄图标轨' }).click()
    await expect(rail).toHaveAttribute('data-rail-mode', 'rail')

    // 3. Enable Mock Mode in Settings -> Models so fullscreen /chat can run deterministic pi-durable turns
    await rail.getByRole('button', { name: '设置中心' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings`)
    await page.getByRole('link', { name: '模型与服务商' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings/models`)
    await page.getByRole('switch', { name: '演示 / Mock 模式' }).click()
    await expect(page.locator('[data-clinmesh-mock-badge]')).toBeVisible()

    // 4. Switch to Personal Agent space (/agents) and test real /api/agents/memory CRUD
    await rail.getByRole('button', { name: '个人智能体' }).click()
    await expect(page).toHaveURL(`${server.origin}/agents`)
    await expect(page.getByRole('heading', { level: 1, name: '个人智能体工作台' })).toBeVisible()
    await maybeShot('03-personal-agent-space')

    await page.getByRole('button', { name: /偏好记忆/ }).click()
    const memoryText = 'E2E 记忆：门诊复诊优先核查近期肝肾功能'
    await page.getByLabel('新增医生工作偏好记忆').fill(memoryText)
    await page.getByRole('button', { name: '添加记忆', exact: true }).click()
    await expect(page.getByText(memoryText)).toBeVisible()
    await page.getByRole('button', { name: /^删除记忆：/ }).first().click()
    await expect(page.getByText(memoryText)).toHaveCount(0)

    // 5. Switch to Clinical Research space (/research), test Interactive DataTable selection + Batch Bar, and hand off to /chat
    await rail.getByRole('button', { name: '临床科研' }).click()
    await expect(page).toHaveURL(`${server.origin}/research`)
    await expect(page.getByRole('heading', { level: 1, name: '临床科研' })).toBeVisible()
    await expect(page.getByText('张琴').first()).toBeVisible()
    // Select first patient row to verify floating DataTableBatchBar
    await page.getByRole('checkbox', { name: /^选择行 / }).first().click()
    await expect(page.locator('[data-cm="data-table-batch-bar"]')).toBeVisible()
    await maybeShot('04-research-space')

    await page.getByRole('button', { name: '分析所选子队列' }).click()
    await expect(page).toHaveURL(`${server.origin}/chat`)
    await expect(page.getByRole('heading', { level: 1, name: '全屏聊天' })).toBeVisible()
    const chatComposer = page.getByLabel('向临床助手提问')
    await expect(chatComposer).toHaveValue(/合成患者队列/)
    await page.getByRole('button', { name: '发送临床助手消息', exact: true }).click()
    await expect(page.getByText(/Mock 模式/).first()).toBeVisible({ timeout: 10_000 })
    await maybeShot('05-chat-space')

    // 6. Searchable Settings Center (with clear & keyboard), Space Last-URL Memory, UI Components Sink, Shortcuts, multi-theme, Safe Mode, and "← 返回工作台"
    // First click on Settings restores the last visited settings sub-route (/settings/models from Step 3)
    await rail.getByRole('button', { name: '设置中心' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings/models`)
    await expect(page.locator('[data-cm="settings-back-to-app"]')).toBeVisible()
    // Clicking the already-active Settings rail button resets to /settings root
    await rail.getByRole('button', { name: '设置中心' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings`)
    await maybeShot('06-settings-appearance-default')

    // Open UI Components catalog and verify Interactive UI-SDK Sink renders cleanly
    await page.getByRole('link', { name: 'UI 组件' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings/developer/components`)
    const sinkHeading = page.getByRole('heading', { level: 2, name: /交互组件工作坊/ })
    await expect(sinkHeading).toBeVisible()
    await sinkHeading.scrollIntoViewIfNeeded()
    await expect(page.getByRole('grid', { name: '检验趋势对比网格' })).toBeVisible()
    await maybeShot('09-component-catalog-sink')

    // Search Settings using keyboard ArrowDown + Enter to reach Shortcuts
    const settingsSearch = page.getByLabel('搜索设置项')
    await settingsSearch.fill('快捷键')
    await settingsSearch.press('Enter')
    await expect(page).toHaveURL(`${server.origin}/settings/shortcuts`)
    await expect(page.getByRole('heading', { level: 1, name: '快捷键' })).toBeVisible()
    await expect(page.getByText('医疗安全边界')).toBeVisible()

    // Back to General / Appearance settings
    await page.getByRole('link', { name: '通用' }).click()
    await expect(page).toHaveURL(`${server.origin}/settings`)

    // Open Theme Picker, hover to verify live preview, then click to apply quiet-studio
    await page.getByRole('button', { name: '选择界面主题' }).click()
    const quietOption = page.getByRole('button', { name: /静谧极简/ })
    await quietOption.hover()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'quiet-studio')
    await expect(page.getByRole('status').filter({ hasText: '实时试穿预览' })).toBeVisible()
    await quietOption.click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'quiet-studio')
    await maybeShot('07-settings-quiet-studio')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'quiet-studio')

    // 7. Theme Safe Mode (?theme=default): forces default without overwriting saved quiet-studio
    await page.goto(`${server.origin}/settings?theme=default`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'default')
    await expect(page.getByText(/主题安全模式（Theme Safe Mode）已启用/)).toBeVisible()
    await page.getByRole('button', { name: '退出安全模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'quiet-studio')

    // 8. Global Command Palette (Ctrl+K): switch back to default theme
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('combobox', { name: '搜索命令、空间、主题或设置项' })).toBeVisible()
    await maybeShot('08-command-palette')
    await page.getByText('切换主题（支持实时预览）…').click()
    await page.getByText('临床默认').first().click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'default')

    // Test Settings "← 返回工作台" escape button returns out of Settings cleanly
    await page.locator('[data-cm="settings-back-to-app"]').click()
    await expect(page).not.toHaveURL(/\/settings/)

    // Jump back to Clinical Workbench via Alt+1
    await page.keyboard.press('Alt+1')
    await expect(page).toHaveURL(`${server.origin}/consultation`)
    await expect(page.getByRole('complementary', { name: '候诊队列' })).toBeVisible()

    // Zero horizontal overflow at 1440px and zero console/page errors
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await server.close()
  }
})
