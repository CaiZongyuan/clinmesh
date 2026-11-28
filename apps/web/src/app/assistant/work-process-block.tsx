import type { AgentContentBlock } from '@clinmesh/contracts/agent-sessions'
import { Badge } from '@clinmesh/ui/components/badge'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@clinmesh/ui/components/collapsible'
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  SparklesIcon,
  WrenchIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type ThinkingBlock = Extract<AgentContentBlock, { type: 'thinking' }>
type ToolCallBlock = Extract<AgentContentBlock, { type: 'tool-call' }>

const TOOL_DISPLAY_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  read_visible_case_summary: {
    zh: '读取当前可见病例摘要',
    en: 'Read visible case summary',
  },
  read_lab_results: {
    zh: '读取可见检验报告',
    en: 'Read visible lab results',
  },
  read_imaging_reports: {
    zh: '读取可见影像与检查报告',
    en: 'Read visible imaging & exam reports',
  },
  read_medication_orders: {
    zh: '读取可见处方与过敏史',
    en: 'Read visible medications & allergies',
  },
  read_vital_trends: {
    zh: '读取生命体征与问诊记录',
    en: 'Read vitals & consultation dialogue',
  },
  propose_clinician_preference: {
    zh: '提交医生工作偏好提案',
    en: 'Propose clinician preference',
  },
}

function formatToolDisplayName(name: string, zh: boolean): string {
  const entry = TOOL_DISPLAY_LABELS[name]
  if (entry !== undefined) return zh ? entry.zh : entry.en
  return name
}

function formatDurationBadge(durationMs: number | null | undefined, zh: boolean): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return ''
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const sec = (durationMs / 1000).toFixed(1)
  return zh ? `${sec} 秒` : `${sec}s`
}

function useLiveElapsedSeconds(running: boolean, startedAtIso: string): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || typeof window === 'undefined') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const startedMs = Date.parse(startedAtIso)
  if (!Number.isFinite(startedMs)) return 0
  return Math.max(0, Math.floor((now - startedMs) / 1000))
}

