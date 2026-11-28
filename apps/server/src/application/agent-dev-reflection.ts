import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentDevReflection,
  AgentDevReflectionCategory,
  AgentDevReflectionTelemetry,
} from '@clinmesh/contracts/agent-sessions'
import {
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from '@earendil-works/pi-durable'

export type StoredDevReflection = {
  reflectionId: string
  source: 'watchdog' | 'agent-tool'
  category: AgentDevReflectionCategory
  title: string
  symptom: string
  rootCause: string
  suggestedFix: string
  affectedTools: string[]
  telemetry: {
    turnToolCalls: number
    turnErrors: number
    turnApprovals: number
    turnDurationMs: number
    topErrorCode: string | null
  }
  status: 'pending' | 'saved' | 'dismissed'
  savedPath: string | null
  createdAt: string
}

export type StoredDevReflectionsDoc = {
  items: StoredDevReflection[]
}

export const ClinMeshDevReflectionsDoc = defineDoc<StoredDevReflectionsDoc>({
  kind: 'clinmesh.dev_reflections',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
})

export interface DevReflectionConfig {
  readonly enabled?: boolean
  readonly outputDir?: string
  readonly consecutiveErrorThreshold?: number
  readonly maxTurnToolCalls?: number
  readonly maxTurnDurationMs?: number
  readonly maxTurnApprovals?: number
}

interface TurnFrictionState {
  startedAtMs: number
  toolCalls: number
  errors: number
  approvals: number
  consecutiveErrorCount: number
  lastErrorKey: string | null
  errorCodeCounts: Map<string, number>
  affectedTools: Set<string>
  agentReflectedThisTurn: boolean
  watchdogEmittedThisTurn: boolean
}

const DEFAULT_CONSECUTIVE_ERROR_THRESHOLD = 3
const DEFAULT_MAX_TURN_TOOL_CALLS = 12
const DEFAULT_MAX_TURN_DURATION_MS = 25_000
const DEFAULT_MAX_TURN_APPROVALS = 3

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, '../../../..')

export function isDevReflectionEnabled(override?: boolean): boolean {
  if (override !== undefined) return override
  const envFlag = process.env.CLINMESH_DEV_REFLECTION?.trim()
  if (envFlag === '0' || envFlag === 'false') return false
  if (envFlag === '1' || envFlag === 'true') return true
  return process.env.NODE_ENV !== 'production'
}

export function resolveDevReflectionDir(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim().length > 0) {
    return resolve(overrideDir)
  }
  return resolve(DEFAULT_REPO_ROOT, '.dev-reflections')
}

