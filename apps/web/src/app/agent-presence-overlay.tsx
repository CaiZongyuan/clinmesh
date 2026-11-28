import type { AgentActivityEventCategory } from '@clinmesh/contracts/agent-capabilities'
import { ChevronDownIcon, ChevronUpIcon, SquareIcon } from 'lucide-react'
import { useState } from 'react'
import { useAgentPresenceStore } from './agent-presence-store.ts'

const PHASE_LABEL_ZH: Record<AgentActivityEventCategory, string> = {
  perceive: '感知',
  navigate: '导航',
  draft: '起草',
  compute: '检索',
  verify: '核验',
  approval: '待确认',
  revert: '撤销',
}

const PHASE_LABEL_EN: Record<AgentActivityEventCategory, string> = {
  perceive: 'Read',
  navigate: 'Navigate',
  draft: 'Draft',
  compute: 'Analyze',
  verify: 'Verify',
  approval: 'Approval',
  revert: 'Revert',
}

export function AgentPresenceOverlay({ locale = 'zh-CN' }: { locale?: 'zh-CN' | 'en-US' }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const active = useAgentPresenceStore(s => s.active)
  const phase = useAgentPresenceStore(s => s.phase)
  const headline = useAgentPresenceStore(s => s.headline)
  const sublabel = useAgentPresenceStore(s => s.sublabel)
  const scanning = useAgentPresenceStore(s => s.scanning)
  const cursor = useAgentPresenceStore(s => s.cursor)
  const highlight = useAgentPresenceStore(s => s.highlight)
  const recentEvents = useAgentPresenceStore(s => s.recentEvents)
  const effectsPaused = useAgentPresenceStore(s => s.effectsPaused)
  const onStopActiveRun = useAgentPresenceStore(s => s.onStopActiveRun)
  const [traceOpen, setTraceOpen] = useState(false)

  const reduceMotionAttr = typeof document !== 'undefined'
    && document.documentElement.dataset.reduceMotion === 'true'
  const fxDisabled = effectsPaused || reduceMotionAttr
  const showVisualFx = !fxDisabled
  const phaseBadge = phase === 'idle'
    ? null
    : (zh ? PHASE_LABEL_ZH[phase] : PHASE_LABEL_EN[phase])

  return (
    <div data-agent-hidden="" data-testid="agent-presence-root">
      {/* 1. Agent Glow / Active Border */}
      <div
        aria-hidden="true"
        className="cm-presence-border"
        data-active={active && showVisualFx ? 'true' : 'false'}
        data-paused={fxDisabled ? 'true' : 'false'}
        data-phase={phase}
        data-testid="agent-presence-border"
      />

      {/* 2. Perception Visualization / Scanning Beam */}
      <div
        aria-hidden="true"
        className="cm-presence-scan"
        data-paused={fxDisabled ? 'true' : 'false'}
        data-scanning={active && scanning && showVisualFx ? 'true' : 'false'}
        data-testid="agent-presence-scan"
      >
        <div className="cm-presence-scan-beam" />
      </div>

      {/* 3. Element Highlighting / Action Overlay */}
      {highlight.rect !== null ? (
        <div
          aria-hidden="true"
          className="cm-presence-highlight"
          data-phase={highlight.phase}
          data-testid="agent-presence-highlight"
          data-visible={active && highlight.visible && showVisualFx ? 'true' : 'false'}
          style={{
            transform: `translate3d(${Math.round(highlight.rect.left - 3)}px, ${Math.round(highlight.rect.top - 3)}px, 0)`,
            width: `${Math.round(highlight.rect.width + 6)}px`,
            height: `${Math.round(highlight.rect.height + 6)}px`,
          }}
        >
          {highlight.label ? (
            <span className="cm-presence-highlight-tag">{highlight.label}</span>
          ) : null}
        </div>
      ) : null}

      {/* 4. Virtual Agent Cursor (decoupled, never hijacks real mouse) */}
      <div
        aria-hidden="true"
        className="cm-presence-cursor"
        data-clicking={cursor.clicking ? 'true' : 'false'}
        data-paused={fxDisabled ? 'true' : 'false'}
        data-phase={cursor.phase}
        data-testid="agent-presence-cursor"
        data-visible={active && cursor.visible && showVisualFx ? 'true' : 'false'}
        style={{
          transform: `translate3d(${Math.round(cursor.x)}px, ${Math.round(cursor.y)}px, 0)`,
        }}
      >
        <span className="cm-presence-ripple" />
        <svg
          aria-hidden="true"
          className="cm-presence-cursor-arrow"
          fill="none"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4.5 3.5L10.2 20.2L13.1 13.7L19.6 10.8L4.5 3.5Z"
            fill="currentColor"
            stroke="white"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
        {cursor.badge ? (
          <span className="cm-presence-cursor-pill">
            {zh ? `助手 · ${cursor.badge}` : `Agent · ${cursor.badge}`}
          </span>
        ) : null}
      </div>

      {/* 5. Minimal Floating Agent Activity HUD (FX toggle lives cleanly in Appearance Settings) */}
      {active ? (
        <div className="cm-presence-hud-anchor">
          <div
            aria-label={zh ? '临床助手实时活动状态' : 'Clinician assistant live activity'}
            className="cm-presence-hud"
            data-testid="agent-presence-hud"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="cm-presence-hud-dot"
                data-paused={fxDisabled ? 'true' : 'false'}
                data-phase={phase}
              />
              {phaseBadge ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-foreground">
                  {phaseBadge}
                </span>
              ) : null}
              <span
                aria-live="polite"
                className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                role="status"
              >
                {headline || (zh ? '临床助手正在协同处理当前病例' : 'Assistant is working on this case')}
              </span>
              {sublabel ? (
                <span className="hidden max-w-36 truncate text-[0.6875rem] text-muted-foreground sm:inline">
                  {sublabel}
                </span>
              ) : null}

              <div className="flex shrink-0 items-center gap-1">
                {recentEvents.length > 0 ? (
                  <button
                    aria-expanded={traceOpen}
                    aria-label={zh ? '展开助手实时操作轨迹' : 'Toggle assistant activity trace'}
                    className="cm-presence-hud-btn"
                    data-testid="agent-presence-trace-toggle"
                    onClick={() => setTraceOpen(prev => !prev)}
                    type="button"
                  >
                    {traceOpen ? <ChevronUpIcon aria-hidden="true" className="size-3.5" /> : <ChevronDownIcon aria-hidden="true" className="size-3.5" />}
                    <span>{recentEvents.length}</span>
                  </button>
                ) : null}

                {onStopActiveRun ? (
                  <button
                    className="cm-presence-hud-btn"
                    data-testid="agent-presence-stop-btn"
                    data-tone="danger"
                    onClick={onStopActiveRun}
                    type="button"
                  >
                    <SquareIcon aria-hidden="true" className="size-3 fill-current" />
                    <span>{zh ? '停止' : 'Stop'}</span>
                  </button>
                ) : null}
              </div>
            </div>

            {traceOpen && recentEvents.length > 0 ? (
              <ol
                aria-label={zh ? '最近实时操作事件' : 'Recent live agent events'}
                className="max-h-36 space-y-1 overflow-auto border-t border-border/70 pt-1.5 text-[0.6875rem]"
                data-testid="agent-presence-trace-list"
              >
                {recentEvents.slice(0, 6).map(item => (
                  <li className="flex items-center gap-1.5 text-muted-foreground" key={item.id}>
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[0.625rem] uppercase text-foreground">
                      {item.source === 'ui' ? 'UI' : 'HIS'}
                    </span>
                    <span className="shrink-0 font-medium text-foreground">
                      {zh ? PHASE_LABEL_ZH[item.category] : PHASE_LABEL_EN[item.category]}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