function ToolRow({
  block,
  zh,
}: {
  block: ToolCallBlock
  zh: boolean
}): React.JSX.Element {
  const statusLabel = block.status === 'done'
    ? (zh ? '已完成' : 'Done')
    : block.status === 'error'
      ? (zh ? '失败' : 'Error')
      : block.status === 'running'
        ? (zh ? '执行中' : 'Running')
        : (zh ? '等待中' : 'Pending')

  const friendlyName = formatToolDisplayName(block.name, zh)

  return (
    <Collapsible className="rounded-md">
      <CollapsibleTrigger
        aria-label={`${friendlyName} (${block.name})`}
        className="group/tool-trigger cm-work-tool-trigger"
        data-testid="assistant-tool-toggle"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {block.status === 'running' || block.status === 'pending' ? (
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-info" />
          ) : block.status === 'error' ? (
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          )}
          <span className="truncate font-medium">{friendlyName}</span>
          <code className="hidden truncate font-mono text-[0.6875rem] text-muted-foreground sm:inline">
            {block.name}
          </code>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Badge
            className="px-1.5 py-0 text-[0.6875rem]"
            variant={block.status === 'error' ? 'destructive' : 'secondary'}
          >
            {statusLabel}
          </Badge>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/tool-trigger:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="cm-work-tool-detail" data-testid="assistant-tool-detail">
          <div className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
            <WrenchIcon aria-hidden="true" className="size-3 shrink-0" />
            <span>{block.name}</span>
          </div>
          <div>
            <div className="mb-1 text-[0.6875rem] font-medium text-muted-foreground">
              {zh ? '调用参数' : 'Arguments'}
            </div>
            <pre className="cm-work-tool-pre cm-assistant-scroll">
              <code>{block.argumentsJson}</code>
            </pre>
          </div>
          {block.output !== undefined ? (
            <div>
              <div className="mb-1 text-[0.6875rem] font-medium text-muted-foreground">
                {zh ? '返回结果' : 'Result'}
              </div>
              <pre className="cm-work-tool-pre cm-assistant-scroll">
                <code>{block.output}</code>
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

export interface WorkProcessBlockProps {
  thinkingBlocks: readonly ThinkingBlock[]
  toolBlocks: readonly ToolCallBlock[]
  streaming: boolean
  startedAtIso: string
  durationMs?: number | null | undefined
  defaultOpenWhenStreaming?: boolean
  zh: boolean
}

/**
 * Claude Desktop-style unified, default-collapsed "Work process" disclosure block.
 * Consolidates thinking traces and tool calls into a single calm line that expands on demand,
 * or expands automatically while streaming when the user opts into "Expand live thinking".
 */
export function WorkProcessBlock({
  thinkingBlocks,
  toolBlocks,
  streaming,
  startedAtIso,
  durationMs,
  defaultOpenWhenStreaming = false,
  zh,
}: WorkProcessBlockProps): React.JSX.Element | null {
  const hasThinking = thinkingBlocks.length > 0
  const toolCount = toolBlocks.length
  const elapsedSec = useLiveElapsedSeconds(streaming, startedAtIso)
  const [open, setOpen] = useState<boolean>(() => Boolean(streaming && defaultOpenWhenStreaming))
  const userToggledRef = useRef(false)

  useEffect(() => {
    if (userToggledRef.current) return
    if (streaming && defaultOpenWhenStreaming) {
      setOpen(true)
    }
  }, [defaultOpenWhenStreaming, streaming])

  if (!streaming && !hasThinking && toolCount === 0) {
    return null
  }

  const hasToolError = toolBlocks.some(block => block.status === 'error')
  const runningTool = toolBlocks.find(block => block.status === 'running' || block.status === 'pending')

  const titleLabel = streaming
    ? (runningTool !== undefined
        ? (zh ? `正在${formatToolDisplayName(runningTool.name, true)}…` : `Running ${formatToolDisplayName(runningTool.name, false)}…`)
        : (zh ? '思考中…' : 'Thinking…'))
    : (toolCount > 0 && hasThinking
        ? (zh ? '工作过程' : 'Work process')
        : hasThinking
          ? (zh ? '思考过程' : 'Thinking process')
          : (zh ? '工具调用' : 'Tool steps'))

  const metaParts: string[] = []
  if (streaming) {
    if (elapsedSec > 0) metaParts.push(zh ? `${elapsedSec} 秒` : `${elapsedSec}s`)
    if (toolCount > 0) metaParts.push(zh ? `${toolCount} 个工具` : `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)
  } else {
    const dur = formatDurationBadge(durationMs, zh)
    if (dur.length > 0) metaParts.push(dur)
    if (hasThinking && toolCount > 0) {
      metaParts.push(zh ? `含思考 · ${toolCount} 个工具` : `thinking · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)
    } else if (toolCount > 0) {
      metaParts.push(zh ? `${toolCount} 个工具` : `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)
    }
  }
  const metaText = metaParts.join(' · ')

  return (
    <Collapsible
      className="cm-work-process"
      data-testid="assistant-work-process"
      onOpenChange={(nextOpen) => {
        userToggledRef.current = true
        setOpen(nextOpen)
      }}
      open={open}
    >
      <CollapsibleTrigger
        aria-label={metaText.length > 0 ? `${titleLabel}（${metaText}）` : titleLabel}
        className="group/work-trigger cm-work-process-trigger"
        data-testid="assistant-work-process-toggle"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {streaming ? (
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-info" />
          ) : hasToolError ? (
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
          ) : hasThinking ? (
            <SparklesIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          )}
          <span className="truncate font-medium text-foreground">{titleLabel}</span>
          {metaText.length > 0 ? (
            <span className="truncate text-muted-foreground tabular-nums">{metaText}</span>
          ) : null}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/work-trigger:rotate-90"
        />
      </CollapsibleTrigger>

      <CollapsiblePanel>
        <div className="cm-work-process-body" data-testid="assistant-work-process-body">
          {thinkingBlocks.map((block, index) => (
            <div className="space-y-1" key={`thinking-${index}`}>
              <div className="text-[0.6875rem] font-medium text-muted-foreground">
                {streaming ? (zh ? '实时推理' : 'Reasoning') : (zh ? '思考过程' : 'Thought process')}
              </div>
              <p className="cm-work-thinking-text">
                {block.redacted
                  ? (zh ? '（思考内容已由安全策略隐藏）' : '(Thinking redacted)')
                  : block.thinking}
              </p>
            </div>
          ))}

          {toolBlocks.length > 0 ? (
            <div className="space-y-1">
              {toolBlocks.map(block => (
                <ToolRow block={block} key={block.callId} zh={zh} />
              ))}
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}
