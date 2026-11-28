// @vitest-environment jsdom

import type {
  AgentSessionDetail,
  LlmProviderCatalogResponse,
  ModelCallDetail,
  ModelCallSummary,
  SessionContextResponse,
} from '@clinmesh/contracts/agent-sessions'
import { LLM_RUNTIME_HEADERS } from '@clinmesh/contracts/agent-sessions'
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAgent } from '@ui-sdk/react/agent'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveEncounterStore } from './active-encounter-context.tsx'
import { ClinicianAssistantSidebar } from './clinician-assistant-sidebar.tsx'
import { ModelsSettingsPage } from './models-settings-page.tsx'
import {
  buildLlmRequestHeaders,
  DEFAULT_LLM_SETTINGS,
  readLlmSettings,
  writeLlmSettings,
} from './llm-settings-storage.ts'

declare global {
  var __UI_SDK_STRICT__: boolean | undefined
}

const agent = createAgent()

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
}

function renderWithRouter(element: React.ReactElement) {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => element,
  })
  const modelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/models',
    component: () => <div>Models Route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, modelsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const doctorSession: SessionContext = {
  actor: {
    actorId: 'actor-doctor',
    epoch: 'epoch-1',
    locationId: 'location-outpatient',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-doctor',
    practitionerRoleId: 'practitioner-role-doctor',
    roleCode: 'outpatient-doctor',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'outpatient-doctor',
    id: 'practitioner-role-doctor',
    locationId: 'location-outpatient',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-doctor',
    practitionerName: '张医生',
  }],
  user: {
    email: 'doctor@demo.clinmesh.local',
    id: 'user-doctor',
    name: '张医生',
  },
}

const sampleCallSummary: ModelCallSummary = {
  id: 'mcall-1',
  seq: 1,
  purpose: 'TURN',
  provider: 'mock',
  model: 'mock-clinmesh-v1',
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  startedAt: new Date(Date.now() - 600).toISOString(),
  endedAt: new Date().toISOString(),
  durationMs: 420,
  status: 'COMPLETED',
  usage: {
    promptTokens: 1_240,
    inputTokens: 1_240,
    outputTokens: 180,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_420,
    source: 'SIMULATED',
  },
  estimate: {
    byKind: {
      INSTRUCTIONS: 320,
      CLINICAL_CONTEXT: 180,
      COMPACTED_SUMMARY: 0,
      TOOL_DEFINITION: 240,
      USER_MESSAGE: 120,
      ASSISTANT_MESSAGE: 0,
      REASONING: 80,
      TOOL_CALL: 100,
      TOOL_RESULT: 200,
    },
    inputTokens: 1_240,
    outputTokens: 180,
    excludedTokens: 0,
  },
  includedCount: 4,
  excludedCount: 0,
  responseToolNames: ['read_visible_case_summary'],
  hasDetail: true,
}

const sampleCallDetail: ModelCallDetail = {
  ...sampleCallSummary,
  included: [
    {
      kind: 'INSTRUCTIONS',
      blobId: 'blob-sys',
      label: 'system-instructions',
      content: '你是 ClinMesh 中国公立医院仿真 HIS 的临床助手。',
      tokens: 320,
    },
    {
      kind: 'CLINICAL_CONTEXT',
      blobId: 'blob-clin',
      label: 'clinical-scope',
      content: '【当前临床作用域上下文】\n当前接诊 Encounter ID：enc-1',
      tokens: 180,
    },
    {
      kind: 'TOOL_DEFINITION',
      blobId: 'blob-tool',
      label: 'read_visible_case_summary',
      source: 'BUILTIN',
      content: '{"name":"read_visible_case_summary"}',
      tokens: 240,
    },
    {
      kind: 'USER_MESSAGE',
      blobId: 'blob-user',
      content: '总结当前症状',
      tokens: 120,
    },
  ],
  excluded: [],
  response: [
    {
      kind: 'ASSISTANT_MESSAGE',
      blobId: 'blob-resp',
      content: '### 问诊建议\n\n- 核对体温与咳嗽持续时间',
      tokens: 180,
    },
  ],
}

