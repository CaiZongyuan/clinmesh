import type { AgentActivityEventCategory } from '@clinmesh/contracts/agent-capabilities'
import { create } from 'zustand'

export type AgentPresencePhase = AgentActivityEventCategory | 'idle'

export interface AgentPresenceRect {
  top: number
  left: number
  width: number
  height: number
}

export interface AgentPresenceTraceItem {
  id: string
  at: string
  category: AgentActivityEventCategory
  label: string
  source: 'ui' | 'his'
}

export interface AgentPresenceState {
  active: boolean
  sessionActive: boolean
  uiActionActive: boolean
  phase: AgentPresencePhase
  headline: string
  sublabel: string | null
  scanning: boolean
  cursor: {
    visible: boolean
    x: number
    y: number
    badge: string | null
    clicking: boolean
    phase: AgentActivityEventCategory
  }
  highlight: {
    visible: boolean
    rect: AgentPresenceRect | null
    label: string | null
    phase: AgentActivityEventCategory
  }
  recentEvents: AgentPresenceTraceItem[]
  effectsPaused: boolean
  onStopActiveRun: (() => void) | null
  setEffectsPaused: (paused: boolean) => void
  toggleEffectsPaused: () => void
  pushTraceEvent: (item: Omit<AgentPresenceTraceItem, 'id' | 'at'>) => void
  beginUiAction: (input: {
    category: AgentActivityEventCategory
    headline: string
    sublabel?: string | null
    badge?: string | null
    targetRect?: AgentPresenceRect | null
    triggerClickRipple?: boolean
    scan?: boolean
  }) => void
  finishUiAction: (settleMs?: number) => void
  syncSessionPresence: (input: {
    active: boolean
    phase: AgentPresencePhase
    headline: string
    sublabel?: string | null
    scanning?: boolean
    targetRect?: AgentPresenceRect | null
    highlightLabel?: string | null
    onStop?: (() => void) | null
  }) => void
  clearPresence: () => void
}

const PAUSED_STORAGE_KEY = 'clinmesh.agent-presence.effects-paused'

function readInitialPaused(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PAUSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writePaused(paused: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PAUSED_STORAGE_KEY, paused ? '1' : '0')
  } catch {
    // Ignore storage write errors in restricted browsing contexts.
  }
}

let settleTimer: number | null = null
let clickTimer: number | null = null
let scanTimer: number | null = null
let eventSeq = 0

function clearTimers(): void {
  if (typeof window === 'undefined') return
  if (settleTimer !== null) {
    window.clearTimeout(settleTimer)
    settleTimer = null
  }
  if (clickTimer !== null) {
    window.clearTimeout(clickTimer)
    clickTimer = null
  }
  if (scanTimer !== null) {
    window.clearTimeout(scanTimer)
    scanTimer = null
  }
}

