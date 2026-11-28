import type { ModelCallSummary } from '@clinmesh/contracts/agent-sessions'
import { Button } from '@clinmesh/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clinmesh/ui/components/tooltip'

export const CONTEXT_RING_WARN_THRESHOLD = 0.7
export const CONTEXT_RING_CRITICAL_THRESHOLD = 0.9

export function computeContextOccupancy(
  latestCall?: ModelCallSummary | null,
  defaultContextWindow = 128_000,
): {
  usedTokens: number
  contextWindow: number
  ratio: number
  pct: number
  level: 'normal' | 'warn' | 'critical'
} {
  const contextWindow = latestCall && latestCall.contextWindow > 0
    ? latestCall.contextWindow
    : Math.max(1, defaultContextWindow)
  const usedTokens = latestCall ? Math.max(0, latestCall.usage.promptTokens) : 0
  const ratio = usedTokens > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0
  const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)))
  const level: 'normal' | 'warn' | 'critical' = ratio >= CONTEXT_RING_CRITICAL_THRESHOLD
    ? 'critical'
    : ratio >= CONTEXT_RING_WARN_THRESHOLD
      ? 'warn'
      : 'normal'
  return { usedTokens, contextWindow, ratio, pct, level }
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 100_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`
  return String(Math.max(0, Math.round(tokens)))
}

export interface ContextOccupancyRingProps {
  latestCall?: ModelCallSummary | null | undefined
  defaultContextWindow?: number
  open: boolean
  onToggle: () => void
  zh: boolean
}

/**
 * Compact circular SVG context window occupancy ring placed beside Send/Stop
 * inside the assistant composer footer (dsh-context / ontology-plus style).
 */
export function ContextOccupancyRing({
  latestCall,
  defaultContextWindow = 128_000,
  open,
  onToggle,
  zh,
}: ContextOccupancyRingProps): React.JSX.Element {
  const { usedTokens, contextWindow, ratio, pct, level } = computeContextOccupancy(
    latestCall,
    defaultContextWindow,
  )

  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  const dash = usedTokens > 0 ? Math.max(1.2, ratio * circumference) : 0

  const pctLabel = usedTokens > 0 && pct === 0 ? '<1%' : `${pct}%`
  const tooltipText = latestCall
    ? (zh
        ? `上下文窗口 ${pctLabel} · ${usedTokens.toLocaleString('en-US')} / ${contextWindow.toLocaleString('en-US')} tokens（点击检查详情或输入 /context）`
        : `Context window ${pctLabel} · ${usedTokens.toLocaleString('en-US')} / ${contextWindow.toLocaleString('en-US')} tokens (click or type /context)`)
    : (zh
        ? '查看上下文检查器（尚未发起模型调用，也可输入 /context）'
        : 'Open Context Inspector (no calls yet; or type /context)')

  const ariaLabel = zh
    ? `上下文窗口占用 ${pctLabel}，查看上下文详情`
    : `Context window ${pctLabel} used, toggle Context Inspector`

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            aria-expanded={open}
            aria-label={ariaLabel}
            className="cm-context-ring-btn"
            data-active={open ? 'true' : 'false'}
            data-level={level}
            data-pct={String(pct)}
            data-testid="context-occupancy-ring"
            onClick={onToggle}
            size="xs"
            type="button"
            variant="ghost"
          />
        )}
      >
        <svg
          aria-hidden="true"
          className="size-4 shrink-0"
          viewBox="0 0 18 18"
        >
          <circle
            className="cm-context-ring-track"
            cx="9"
            cy="9"
            fill="none"
            r={radius}
            strokeWidth="2.2"
          />
          {dash > 0 ? (
            <circle
              className="cm-context-ring-value"
              cx="9"
              cy="9"
              fill="none"
              r={radius}
              strokeDasharray={`${dash} ${circumference}`}
              strokeLinecap="round"
              strokeWidth="2.2"
              transform="rotate(-90 9 9)"
            />
          ) : null}
        </svg>
        <span className="text-[0.6875rem] font-medium">
          {usedTokens > 0 ? `${formatCompactTokens(usedTokens)} · ${pctLabel}` : '0%'}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span>{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  )
}