const sampleCatalogResponse: LlmProviderCatalogResponse = {
  discoveryEnabled: true,
  scannedAt: new Date().toISOString(),
  serverDefault: {
    serverDefaultConfigured: false,
    serverDefaultProvider: null,
    serverDefaultModel: null,
  },
  localProviders: [
    {
      id: 'pi:local-gw',
      source: 'pi',
      providerKey: 'local-gw',
      displayName: 'Pi Gateway',
      api: 'openai-completions',
      baseUrlHost: 'gateway.local',
      originPath: '~/.pi/agent/models.json',
      authReady: true,
      authKind: 'api-key',
      defaultModelId: 'deepseek-r1',
      defaultThinkingLevel: 'high',
      models: [
        {
          id: 'deepseek-r1',
          name: 'DeepSeek R1',
          api: 'openai-completions',
          contextWindow: 131_072,
          maxTokens: 8_192,
          reasoning: true,
          supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
          supportsAdaptiveThinking: false,
          isDefault: true,
        },
      ],
    },
    {
      id: 'claude:local',
      source: 'claude',
      providerKey: 'claude-code',
      displayName: 'Claude Code',
      api: 'anthropic-messages',
      baseUrlHost: 'api.anthropic.com',
      originPath: '~/.claude/settings.json',
      authReady: true,
      authKind: 'bearer-token',
      defaultModelId: 'claude-sonnet-4-6',
      defaultThinkingLevel: 'medium',
      models: [
        {
          id: 'claude-sonnet-4-6',
          name: 'claude-sonnet-4-6 (Sonnet)',
          api: 'anthropic-messages',
          contextWindow: 1_000_000,
          maxTokens: 16_384,
          reasoning: true,
          supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
          isDefault: true,
        },
      ],
    },
    {
      id: 'codex:openai',
      source: 'codex',
      providerKey: 'openai',
      displayName: 'Codex · OpenAI',
      api: 'openai-responses',
      baseUrlHost: 'api.openai.com',
      originPath: '~/.codex/config.toml',
      authReady: true,
      authKind: 'bearer-token',
      defaultModelId: 'gpt-5.4',
      defaultThinkingLevel: 'xhigh',
      models: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4 Codex',
          api: 'openai-responses',
          contextWindow: 400_000,
          maxTokens: 16_384,
          reasoning: true,
          supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
          supportsAdaptiveThinking: false,
          isDefault: true,
        },
      ],
    },
  ],
}

let previousStrictMode: boolean | undefined

beforeAll(() => {
  previousStrictMode = globalThis.__UI_SDK_STRICT__
  globalThis.__UI_SDK_STRICT__ = true
})

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrictMode
})