export const useAgentPresenceStore = create<AgentPresenceState>((set, get) => ({
  active: false,
  sessionActive: false,
  uiActionActive: false,
  phase: 'idle',
  headline: '',
  sublabel: null,
  scanning: false,
  cursor: {
    visible: false,
    x: 0,
    y: 0,
    badge: null,
    clicking: false,
    phase: 'navigate',
  },
  highlight: {
    visible: false,
    rect: null,
    label: null,
    phase: 'navigate',
  },
  recentEvents: [],
  effectsPaused: readInitialPaused(),
  onStopActiveRun: null,

  setEffectsPaused: (paused: boolean) => {
    writePaused(paused)
    set({ effectsPaused: paused })
  },

  toggleEffectsPaused: () => {
    const next = !get().effectsPaused
    writePaused(next)
    set({ effectsPaused: next })
  },

  pushTraceEvent: (item) => {
    eventSeq += 1
    const entry: AgentPresenceTraceItem = {
      id: `ap-${eventSeq}`,
      at: new Date().toISOString(),
      ...item,
    }
    set(state => {
      const prev = state.recentEvents[0]
      if (prev && prev.category === item.category && prev.label === item.label && prev.source === item.source) {
        return state
      }
      return {
        recentEvents: [entry, ...state.recentEvents].slice(0, 12),
      }
    })
  },

  beginUiAction: ({
    category,
    headline,
    sublabel = null,
    badge = null,
    targetRect = null,
    triggerClickRipple = false,
    scan = false,
  }) => {
    clearTimers()
    get().pushTraceEvent({ category, label: headline, source: 'ui' })

    const hasRect = targetRect !== null && targetRect.width > 0 && targetRect.height > 0
    const nextCursorX = hasRect ? targetRect.left + targetRect.width * 0.5 : get().cursor.x
    const nextCursorY = hasRect ? targetRect.top + targetRect.height * 0.5 : get().cursor.y

    set({
      active: true,
      uiActionActive: true,
      phase: category,
      headline,
      sublabel,
      scanning: scan,
      cursor: hasRect
        ? {
            visible: true,
            x: nextCursorX,
            y: nextCursorY,
            badge: badge ?? headline,
            clicking: triggerClickRipple,
            phase: category,
          }
        : get().cursor,
      highlight: hasRect
        ? {
            visible: true,
            rect: targetRect,
            label: badge ?? headline,
            phase: category,
          }
        : {
            visible: false,
            rect: null,
            label: null,
            phase: category,
          },
    })

    if (typeof window !== 'undefined' && triggerClickRipple && hasRect) {
      clickTimer = window.setTimeout(() => {
        clickTimer = null
        set(state => ({
          cursor: { ...state.cursor, clicking: false },
        }))
      }, 520)
    }

    if (typeof window !== 'undefined' && scan) {
      scanTimer = window.setTimeout(() => {
        scanTimer = null
        set({ scanning: false })
      }, 1_400)
    }
  },

  finishUiAction: (settleMs = 950) => {
    const closeTransientUi = () => {
      set(state => {
        const stillActive = state.sessionActive
        return {
          uiActionActive: false,
          active: stillActive,
          phase: stillActive ? state.phase : 'idle',
          headline: stillActive ? state.headline : '',
          sublabel: stillActive ? state.sublabel : null,
          scanning: stillActive ? state.scanning : false,
          cursor: { ...state.cursor, visible: false, clicking: false },
          highlight: { ...state.highlight, visible: false },
        }
      })
    }

    if (typeof window === 'undefined' || settleMs <= 0) {
      closeTransientUi()
      return
    }
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = null
      closeTransientUi()
    }, settleMs)
  },

  syncSessionPresence: ({
    active,
    phase,
    headline,
    sublabel = null,
    scanning = false,
    targetRect = null,
    highlightLabel = null,
    onStop = null,
  }) => {
    const prev = get()
    if (!active) {
      // Session finished: exit presence mode cleanly once any in-flight UI click ripple settles
      if (!prev.uiActionActive) {
        clearTimers()
        set({
          active: false,
          sessionActive: false,
          uiActionActive: false,
          phase: 'idle',
          headline: '',
          sublabel: null,
          scanning: false,
          onStopActiveRun: null,
          cursor: { ...prev.cursor, visible: false, clicking: false },
          highlight: { ...prev.highlight, visible: false },
        })
      } else {
        set({ sessionActive: false, onStopActiveRun: null })
        prev.finishUiAction(650)
      }
      return
    }

    if (phase !== 'idle' && headline) {
      if (prev.headline !== headline || prev.phase !== phase) {
        prev.pushTraceEvent({ category: phase, label: headline, source: 'his' })
      }
    }
    const hasRect = targetRect !== null && targetRect.width > 0 && targetRect.height > 0
    set(state => ({
      active: true,
      sessionActive: true,
      phase,
      headline,
      sublabel,
      scanning: scanning || state.scanning,
      onStopActiveRun: onStop,
      // Backend HIS events highlight the target clinical region cleanly without faking cursor clicks
      highlight: hasRect
        ? {
            visible: true,
            rect: targetRect,
            label: highlightLabel ?? headline,
            phase: phase === 'idle' ? 'compute' : phase,
          }
        : state.cursor.visible
          ? state.highlight
          : { ...state.highlight, visible: false },
      cursor: state.cursor,
    }))
  },

  clearPresence: () => {
    clearTimers()
    set({
      active: false,
      sessionActive: false,
      uiActionActive: false,
      phase: 'idle',
      headline: '',
      sublabel: null,
      scanning: false,
      onStopActiveRun: null,
      cursor: {
        visible: false,
        x: 0,
        y: 0,
        badge: null,
        clicking: false,
        phase: 'navigate',
      },
      highlight: {
        visible: false,
        rect: null,
        label: null,
        phase: 'navigate',
      },
    })
  },
}))