export function extractErrorCodeFromText(errorText: string): string {
  const codeMatch = errorText.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)
  if (codeMatch?.[1]) return codeMatch[1]
  if (/Validation failed/i.test(errorText)) return 'VALIDATION_FAILED'
  if (/does not exist/i.test(errorText)) return 'TOOL_NOT_FOUND'
  if (/HTTP_(\d{3})/.test(errorText)) return errorText.match(/HTTP_\d{3}/)?.[0] ?? 'HTTP_ERROR'
  if (/status"\s*:\s*(\d{3})/.test(errorText)) return `HTTP_${errorText.match(/status"\s*:\s*(\d{3})/)?.[1] ?? 'ERR'}`
  return 'TOOL_ERROR'
}

export function redactSensitiveDevText(text: string): string {
  return text
    .replaceAll(/\b(?:sk|pk)-[A-Za-z0-9._-]{8,}/g, '[REDACTED_CREDENTIAL]')
    .replaceAll(/(?:Bearer|token|api[_-]?key)[=:\s]+[A-Za-z0-9._-]{8,}/gi, '[REDACTED_CREDENTIAL]')
    .replaceAll(/cookie:\s*[^\n;]+/gi, 'cookie: [REDACTED]')
    .replaceAll(/authorization:\s*[^\n]+/gi, 'authorization: [REDACTED]')
}

function slugifyCategory(category: string): string {
  return category.replaceAll(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 32) || 'friction'
}

export function formatDevReflectionMarkdown(
  reflection: AgentDevReflection,
  meta: { roleCode: string; sessionId: string },
): string {
  const safe = (s: string) => redactSensitiveDevText(s).trim()
  const lines = [
    `# 开发反思工单：${safe(reflection.title)}`,
    '',
    `- **ID**：\`${reflection.reflectionId}\``,
    `- **时间**：${reflection.createdAt}`,
    `- **来源**：${reflection.source === 'watchdog' ? '自动摩擦探针（Dev Watchdog）' : '助手主动自检（dev_reflect_friction）'}`,
    `- **分类**：\`${reflection.category}\``,
    `- **角色 / 会话**：\`${meta.roleCode}\` / \`${meta.sessionId}\``,
    `- **受影响工具**：${reflection.affectedTools.length > 0 ? reflection.affectedTools.map(t => `\`${t}\``).join('、') : '未指定'}`,
    '',
    '## 运行遥测',
    '',
    `- 本轮工具调用：${reflection.telemetry.turnToolCalls} 次`,
    `- 本轮失败次数：${reflection.telemetry.turnErrors} 次（高频错误码：\`${reflection.telemetry.topErrorCode ?? '无'}\`）`,
    `- 本轮审批弹窗：${reflection.telemetry.turnApprovals} 次`,
    `- 本轮耗时：${(reflection.telemetry.turnDurationMs / 1_000).toFixed(1)}s`,
    '',
    '## 现象摘要',
    '',
    safe(reflection.symptom),
    '',
    '## 根因判断',
    '',
    safe(reflection.rootCause),
    '',
    '## 建议优化方案',
    '',
    safe(reflection.suggestedFix),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function persistDevReflectionToDisk(
  outputDir: string,
  reflection: AgentDevReflection,
  meta: { roleCode: string; sessionId: string },
): Promise<string> {
  const targetDir = resolve(outputDir)
  await mkdir(targetDir, { recursive: true })
  const datePrefix = reflection.createdAt.slice(0, 10)
  const shortId = reflection.reflectionId.replaceAll(/[^a-zA-Z0-9-]/g, '').slice(-10)
  const fileName = `${datePrefix}-${slugifyCategory(reflection.category)}-${shortId}.md`
  const fullPath = resolve(targetDir, fileName)
  const relToDir = relative(targetDir, fullPath)
  if (relToDir.startsWith('..') || isAbsolute(relToDir)) {
    throw new Error('Invalid dev reflection path.')
  }

  const markdown = formatDevReflectionMarkdown(reflection, meta)
  await writeFile(fullPath, markdown, 'utf8')

  const indexLine = JSON.stringify({
    reflectionId: reflection.reflectionId,
    createdAt: reflection.createdAt,
    source: reflection.source,
    category: reflection.category,
    title: redactSensitiveDevText(reflection.title),
    affectedTools: reflection.affectedTools,
    telemetry: reflection.telemetry,
    file: fileName,
  })
  await appendFile(resolve(targetDir, 'index.jsonl'), `${indexLine}\n`, 'utf8')

  const relToRepo = relative(DEFAULT_REPO_ROOT, fullPath).replaceAll('\\', '/')
  return relToRepo.startsWith('..') ? fileName : relToRepo
}

export interface DevReflectionRuntime {
  readonly enabled: boolean
  readonly outputDir: string
  readonly extension: Extension
  readonly tools: readonly ToolRegistration[]
  startTurn: (conversationId: number) => void
  recordToolOutcome: (
    conversationId: number,
    toolName: string,
    ok: boolean,
    errorText?: string,
  ) => string | null
  recordApprovalParked: (conversationId: number, operationId: string) => void
  getTelemetry: (conversationId: number) => AgentDevReflectionTelemetry
  buildFallbackWatchdogReflection: (conversationId: number) => StoredDevReflection | null
  clearConversation: (conversationId: number) => void
}