beforeEach(() => {
  localStorage.clear()
  writeLlmSettings(DEFAULT_LLM_SETTINGS)
  useActiveEncounterStore.getState().clearActiveEncounter()
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Step 3 Models settings and Claude-style Clinician Assistant UI + Context Inspector', () => {
  it('names every ModelsSettingsPage control, redacts API key in agent snapshot, and toggles Mock Mode', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/agents/providers/status') {
        return Response.json({
          serverDefaultConfigured: false,
          serverDefaultProvider: null,
          serverDefaultModel: null,
        })
      }
      if (url.pathname === '/api/agents/providers/catalog') {
        return Response.json(sampleCatalogResponse)
      }
      if (url.pathname === '/api/agents/providers/test') {
        return Response.json({
          ok: true,
          provider: 'mock',
          modelId: 'mock-clinmesh-v1',
          latencyMs: 5,
          replyPreview: 'OK (Mock Mode)',
          message: 'Mock 模式连接正常。',
        })
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`)
    }))

    renderWithRouter(<ModelsSettingsPage locale="zh-CN" />)
    const apiKeyInput = await screen.findByLabelText('API Key（仅存本机浏览器）')
    await user.type(apiKeyInput, 'sk-local-secret-value-12345')

    const snapshot = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    expect(snapshot.length).toBeGreaterThan(0)
    for (const entry of snapshot) {
      expect(entry.label, `${entry.component} (${entry.ref}) missing label`).toBeTruthy()
    }
    expect(JSON.stringify(snapshot)).not.toContain('sk-local-secret-value-12345')

    const mockSwitch = screen.getByRole('switch', { name: '演示 / Mock 模式' })
    await user.click(mockSwitch)
    expect(readLlmSettings().mockMode).toBe(true)

    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText(/Mock 模式连接正常/)

    // Local CLI providers card renders discovered pi/claude/codex providers and applies in 1 click
    await screen.findByTestId('local-provider-card-claude:local')
    await user.click(screen.getByRole('button', { name: '将本地服务商 Claude Code 用于临床助手' }))
    expect(readLlmSettings().mockMode).toBe(false)
    expect(readLlmSettings().assistant.localProviderId).toBe('claude:local')
    expect(readLlmSettings().assistant.modelId).toBe('claude-sonnet-4-6')
  })

  it('renders unified WorkProcessBlock, History Popover, ContextOccupancyRing, ContextInspectorOverlay, /context command, and IME Enter guard', async () => {
    const user = userEvent.setup()
    const sentPayloads: string[] = []
    const clipboardSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardSpy },
    })

    const sessionDetail: AgentSessionDetail = {
      session: {
        sessionId: 'asess-1',
        conversationId: 1,
        kind: 'clinician-assistant',
        title: '病例讨论',
        scope: {
          workspaceId: 'workspace-demo',
          epoch: 'epoch-1',
          roleCode: 'outpatient-doctor',
          encounterId: 'enc-1',
          caseId: 'case-1',
          patientId: 'pat-1',
        },
        forkedFromSessionId: null,
        status: 'idle',
        lastError: null,
        messageCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      messages: [
        {
          id: 'entry-1',
          entryId: 1,
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '总结当前症状' }],
          stopReason: null,
          errorMessage: null,
          streaming: false,
        },
        {
          id: 'entry-2',
          entryId: 2,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          blocks: [
            { type: 'thinking', thinking: '先核对主诉和既往史。' },
            {
              type: 'tool-call',
              callId: 'tc-1',
              name: 'read_visible_case_summary',
              argumentsJson: '{}',
              status: 'done',
              output: '- 患者：张琴',
            },
            { type: 'text', text: '### 问诊建议\n\n- 核对体温与咳嗽持续时间' },
          ],
          stopReason: 'stop',
          errorMessage: null,
          streaming: false,
          model: 'mock-clinmesh-v1',
          provider: 'mock',
          durationMs: 420,
          usage: sampleCallSummary.usage,
          modelCallId: sampleCallSummary.id,
        },
      ],
      canRetryLatest: true,
      latestContextCall: sampleCallSummary,
    }

    const sessionContextResponse: SessionContextResponse = {
      sessionId: 'asess-1',
      defaultContextWindow: 128_000,
      modelCalls: [sampleCallSummary],
      contextEvents: [],
      latestCall: sampleCallSummary,
    }

    useActiveEncounterStore.getState().setActiveEncounter({
      encounterId: 'enc-1',
      caseId: 'case-1',
      patientId: 'pat-1',
      patientName: '张琴',
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/agents/providers/catalog' && (!init?.method || init.method === 'GET')) {
        return Response.json(sampleCatalogResponse)
      }
      if (url.pathname === '/api/agents/sessions' && (!init?.method || init.method === 'GET')) {
        return Response.json({ sessions: [sessionDetail.session] })
      }
      if (url.pathname === '/api/agents/sessions/asess-1' && (!init?.method || init.method === 'GET')) {
        return Response.json(sessionDetail)
      }
      if (url.pathname === '/api/agents/sessions/asess-1/context' && (!init?.method || init.method === 'GET')) {
        return Response.json(sessionContextResponse)
      }
      if (url.pathname === '/api/agents/sessions/asess-1/model-calls/mcall-1' && (!init?.method || init.method === 'GET')) {
        return Response.json({ modelCall: sampleCallDetail })
      }
      if (url.pathname === '/api/agents/sessions/asess-1/clinical-entities' && (!init?.method || init.method === 'GET')) {
        return Response.json({
          encounterId: 'enc-1',
          caseId: 'case-1',
          entities: [
            {
              id: 'vitals',
              kind: 'vitals',
              label: '主诉与生命体征（张琴）',
              summary: '发热咳嗽 3 天',
              detailText: '患者：张琴\n主诉：发热咳嗽 3 天',
            },
          ],
        })
      }
      if (url.pathname === '/api/agents/memory' && (!init?.method || init.method === 'GET')) {
        return Response.json({ items: [] })
      }
      if (url.pathname === '/api/agents/sessions/asess-1/messages' && init?.method === 'POST') {
        sentPayloads.push(String(init.body))
        return new Response(JSON.stringify({
          error: { code: 'LLM_PROVIDER_UNCONFIGURED', message: '未配置模型 API Key。' },
        }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`)
    }))

    renderWithRouter(
      <ClinicianAssistantSidebar
        locale="zh-CN"
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        open
        session={doctorSession}
      />,
    )

    await screen.findByText('问诊建议')

    // Every visible interactive element inside the sidebar has a clean accessible label
    const snapshot = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    expect(snapshot.length).toBeGreaterThan(0)
    for (const entry of snapshot) {
      expect(entry.label, `${entry.component} (${entry.ref}) missing label`).toBeTruthy()
    }

    // Unified WorkProcessBlock is collapsed initially; clicking expands thinking + tool row
    expect(screen.queryByText('先核对主诉和既往史。')).toBeNull()
    await user.click(screen.getByTestId('assistant-work-process-toggle'))
    expect(screen.getByText('先核对主诉和既往史。')).toBeTruthy()

    await user.click(screen.getByTestId('assistant-tool-toggle'))
    expect(screen.getByText('- 患者：张琴')).toBeTruthy()

    // Copy reply action copies Markdown text
    await user.click(screen.getByTestId('assistant-copy-reply'))
    expect(clipboardSpy).toHaveBeenCalledWith('### 问诊建议\n\n- 核对体温与咳嗽持续时间')

    // ContextOccupancyRing opens ContextInspectorOverlay and loads full snapshot details
    await user.click(screen.getByTestId('context-occupancy-ring'))
    expect(await screen.findByTestId('context-inspector-overlay')).toBeTruthy()
    expect(await screen.findByText('当前上下文构成')).toBeTruthy()
    expect(await screen.findByText('第 #1 次调用发送的内容')).toBeTruthy()
    expect(await screen.findByText('system-instructions')).toBeTruthy()

    // Escape closes ContextInspectorOverlay cleanly
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('context-inspector-overlay')).toBeNull())

    // Typing /context opens ContextInspectorOverlay directly without calling POST /messages
    const composer = screen.getByLabelText('向临床助手提问')
    await user.type(composer, '/context')
    expect(screen.getByTestId('assistant-slash-hint')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(await screen.findByTestId('context-inspector-overlay')).toBeTruthy()
    expect(sentPayloads).toHaveLength(0)

    await user.click(screen.getByTestId('context-inspector-close'))
    await waitFor(() => expect(screen.queryByTestId('context-inspector-overlay')).toBeNull())

    // History Popover opens with inline rename and non-blocking delete confirmation
    await user.click(screen.getByTestId('assistant-history-trigger'))
    expect(await screen.findByTestId('assistant-history-popover')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '删除会话：病例讨论' }))
    expect(await screen.findByTestId('assistant-history-delete-confirm')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '取消删除会话' }))
    await user.click(screen.getByTestId('assistant-history-trigger'))

    // IME composition Enter MUST NOT submit
    await user.type(composer, '头晕怎么办')
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(sentPayloads).toHaveLength(0)

    // Plain Enter submits and surfaces explicit unconfigured error with link to Models settings
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 13, isComposing: false })
    await waitFor(() => expect(sentPayloads).toHaveLength(1))
    await screen.findByText('前往模型与服务商设置')

    // Inline click-to-switch Model Picker discovers local pi/claude/codex models and switches immediately
    await user.click(screen.getByTestId('assistant-model-picker-trigger'))
    expect(await screen.findByTestId('assistant-model-picker-popover')).toBeTruthy()
    await user.click(screen.getByTestId('assistant-model-option-claude:local-claude-sonnet-4-6'))
    expect(readLlmSettings().assistant.localProviderId).toBe('claude:local')
    expect(readLlmSettings().assistant.modelId).toBe('claude-sonnet-4-6')

    // Inline click-to-switch Thinking Effort + Thinking Mode + Live Thinking toggle
    await user.click(screen.getByTestId('assistant-thinking-picker-trigger'))
    expect(await screen.findByTestId('assistant-thinking-picker-popover')).toBeTruthy()
    await user.click(screen.getByTestId('assistant-thinking-level-high'))
    await user.click(screen.getByTestId('assistant-thinking-mode-adaptive'))
    await user.click(screen.getByTestId('assistant-show-live-thinking-switch'))

    const updated = readLlmSettings()
    expect(updated.assistant.reasoningEffort).toBe('high')
    expect(updated.assistant.thinkingMode).toBe('adaptive')
    expect(updated.showLiveThinking).toBe(true)

    const headers = buildLlmRequestHeaders('assistant')
    expect(headers[LLM_RUNTIME_HEADERS.mode]).toBe('local')
    expect(headers[LLM_RUNTIME_HEADERS.localProvider]).toBe('claude:local')
    expect(headers[LLM_RUNTIME_HEADERS.modelId]).toBe('claude-sonnet-4-6')
    expect(headers[LLM_RUNTIME_HEADERS.reasoningEffort]).toBe('high')
    expect(headers[LLM_RUNTIME_HEADERS.thinkingMode]).toBe('adaptive')
    expect(headers[LLM_RUNTIME_HEADERS.apiKey]).toBeUndefined()
  })

  it('supports P0/P1/P2 assistant workflows: auto-compact default ON, /compact, /side ephemeral chat, @ clinical entity mentions, quote chip, preferences & clinician memory approval, minimap, history search/export, retry banner, and queued steer/followUp', async () => {
    const user = userEvent.setup()
    const sentRequests: Array<{ url: string; method: string; body?: string }> = []
    let memories = [
      {
        id: 'mem-1',
        content: '首选 SOAP 病历格式输出',
        status: 'pending' as const,
        source: 'assistant' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]

    const sessionDetail: AgentSessionDetail = {
      session: {
        sessionId: 'asess-2',
        conversationId: 2,
        kind: 'clinician-assistant',
        title: '多轮临床会诊',
        scope: {
          workspaceId: 'workspace-demo',
          epoch: 'epoch-1',
          roleCode: 'outpatient-doctor',
          encounterId: 'enc-1',
          caseId: 'case-1',
          patientId: 'pat-1',
        },
        forkedFromSessionId: null,
        customInstructions: null,
        autoCompact: true,
        status: 'running',
        lastError: null,
        messageCount: 4,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      messages: [
        {
          id: 'entry-1',
          entryId: 1,
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '第一轮：总结生命体征' }],
          stopReason: null,
          errorMessage: null,
          streaming: false,
        },
        {
          id: 'entry-2',
          entryId: 2,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '体温 38.2°C，建议复查血常规。' }],
          stopReason: 'stop',
          errorMessage: null,
          streaming: false,
          model: 'mock-clinmesh-v1',
          provider: 'mock',
          durationMs: 380,
          ttftMs: 140,
          tokensPerSecond: 46.2,
          usage: sampleCallSummary.usage,
          modelCallId: sampleCallSummary.id,
        },
        {
          id: 'entry-3',
          entryId: 3,
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '第二轮：核对用药禁忌' }],
          stopReason: null,
          errorMessage: null,
          streaming: false,
        },
      ],
      canRetryLatest: true,
      latestContextCall: sampleCallSummary,
      queuedInputs: [
        { submissionId: 91, mode: 'followUp', content: '待发送的补充问题' },
      ],
      retryState: {
        attempt: 1,
        retryAt: new Date(Date.now() + 8_000).toISOString(),
        error: '429 Too Many Requests',
        isRateLimited: true,
      },
      compactionState: { active: false },
    }

    useActiveEncounterStore.getState().setActiveEncounter({
      encounterId: 'enc-1',
      caseId: 'case-1',
      patientId: 'pat-1',
      patientName: '张琴',
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      sentRequests.push({
        url: url.pathname + url.search,
        method,
        ...(init?.body ? { body: String(init.body) } : {}),
      })
      if (url.pathname === '/api/agents/providers/catalog') return Response.json(sampleCatalogResponse)
      if (url.pathname === '/api/agents/sessions' && method === 'GET') {
        return Response.json({ sessions: [sessionDetail.session] })
      }
      if (url.pathname === '/api/agents/sessions/asess-2' && method === 'GET') {
        return Response.json(sessionDetail)
      }
      if (url.pathname === '/api/agents/sessions/asess-2' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { customInstructions?: string | null; autoCompact?: boolean }
        return Response.json({
          session: {
            ...sessionDetail.session,
            ...(body.customInstructions !== undefined ? { customInstructions: body.customInstructions } : {}),
            ...(body.autoCompact !== undefined ? { autoCompact: body.autoCompact } : {}),
          },
        })
      }
      if (url.pathname === '/api/agents/sessions/asess-2/clinical-entities') {
        return Response.json({
          encounterId: 'enc-1',
          caseId: 'case-1',
          entities: [
            {
              id: 'lab:1',
              kind: 'lab',
              label: '检验：血常规',
              summary: 'WBC 12.4 × 10^9/L',
              detailText: '检验项目：血常规\n- WBC: 12.4 [high]',
            },
          ],
        })
      }
      if (url.pathname === '/api/agents/sessions/asess-2/queue/91' && method === 'DELETE') {
        return Response.json({
          recalled: true,
          content: '待发送的补充问题',
          detail: { ...sessionDetail, queuedInputs: [] },
        })
      }
      if (url.pathname === '/api/agents/sessions/asess-2/messages' && method === 'POST') {
        return Response.json(sessionDetail)
      }
      if (url.pathname === '/api/agents/sessions/asess-2/side-question' && method === 'POST') {
        return Response.json({
          answer: '侧边核对：成人常规剂量为 0.5g q8h。',
          model: 'mock-clinmesh-v1',
          provider: 'mock',
          durationMs: 120,
          ttftMs: 40,
        })
      }
      if (url.pathname === '/api/agents/memory' && method === 'GET') {
        return Response.json({ items: memories })
      }
      if (url.pathname === '/api/agents/memory/mem-1' && method === 'PATCH') {
        memories = [{ ...memories[0]!, status: 'approved' as never }]
        return Response.json({ items: memories })
      }
      if (url.pathname === '/api/agents/sessions/search') {
        return Response.json({
          query: '血常规',
          matches: [{ session: sessionDetail.session, snippet: '建议复查血常规', matchedIn: 'message' }],
        })
      }
      if (url.pathname === '/api/agents/sessions/asess-2/export') {
        return Response.json({
          sessionId: 'asess-2',
          title: '多轮临床会诊',
          filename: 'clinmesh-asess-2.md',
          markdown: '# 多轮临床会诊\n\n导出正文',
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
    }))

    renderWithRouter(
      <ClinicianAssistantSidebar
        locale="zh-CN"
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        open
        session={doctorSession}
      />,
    )

    await screen.findByText('体温 38.2°C，建议复查血常规。')

    // Telemetry micro-footer, queued bar, retry countdown banner, and Turn Minimap all render cleanly
    expect(screen.getByTestId('assistant-turn-telemetry').textContent).toContain('TTFT')
    expect(screen.getByTestId('assistant-turn-telemetry').textContent).toContain('46.2 tok/s')
    expect(screen.getByTestId('assistant-queued-bar')).toBeTruthy()
    expect(screen.getByTestId('assistant-retry-banner')).toBeTruthy()
    expect(screen.getByTestId('assistant-minimap-trigger')).toBeTruthy()

    // Strict-mode createAgent() check across ALL new controls
    const snapshot = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    for (const entry of snapshot) {
      expect(entry.label, `${entry.component} (${entry.ref}) missing label`).toBeTruthy()
    }

    // Composer remains ENABLED while streaming, allowing Steer / Queue + Recall
    const composer = screen.getByLabelText('向临床助手提问') as HTMLTextAreaElement
    expect(composer.disabled).toBe(false)
    await user.click(screen.getByTestId('assistant-queued-recall'))
    await waitFor(() => expect(composer.value).toContain('待发送的补充问题'))

    // Attach @ clinical entity chip and submit Steer while running
    await user.click(screen.getByTestId('assistant-mention-trigger'))
    await user.click(await screen.findByTestId('assistant-mention-option-lab:1'))
    expect(screen.getByTestId('assistant-entity-chip-lab:1')).toBeTruthy()
    await user.click(screen.getByTestId('assistant-steer-btn'))
    await waitFor(() => {
      const msgReq = sentRequests.find(r => r.url === '/api/agents/sessions/asess-2/messages' && r.method === 'POST')
      expect(msgReq?.body).toContain('"whenBusy":"steer"')
      expect(msgReq?.body).toContain('[临床引用: 检验：血常规]')
    })

    // Quote reply -> composer quote chip
    await user.click(screen.getByTestId('assistant-quote-reply'))
    expect(screen.getByTestId('assistant-quote-chip')).toBeTruthy()

    // Side Chat (/side) -> ask -> insert into main composer
    await user.click(screen.getByTestId('assistant-side-reply'))
    expect(await screen.findByTestId('assistant-side-chat-panel')).toBeTruthy()
    await user.type(screen.getByTestId('assistant-side-chat-input'), '核对剂量')
    await user.click(screen.getByTestId('assistant-side-chat-send'))
    await screen.findByText(/成人常规剂量/)
    await user.click(screen.getByTestId('assistant-side-chat-insert'))
    await waitFor(() => expect(composer.value).toContain('成人常规剂量'))

    // Preferences & Clinician Memory Approval popover
    await user.click(screen.getByTestId('assistant-preferences-trigger'))
    expect(await screen.findByTestId('assistant-preferences-popover')).toBeTruthy()
    expect(screen.getByTestId('assistant-pref-autocompact-switch').getAttribute('aria-checked')).toBe('true')
    await user.click(await screen.findByTestId('memory-approve-btn'))
    await waitFor(() => expect(sentRequests.some(r => r.url === '/api/agents/memory/mem-1' && r.method === 'PATCH')).toBe(true))
    await user.click(screen.getByTestId('assistant-preferences-trigger'))

    // History Popover: Cross-session search & Export Markdown
    await user.click(screen.getByTestId('assistant-history-trigger'))
    await user.type(await screen.findByTestId('assistant-history-search'), '血常规')
    expect(await screen.findByTestId('assistant-history-search-hit')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '清空搜索关键词' }))
    await user.click(await screen.findByTestId('assistant-history-export'))
    await waitFor(() => expect(sentRequests.some(r => r.url === '/api/agents/sessions/asess-2/export')).toBe(true))
  })

  it('defers Edit & Branch and New Conversation until the user actually sends, creating zero ghost sessions on cancel', async () => {
    const user = userEvent.setup()
    const mutations: Array<{ url: string; method: string; body?: string }> = []

    const idleSessionDetail: AgentSessionDetail = {
      session: {
        sessionId: 'asess-3',
        conversationId: 3,
        kind: 'clinician-assistant',
        title: '延迟分支验证',
        scope: {
          workspaceId: 'workspace-demo',
          epoch: 'epoch-1',
          roleCode: 'outpatient-doctor',
          encounterId: 'enc-1',
          caseId: 'case-1',
          patientId: 'pat-1',
        },
        forkedFromSessionId: null,
        customInstructions: null,
        autoCompact: true,
        status: 'idle',
        lastError: null,
        messageCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      messages: [
        {
          id: 'entry-1',
          entryId: 1,
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '原始第一轮提问' }],
          stopReason: null,
          errorMessage: null,
          streaming: false,
        },
        {
          id: 'entry-2',
          entryId: 2,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: '原始第一轮回答。' }],
          stopReason: 'stop',
          errorMessage: null,
          streaming: false,
        },
      ],
      canRetryLatest: true,
      latestContextCall: null,
    }

    useActiveEncounterStore.getState().setActiveEncounter({
      encounterId: 'enc-1',
      caseId: 'case-1',
      patientId: 'pat-1',
      patientName: '张琴',
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      if (method !== 'GET') {
        mutations.push({
          url: url.pathname,
          method,
          ...(init?.body ? { body: String(init.body) } : {}),
        })
      }
      if (url.pathname === '/api/agents/providers/catalog') return Response.json(sampleCatalogResponse)
      if (url.pathname === '/api/agents/sessions' && method === 'GET') {
        return Response.json({ sessions: [idleSessionDetail.session] })
      }
      if (url.pathname === '/api/agents/sessions/asess-3' && method === 'GET') {
        return Response.json(idleSessionDetail)
      }
      if (url.pathname === '/api/agents/sessions/asess-3/clinical-entities' || url.pathname === '/api/agents/clinical-entities') {
        return Response.json({ encounterId: 'enc-1', caseId: 'case-1', entities: [] })
      }
      throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
    }))

    renderWithRouter(
      <ClinicianAssistantSidebar
        locale="zh-CN"
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        open
        session={doctorSession}
      />,
    )

    await screen.findByText('原始第一轮回答。')
    const composer = screen.getByLabelText('向临床助手提问') as HTMLTextAreaElement

    // 1. Clicking Edit & Branch enters local draft mode ONLY — zero server fork/create mutations
    await user.click(screen.getByTestId('assistant-edit-branch-btn'))
    expect(screen.getByTestId('assistant-branch-edit-banner')).toBeTruthy()
    expect(composer.value).toBe('原始第一轮提问')
    expect(mutations).toHaveLength(0)

    // 2. Canceling Edit & Branch exits cleanly with zero ghost sessions
    await user.click(screen.getByTestId('assistant-branch-edit-cancel'))
    expect(screen.queryByTestId('assistant-branch-edit-banner')).toBeNull()
    expect(composer.value).toBe('')
    expect(mutations).toHaveLength(0)

    // 3. Clicking New Conversation enters local empty draft mode without creating a 0-message session
    await user.click(screen.getByRole('button', { name: '新建助手会话' }))
    expect(await screen.findByText('临床助手已就绪')).toBeTruthy()
    expect(mutations).toHaveLength(0)
  })
})
