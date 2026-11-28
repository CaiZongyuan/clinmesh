import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

test('covers Models settings BYOK/Mock/Local CLI providers, inline Model & Thinking pickers, Claude-style Clinician Assistant, Context Inspector, Patient Agent on pi-durable, draft preservation, and responsive layout', async ({ page, webRoot }) => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'clinmesh-e2e-cli-home-'))
  const localSentinel = 'sk-e2e-local-cli-secret-never-visible-44444'
  await mkdir(join(fakeHome, '.pi', 'agent'), { recursive: true })
  await writeFile(join(fakeHome, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: {
      'e2e-pi': {
        name: 'Pi Local GW',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: localSentinel,
        models: [{ id: 'deepseek-r1', name: 'DeepSeek R1', reasoning: true, contextWindow: 131_072, maxTokens: 8_192 }],
      },
    },
  }))
  await mkdir(join(fakeHome, '.claude'), { recursive: true })
  await writeFile(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
    model: 'sonnet[1m]',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: localSentinel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    },
  }))
  await mkdir(join(fakeHome, '.codex'), { recursive: true })
  await writeFile(join(fakeHome, '.codex', 'config.toml'), [
    'model_provider = "e2e-codex"',
    'model = "gpt-5.4"',
    'model_reasoning_effort = "xhigh"',
    '[model_providers.e2e-codex]',
    'name = "Codex Local"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    `experimental_bearer_token = "${localSentinel}"`,
  ].join('\n'))

  const server = await startBrowserServer(webRoot, {
    syntheaProvider: new StubSyntheaProvider(),
    localProviders: { enabled: true, homeDir: fakeHome, env: {} },
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

    // 1. Sign in as outpatient doctor
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toHaveCount(0)

    // 2. Assistant sidebar is collapsed by default; expand it and verify explicit LLM_PROVIDER_UNCONFIGURED error
    await expect(page.locator('[data-clinmesh-assistant-sidebar]')).toHaveCount(0)
    await page.getByRole('button', { name: '展开临床助手', exact: true }).click()
    const sidebar = page.locator('[data-clinmesh-assistant-sidebar]')
    await expect(sidebar).toBeVisible()

    // Click starter prompt chip in empty state -> hits explicit unconfigured error before Mock Mode
    await sidebar.getByTestId('assistant-starter-summary').click()
    await expect(sidebar.getByText(/未配置模型 API Key/)).toBeVisible()
    await sidebar.getByRole('link', { name: '前往模型与服务商设置' }).click()

    // 3. Configure Models & Provider: verify Local CLI discovery (zero secrets), data-agent-secret, BYOK local storage, Mock Mode switch & connection test
    await expect(page.getByRole('heading', { name: '模型与服务商（BYOK 与 Mock 模式）', exact: true })).toBeVisible()
    await expect(page.getByTestId('local-provider-card-pi:e2e-pi')).toBeVisible()
    await expect(page.getByTestId('local-provider-card-claude:local')).toBeVisible()
    await expect(page.getByTestId('local-provider-card-codex:e2e-codex')).toBeVisible()
    const settingsHtml = await page.content()
    expect(settingsHtml).not.toContain(localSentinel)
    const apiKeyInput = page.getByLabel('API Key（仅存本机浏览器）')
    await expect(apiKeyInput).toHaveAttribute('data-agent-secret', '')
    await apiKeyInput.fill('sk-browser-only-e2e-test-999')
    await page.getByRole('button', { name: '显示 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'password')

    // Enable Mock Mode explicitly and test connection
    await page.getByRole('switch', { name: '演示 / Mock 模式' }).click()
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByText(/Mock 模式连接正常/)).toBeVisible()

    // Verify persistent Mock Mode indicator in the workspace header
    await expect(page.locator('[data-clinmesh-mock-badge]')).toBeVisible()

    // 4. Return to consultation workspace and verify Patient Agent works through pi-durable in Mock Mode
    await page.goto(`${server.origin}/consultation`)
    await expect(page.locator('[data-clinmesh-mock-badge]')).toBeVisible()
    await openWorkspaceTab(page, '问诊记录')
    const consultationPanel = page.getByRole('tabpanel', { name: '问诊记录', exact: true })
    await consultationPanel.getByRole('textbox', { name: '向患者提问', exact: true }).fill('您不舒服多久了？')
    await consultationPanel.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(consultationPanel.getByText(/昨天晚上开始的/)).toBeVisible()

    // 5. Type an unsaved draft in the consultation composer and verify expand/collapse preserves it without reload
    const unsavedDraft = '未发送的临床问诊草稿-STEP3-PRESERVE'
    await consultationPanel.getByRole('textbox', { name: '向患者提问', exact: true }).fill(unsavedDraft)
    await page.getByRole('button', { name: '展开临床助手', exact: true }).click()
    await expect(sidebar).toBeVisible()
    await expect(consultationPanel.getByRole('textbox', { name: '向患者提问', exact: true })).toHaveValue(unsavedDraft)

    // Verify responsive narrow width (< 800px left workspace) collapses queue cleanly with zero horizontal overflow
    await page.setViewportSize({ width: 1100, height: 900 })
    await expect(page.getByRole('button', { name: '展开队列', exact: true })).toBeVisible()
    const overflowAt1100 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflowAt1100).toBeLessThanOrEqual(1)
    await page.setViewportSize({ width: 1440, height: 900 })

    // Collapse & re-expand preserves clinical draft
    await sidebar.getByRole('button', { name: '收起临床助手', exact: true }).click()
    await expect(sidebar).toHaveCount(0)
    await expect(consultationPanel.getByRole('textbox', { name: '向患者提问', exact: true })).toHaveValue(unsavedDraft)

    // 6. Expand assistant and verify inline click-to-switch Model Picker + Thinking Level/Mode Picker, Claude-style streaming prose, unified WorkProcessBlock, Context Inspector, History Popover, Fork & Reload
    await page.getByRole('button', { name: '展开临床助手', exact: true }).click()
    await expect(sidebar).toBeVisible()

    // Inline click-to-switch Model Picker: switch from Mock -> local Claude -> back to Mock
    await sidebar.getByTestId('assistant-model-picker-trigger').click()
    const modelPopover = page.getByTestId('assistant-model-picker-popover')
    await expect(modelPopover).toBeVisible()
    await expect(modelPopover.getByTestId('assistant-model-option-pi:e2e-pi-deepseek-r1')).toBeVisible()
    await expect(modelPopover.getByTestId('assistant-model-option-codex:e2e-codex-gpt-5.4')).toBeVisible()
    await modelPopover.getByTestId('assistant-model-option-claude:local-claude-sonnet-4-6').click()
    await expect(sidebar.getByTestId('assistant-model-picker-trigger')).toContainText('claude-sonnet-4-6')

    // Inline click-to-switch Thinking Effort + Thinking Mode
    await sidebar.getByTestId('assistant-thinking-picker-trigger').click()
    const thinkingPopover = page.getByTestId('assistant-thinking-picker-popover')
    await expect(thinkingPopover).toBeVisible()
    await thinkingPopover.getByTestId('assistant-thinking-level-high').click()
    await thinkingPopover.getByTestId('assistant-thinking-mode-adaptive').click()
    await page.keyboard.press('Escape')
    await expect(sidebar.getByTestId('assistant-thinking-picker-trigger')).toContainText('高·自适应')

    // Switch back to Mock Mode directly from the inline Model Picker for deterministic turn verification
    await sidebar.getByTestId('assistant-model-picker-trigger').click()
    await page.getByTestId('assistant-model-option-mock').click()
    await expect(sidebar.getByTestId('assistant-model-picker-trigger')).toContainText('Mock')

    await sidebar.getByLabel('向临床助手提问').fill('请帮我整理当前病例摘要')
    await sidebar.getByRole('button', { name: '发送临床助手消息', exact: true }).click()

    await expect(sidebar.getByText('当前病例摘要（Mock 模式）')).toBeVisible({ timeout: 10_000 })

    // Expand unified WorkProcessBlock -> verify thinking + nested read_visible_case_summary tool output
    await sidebar.getByTestId('assistant-work-process-toggle').first().click()
    await expect(sidebar.getByText(/先读取当前接诊的医生可见病例摘要|已获取当前病例的医生可见摘要/).first()).toBeVisible()

    await sidebar.getByTestId('assistant-tool-toggle').first().click()
    await expect(sidebar.locator('code').filter({ hasText: /患者：.*张琴/ }).first()).toBeVisible()

    // Open Context Inspector via ContextOccupancyRing -> verify side-by-side overlay, breakdown, timeline, and browser
    await sidebar.getByTestId('context-occupancy-ring').click()
    const inspector = page.getByTestId('context-inspector-overlay')
    await expect(inspector).toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(inspector.getByTestId('context-composition-bar')).toBeVisible()
    await expect(inspector.getByTestId('context-call-timeline')).toBeVisible()
    await expect(inspector.getByTestId('context-browser')).toBeVisible()
    await expect(inspector.getByText('system-instructions')).toBeVisible({ timeout: 5_000 })
    await expect(inspector.getByText('clinical-scope')).toBeVisible()
    await expect(inspector.getByText('read_visible_case_summary').first()).toBeVisible()

    // Toggle Delta timeline mode, verify Auto-Compact switch is ON by default, & dismiss via Escape
    await expect(inspector.getByTestId('context-auto-compact-switch')).toHaveAttribute('aria-checked', 'true')
    await inspector.getByTestId('context-timeline-mode-delta').click()
    await expect(inspector.getByTestId('context-call-timeline')).toHaveAttribute('data-timeline-mode', 'delta')
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)

    // Verify /context slash command opens Context Inspector without sending a chat message
    await sidebar.getByLabel('向临床助手提问').fill('/context')
    await expect(sidebar.getByTestId('assistant-slash-hint')).toBeVisible()
    await sidebar.getByLabel('向临床助手提问').press('Enter')
    await expect(inspector).toBeVisible()
    await inspector.getByTestId('context-inspector-close').click()
    await expect(inspector).toHaveCount(0)

    // Verify P0/P1/P2 E2E workflows: @ clinical entity mention, Side Chat (/side), Preferences/Memory, /compact, History Search & Export
    await sidebar.getByTestId('assistant-mention-trigger').click()
    const mentionMenu = sidebar.getByTestId('assistant-mention-menu')
    await expect(mentionMenu).toBeVisible()
    await mentionMenu.getByTestId('assistant-mention-option-vitals').click()
    await expect(sidebar.getByTestId('assistant-entity-chip-vitals')).toBeVisible()
    await sidebar.getByLabel('向临床助手提问').fill('请结合体征补充检验建议')
    await sidebar.getByRole('button', { name: '发送临床助手消息', exact: true }).click()
    await expect(sidebar.getByTestId('assistant-minimap-trigger')).toBeVisible({ timeout: 10_000 })

    // Open ephemeral Side Chat (/side), ask question, verify main thread stays clean, and insert into composer
    const userTurnCountBeforeSide = await sidebar.getByTestId('assistant-user-turn').count()
    await sidebar.getByLabel('向临床助手提问').fill('/side')
    await sidebar.getByLabel('向临床助手提问').press('Enter')
    const sidePanel = page.getByTestId('assistant-side-chat-panel')
    await expect(sidePanel).toBeVisible()
    await sidePanel.getByTestId('assistant-side-chat-input').fill('核对常规退热剂量')
    await sidePanel.getByTestId('assistant-side-chat-send').click()
    await expect(sidePanel.getByTestId('assistant-side-chat-insert')).toBeVisible({ timeout: 10_000 })
    await expect(sidePanel.getByText('侧边追问解答（Mock 模式）')).toBeVisible()
    await expect(sidebar.getByTestId('assistant-user-turn')).toHaveCount(userTurnCountBeforeSide)
    await sidePanel.getByTestId('assistant-side-chat-insert').click()
    await expect(sidePanel).toHaveCount(0)
    await sidebar.getByLabel('向临床助手提问').fill('')

    // Open Preferences popover: verify Auto-Compact default ON, apply SOAP instruction preset, and save clinician memory
    await sidebar.getByTestId('assistant-preferences-trigger').click()
    const prefPopover = page.getByTestId('assistant-preferences-popover')
    await expect(prefPopover).toBeVisible()
    await expect(prefPopover.getByTestId('assistant-pref-autocompact-switch')).toHaveAttribute('aria-checked', 'true')
    await prefPopover.getByRole('button', { name: '应用模板：SOAP 病历格式' }).click()
    await prefPopover.getByTestId('assistant-instructions-save').click()
    await prefPopover.getByTestId('memory-add-input').fill('优先标出药物过敏禁忌')
    await prefPopover.getByTestId('memory-add-submit').click()
    await expect(prefPopover.getByTestId('memory-approved-item').filter({ hasText: '优先标出药物过敏禁忌' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Trigger manual /compact and verify compacted context boundary divider appears
    await sidebar.getByLabel('向临床助手提问').fill('/compact')
    await sidebar.getByLabel('向临床助手提问').press('Enter')
    await expect(sidebar.getByTestId('assistant-compaction-divider')).toBeVisible({ timeout: 10_000 })

    // Verify Edit & Branch and New Conversation defer session creation until actual send (zero ghost sessions)
    await sidebar.getByTestId('assistant-history-trigger').click()
    const historyCountBeforeCancel = await page.getByTestId('assistant-history-item').count()
    await page.keyboard.press('Escape')

    await sidebar.getByTestId('assistant-edit-branch-btn').first().click()
    await expect(sidebar.getByTestId('assistant-branch-edit-banner')).toBeVisible()
    await sidebar.getByTestId('assistant-branch-edit-cancel').click()
    await expect(sidebar.getByTestId('assistant-branch-edit-banner')).toHaveCount(0)

    await sidebar.getByRole('button', { name: '新建助手会话', exact: true }).click()
    await expect(sidebar.getByText('临床助手已就绪')).toBeVisible()
    await sidebar.getByTestId('assistant-history-trigger').click()
    await expect(page.getByTestId('assistant-history-item')).toHaveCount(historyCountBeforeCancel)
    await page.getByTestId('assistant-history-item').first().getByRole('button', { name: /切换到会话/ }).click()

    // Rename session, search across sessions, and trigger Markdown export inside History Popover
    await sidebar.getByTestId('assistant-history-trigger').click()
    const historyPopover = page.getByTestId('assistant-history-popover')
    await expect(historyPopover).toBeVisible()
    await historyPopover.getByRole('button', { name: /重命名会话/ }).first().click()
    const renameInput = historyPopover.getByLabel('输入新的会话名称')
    await renameInput.fill('张琴门诊病例梳理')
    await historyPopover.getByRole('button', { name: '确认重命名', exact: true }).click()
    await expect(sidebar.getByTestId('assistant-session-title')).toHaveText('张琴门诊病例梳理')
    await historyPopover.getByTestId('assistant-history-search').fill('张琴门诊')
    await expect(historyPopover.getByTestId('assistant-history-search-hit').first()).toBeVisible()
    await historyPopover.getByRole('button', { name: '清空搜索关键词' }).click()
    await historyPopover.getByTestId('assistant-history-export').first().click()
    await expect(sidebar.getByTestId('assistant-status-notice')).toContainText('.md')

    // Retry latest user message and wait until generation settles before forking
    await sidebar.getByRole('button', { name: '重试最新问题', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: '重试最新问题', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(sidebar.getByTestId('assistant-reply-turn').last()).toBeVisible({ timeout: 10_000 })

    // Fork session and verify title + branch badge
    await sidebar.getByRole('button', { name: '从当前会话创建分支', exact: true }).click()
    await expect(sidebar.getByTestId('assistant-session-title')).toContainText('张琴门诊病例梳理 (分支)')

    // Toggle wide reading mode and verify zero horizontal page overflow
    await sidebar.getByRole('button', { name: '宽屏阅读模式', exact: true }).click()
    await expect(sidebar).toHaveAttribute('data-wide', 'true')
    const overflowWide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflowWide).toBeLessThanOrEqual(1)
    await sidebar.getByRole('button', { name: '恢复标准宽度', exact: true }).click()

    // Reload browser page and verify pi-durable SQLite session history, Compaction divider & Context Ring restore seamlessly
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '展开临床助手', exact: true }).click()
    await expect(sidebar.getByTestId('assistant-compaction-divider')).toBeVisible({ timeout: 10_000 })
    await expect(sidebar.getByText('当前病例摘要（Mock 模式）').first()).toBeVisible({ timeout: 10_000 })

    // Confirm BYOK secret never entered SQLite (including pi_documents context snapshots)
    const tables = (server.runtime.database.driver.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map(row => row.name)
    for (const table of tables) {
      const rows = server.runtime.database.driver.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
      expect(JSON.stringify(rows), `BYOK key leaked into ${table}`).not.toContain('sk-browser-only-e2e-test-999')
      expect(JSON.stringify(rows), `Local CLI secret leaked into ${table}`).not.toContain(localSentinel)
    }
  } finally {
    await server.close()
    await rm(fakeHome, { recursive: true, force: true })
  }
})