export function createDevReflectionRuntime(config: DevReflectionConfig = {}): DevReflectionRuntime {
  const enabled = isDevReflectionEnabled(config.enabled)
  const outputDir = resolveDevReflectionDir(config.outputDir)
  const consecutiveErrorThreshold = config.consecutiveErrorThreshold ?? DEFAULT_CONSECUTIVE_ERROR_THRESHOLD
  const maxTurnToolCalls = config.maxTurnToolCalls ?? DEFAULT_MAX_TURN_TOOL_CALLS
  const maxTurnDurationMs = config.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS
  const maxTurnApprovals = config.maxTurnApprovals ?? DEFAULT_MAX_TURN_APPROVALS

  const stateByConversation = new Map<number, TurnFrictionState>()

  const getOrCreateState = (conversationId: number): TurnFrictionState => {
    let st = stateByConversation.get(conversationId)
    if (st === undefined) {
      st = {
        startedAtMs: Date.now(),
        toolCalls: 0,
        errors: 0,
        approvals: 0,
        consecutiveErrorCount: 0,
        lastErrorKey: null,
        errorCodeCounts: new Map(),
        affectedTools: new Set(),
        agentReflectedThisTurn: false,
        watchdogEmittedThisTurn: false,
      }
      stateByConversation.set(conversationId, st)
    }
    return st
  }

  const getTelemetry = (conversationId: number): AgentDevReflectionTelemetry => {
    const st = stateByConversation.get(conversationId)
    if (st === undefined) {
      return {
        turnToolCalls: 0,
        turnErrors: 0,
        turnApprovals: 0,
        turnDurationMs: 0,
        topErrorCode: null,
      }
    }
    let topCode: string | null = null
    let topCount = 0
    for (const [code, count] of st.errorCodeCounts.entries()) {
      if (count > topCount) {
        topCount = count
        topCode = code
      }
    }
    return {
      turnToolCalls: st.toolCalls,
      turnErrors: st.errors,
      turnApprovals: st.approvals,
      turnDurationMs: Math.max(0, Date.now() - st.startedAtMs),
      topErrorCode: topCode,
    }
  }

  const startTurn = (conversationId: number): void => {
    if (!enabled) return
    stateByConversation.set(conversationId, {
      startedAtMs: Date.now(),
      toolCalls: 0,
      errors: 0,
      approvals: 0,
      consecutiveErrorCount: 0,
      lastErrorKey: null,
      errorCodeCounts: new Map(),
      affectedTools: new Set(),
      agentReflectedThisTurn: false,
      watchdogEmittedThisTurn: false,
    })
  }

  const recordToolOutcome = (
    conversationId: number,
    toolName: string,
    ok: boolean,
    errorText?: string,
  ): string | null => {
    if (!enabled) return null
    const st = getOrCreateState(conversationId)
    st.toolCalls += 1
    if (ok) {
      st.consecutiveErrorCount = 0
      st.lastErrorKey = null
      return null
    }

    st.errors += 1
    st.affectedTools.add(toolName)
    const code = extractErrorCodeFromText(errorText ?? '')
    st.errorCodeCounts.set(code, (st.errorCodeCounts.get(code) ?? 0) + 1)
    const key = `${toolName}:${code}`
    if (st.lastErrorKey === key) {
      st.consecutiveErrorCount += 1
    } else {
      st.lastErrorKey = key
      st.consecutiveErrorCount = 1
    }

    if (st.consecutiveErrorCount >= consecutiveErrorThreshold) {
      return `[DEV-WATCHDOG] 工具 ${toolName} 已连续 ${st.consecutiveErrorCount} 次触发 ${code}。请立即停止重复试探循环，向用户简要说明卡点，并调用 dev_reflect_friction 记录根因与优化建议（待开发者确认是否写入 .dev-reflections/）。`
    }
    if (st.toolCalls >= maxTurnToolCalls && st.errors >= 2) {
      return `[DEV-WATCHDOG] 本轮工具调用已达 ${st.toolCalls} 次（失败 ${st.errors} 次）。建议先收束回复，并调用 dev_reflect_friction 记录工具摩擦原因供开发优化。`
    }
    return null
  }

  const recordApprovalParked = (conversationId: number, operationId: string): void => {
    if (!enabled) return
    const st = getOrCreateState(conversationId)
    st.approvals += 1
    st.affectedTools.add(operationId)
  }

  const buildFallbackWatchdogReflection = (conversationId: number): StoredDevReflection | null => {
    if (!enabled) return null
    const st = stateByConversation.get(conversationId)
    if (st === undefined || st.agentReflectedThisTurn || st.watchdogEmittedThisTurn) {
      return null
    }
    const telemetry = getTelemetry(conversationId)
    const isApprovalFatigue = telemetry.turnApprovals >= maxTurnApprovals
    const isRepeatedError = telemetry.turnErrors >= consecutiveErrorThreshold
    const isSlowOrLoop = telemetry.turnToolCalls >= maxTurnToolCalls || telemetry.turnDurationMs >= maxTurnDurationMs

    if (!isApprovalFatigue && !isRepeatedError && !isSlowOrLoop) {
      return null
    }

    st.watchdogEmittedThisTurn = true
    const affectedTools = [...st.affectedTools].slice(0, 12)

    let category: AgentDevReflectionCategory = 'slow-loop'
    let title = '本轮工具执行偏慢或调用链过长'
    let symptom = `本轮共执行 ${telemetry.turnToolCalls} 次工具调用、耗时 ${(telemetry.turnDurationMs / 1_000).toFixed(1)}s。`
    let rootCause = '模型需要多次零散查询或重试才能凑齐接口前置字段/版本信息。'
    let suggestedFix = '检查高频场景是否缺少聚合快捷宏，或精简慢查询输出字段并补充 Playbook 引导。'

    if (isApprovalFatigue) {
      category = 'approval-fatigue'
      title = `单轮连续触发 ${telemetry.turnApprovals} 次医生确认弹窗`
      symptom = `本轮连续挂起 ${telemetry.turnApprovals} 次审批卡片，造成反复打断。`
      rootCause = '多项临床提交被拆分为逐条调用，未合并通过 batch_confirm_clinical_orders 一次确认。'
      suggestedFix = '将该组合流程纳入 batch_confirm_clinical_orders 或在系统提示词中强化批量提交优先级。'
    } else if (isRepeatedError) {
      const topCode = telemetry.topErrorCode ?? 'TOOL_ERROR'
      category = topCode.includes('CONFLICT') || topCode.includes('VERSION')
        ? 'version-conflict'
        : topCode === 'VALIDATION_FAILED'
          ? 'schema-friction'
          : 'tool-error'
      title = `工具连续出错（${topCode} × ${telemetry.turnErrors}）`
      symptom = `本轮工具调用出错 ${telemetry.turnErrors} 次（最高频错误：${topCode}），涉及：${affectedTools.join('、') || '未知工具'}。`
      rootCause = category === 'version-conflict'
        ? '上游查询可能遗漏了乐观锁版本号字段，或写操作后未刷新最新版本。'
        : category === 'schema-friction'
          ? '工具输入校验规则过严或缺少清晰示例，导致模型反复传参失败。'
          : '目标工具接口返回错误，可能需要改进错误提示或补充前置校验宏。'
      suggestedFix = '检查受影响工具的输入 schema 与输出精简逻辑（compactHisOperationOutput），确保关键版本号与有效枚举值完整透出。'
    }

    return {
      reflectionId: `refl-${randomUUID().slice(0, 12)}`,
      source: 'watchdog',
      category,
      title,
      symptom,
      rootCause,
      suggestedFix,
      affectedTools,
      telemetry,
      status: 'pending',
      savedPath: null,
      createdAt: new Date().toISOString(),
    }
  }

  const devReflectParams = {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [
          'missing-field',
          'schema-friction',
          'version-conflict',
          'approval-fatigue',
          'slow-loop',
          'ui-bridge-mismatch',
          'prompt-gap',
          'tool-error',
        ],
      },
      title: { type: 'string', description: '一句话概括问题标题（≤ 40 字）' },
      symptom: { type: 'string', description: '具体卡点现象（如某工具连续 409 或缺少某字段）' },
      rootCause: { type: 'string', description: '根因分析（指出缺失字段、不合理校验或缺少聚合宏）' },
      suggestedFix: { type: 'string', description: '可直接落地的研发优化建议（指明工具名、字段或 Playbook 改进点）' },
      affectedTools: {
        type: 'array',
        items: { type: 'string' },
        description: '涉及的工具名称列表',
      },
    },
    required: ['category', 'title', 'symptom', 'rootCause', 'suggestedFix'],
    additionalProperties: false,
  }

  const devReflectTool: ToolRegistration = defineTool({
    name: 'dev_reflect_friction',
    description: '【仅开发模式】当你遇到工具反复报错、字段缺失、参数校验摩擦、被迫多次弹窗确认或执行耗时过长时调用此工具，向开发者弹出「开发反思卡片」并询问是否记录到 .dev-reflections/ 优化清单。严禁包含真实患者敏感隐私或密钥。',
    parameters: devReflectParams,
    callers: ['model'],
    replay: 'safe',
    execute: async (raw, api, context) => {
      const input = (raw ?? {}) as {
        category: AgentDevReflectionCategory
        title: string
        symptom: string
        rootCause: string
        suggestedFix: string
        affectedTools?: string[]
      }
      const st = getOrCreateState(api.conversationId)
      st.agentReflectedThisTurn = true
      const telemetry = getTelemetry(api.conversationId)
      const affected = [
        ...new Set([
          ...(input.affectedTools ?? []),
          ...st.affectedTools,
        ]),
      ].slice(0, 12)

      const record: StoredDevReflection = {
        reflectionId: `refl-${randomUUID().slice(0, 12)}`,
        source: 'agent-tool',
        category: input.category,
        title: redactSensitiveDevText(input.title).slice(0, 140),
        symptom: redactSensitiveDevText(input.symptom).slice(0, 900),
        rootCause: redactSensitiveDevText(input.rootCause).slice(0, 1_100),
        suggestedFix: redactSensitiveDevText(input.suggestedFix).slice(0, 1_100),
        affectedTools: affected,
        telemetry,
        status: 'pending',
        savedPath: null,
        createdAt: new Date(api.now()).toISOString(),
      }

      await api.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshDevReflectionsDoc, api.conversationId)
        doc.items = [...doc.items.slice(-7), record]
      }, context)

      return {
        output: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            reflectionId: record.reflectionId,
            message: '已生成开发模式反思卡片，侧边栏将提示开发者选择「记录到开发目录（.dev-reflections/）」、「复制给研发 Agent」或「忽略」。',
          }),
        }],
      }
    },
  })

  const tools: readonly ToolRegistration[] = enabled ? [devReflectTool] : []
  const extension = defineExtension({
    name: 'clinmesh.dev_reflection',
    tools,
  })

  return {
    enabled,
    outputDir,
    extension,
    tools,
    startTurn,
    recordToolOutcome,
    recordApprovalParked,
    getTelemetry,
    buildFallbackWatchdogReflection,
    clearConversation: (conversationId: number) => {
      stateByConversation.delete(conversationId)
    },
  }
}
