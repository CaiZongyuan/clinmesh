import { createAgent, registerTools, type AgentAction, type AgentComponent } from '@ui-sdk/react/agent'
import { createHistory, stageChanges } from '@ui-sdk/react/history'
import type { ObservedChange } from '@ui-sdk/react/observe'

export interface PendingUiConfirmation {
  id: string
  confirm: string
  label: string | undefined
  ref: string
  action: string
  args: unknown[]
  resolve: (approved: boolean) => void
}

export type ConfirmPolicyMode = 'deny' | 'allow' | 'interactive'

export interface UiNavigateResult {
  ok: boolean
  matchedLabel?: string
  matchedValue?: string
  previousValue?: unknown
  tabsRef?: string
  tabsLabel?: string
  targetElement?: HTMLElement | null
  availableTargets?: string[]
  error?: string
}

export interface ClinMeshUiAgentBridge {
  readonly agent: ReturnType<typeof createAgent>
  readonly history: ReturnType<typeof createHistory>
  snapshot(): AgentComponent[]
  scopedSnapshot(selector?: string): AgentComponent[]
  query(input: Parameters<ReturnType<typeof createAgent>['query']>[0]): ReturnType<ReturnType<typeof createAgent>['query']>
  navigate(target: string, container?: string): Promise<UiNavigateResult>
  findTargetElement(ref: string, itemLabel?: string): HTMLElement | null
  act(
    input: Parameters<ReturnType<typeof createAgent>['act']>[0],
    options?: { protectHumanEdits?: boolean; signal?: AbortSignal },
  ): Promise<{
    result: Awaited<ReturnType<ReturnType<typeof createAgent>['act']>>
    blockedHumanEdits: Array<{ ref: string; label: string; attemptedValue: unknown; preservedValue: unknown }>
    needsClinicianConfirm?: { confirmMessage: string; ref: string; label?: string }
  }>
  stage(
    changes: Array<{ ref: string; key?: string; value: unknown }>,
    options?: { protectHumanEdits?: boolean },
  ): Promise<{
    applied: ReadonlyArray<{ ref: string; key: string; before: unknown; value: unknown }>
    skippedHumanEdited: Array<{ ref: string; label: string; attemptedValue: unknown; preservedValue: unknown }>
    revert: () => Promise<unknown>
  }>
  undoAgent(): Promise<unknown>
  drainHumanChanges(): ObservedChange[]
  getHumanEditedLabels(): string[]
  clearHumanEdits(): void
  setConfirmPolicy(mode: ConfirmPolicyMode): void
  getConfirmLog(): Array<{ confirm: string; ref: string; label?: string; action: string; approved: boolean }>
  getPendingConfirmations(): Array<Omit<PendingUiConfirmation, 'resolve'>>
  resolveConfirmation(id: string, approved: boolean): boolean
}

let confirmPolicy: ConfirmPolicyMode = 'deny'
const confirmLog: Array<{ confirm: string; ref: string; label?: string; action: string; approved: boolean }> = []
const pendingConfirmations = new Map<string, PendingUiConfirmation>()
const recentHumanChanges: ObservedChange[] = []
const humanEditedByLabel = new Map<string, { ref: string; value: unknown }>()
const humanEditedByRef = new Map<string, { label: string; value: unknown }>()

const SECTION_SYNONYM_GROUPS: ReadonlyArray<readonly string[]> = [
  ['consultation', '问诊记录', '问诊对话', '患者对话', '患者问诊', '问诊', '对话', '接诊对话'],
  ['record', '病历记录', '结构化病历', '门诊病历', '病历文书', '病历', 'medical record', 'clinical document'],
  ['diagnosis', '诊断', '临床诊断', '初步诊断'],
  ['laboratory', '检验检查', '检验', '检查', '化验', '辅助检查', '影像', '病理'],
  ['prescription', '处方', '用药', '门诊处方', '开药', '药物治疗'],
  ['orders', '医嘱', '医嘱管理', '长期医嘱', '临时医嘱'],
  ['discharge', '出院', '出院办理', '出院小结'],
]

function normalizeNavText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll(/[「」『』【】[\]()（）\s·•:：]/g, '')
    .replace(/(页签|标签页|标签|分区|面板|栏位|栏目|页面|栏|tab|panel|section)$/i, '')
}

function expandTargetAliases(target: string): string[] {
  const norm = normalizeNavText(target)
  const rawLower = target.trim().toLowerCase()
  const aliases = new Set<string>([rawLower, norm].filter(Boolean))
  for (const group of SECTION_SYNONYM_GROUPS) {
    const normalizedGroup = group.map(normalizeNavText)
    if (
      normalizedGroup.some(g => g === norm || (norm.length >= 2 && (g.includes(norm) || norm.includes(g))))
    ) {
      for (const item of group) {
        aliases.add(item.toLowerCase())
        aliases.add(normalizeNavText(item))
      }
    }
  }
  return [...aliases]
}

function scoreTargetMatch(candidateValue: string, candidateLabel: string, aliases: readonly string[]): number {
  const valNorm = normalizeNavText(candidateValue)
  const labelNorm = normalizeNavText(candidateLabel)
  const valLower = candidateValue.trim().toLowerCase()
  const labelLower = candidateLabel.trim().toLowerCase()

  let best = 0
  for (const alias of aliases) {
    if (!alias) continue
    if (alias === valLower || alias === labelLower || alias === valNorm || alias === labelNorm) {
      best = Math.max(best, 100)
    } else if (alias.length >= 2 && (labelNorm.includes(alias) || valNorm.includes(alias))) {
      best = Math.max(best, 75)
    } else if (labelNorm.length >= 2 && alias.includes(labelNorm)) {
      best = Math.max(best, 60)
    }
  }
  return best
}

function isHiddenFromAgent(el: Element | null): boolean {
  if (!el) return true
  if (el.closest('[data-agent-hidden]')) return true
  return false
}

function extractTabItems(entry: AgentComponent): Array<{ value: string; label: string }> {
  const items = 'items' in entry && Array.isArray(entry.items) ? entry.items : []
  const parsed: Array<{ value: string; label: string }> = []
  for (const raw of items) {
    if (typeof raw === 'string') {
      parsed.push({ value: raw, label: raw })
    } else if (raw && typeof raw === 'object') {
      const rec = raw as { value?: unknown; label?: unknown }
      const value = typeof rec.value === 'string' ? rec.value : String(rec.value ?? '')
      const label = typeof rec.label === 'string' && rec.label.trim().length > 0 ? rec.label.trim() : value
      if (value || label) parsed.push({ value: value || label, label })
    }
  }
  return parsed
}

function findVisibleElementInMain(targetText: string, preferRole?: 'tab' | 'field'): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const root: ParentNode = document.querySelector('main') ?? document.body
  const aliases = expandTargetAliases(targetText)

  const checkCandidates = (selector: string): HTMLElement | null => {
    let bestEl: HTMLElement | null = null
    let bestScore = 0
    for (const node of root.querySelectorAll<HTMLElement>(selector)) {
      if (isHiddenFromAgent(node)) continue
      if (node.closest('[hidden]')) continue
      const aria = node.getAttribute('aria-label') ?? ''
      const id = node.id ?? ''
      const text = (node.textContent ?? '').trim().slice(0, 60)
      const score = Math.max(
        scoreTargetMatch(id, aria, aliases),
        scoreTargetMatch('', text, aliases),
      )
      if (score > bestScore) {
        bestScore = score
        bestEl = node
      }
    }
    return bestScore >= 60 ? bestEl : null
  }

  if (preferRole === 'tab') {
    const tab = checkCandidates('[role="tab"]')
    if (tab) return tab
  }

  if (preferRole === 'field') {
    for (const labelEl of root.querySelectorAll<HTMLLabelElement>('label')) {
      if (isHiddenFromAgent(labelEl)) continue
      const text = (labelEl.textContent ?? '').trim()
      if (scoreTargetMatch('', text, aliases) >= 60) {
        if (labelEl.htmlFor) {
          const ctrl = document.getElementById(labelEl.htmlFor)
          if (ctrl instanceof HTMLElement && !isHiddenFromAgent(ctrl)) return ctrl
        }
        const nested = labelEl.querySelector<HTMLElement>('input, textarea, select, [role="combobox"]')
        if (nested && !isHiddenFromAgent(nested)) return nested
      }
    }
    const ctrl = checkCandidates('input, textarea, select, [role="combobox"]')
    if (ctrl) return ctrl
  }

  return (
    checkCandidates('[role="tab"]')
    ?? checkCandidates('input, textarea, select, [role="combobox"], [role="switch"], [role="checkbox"]')
    ?? checkCandidates('button, a, [role="button"]')
  )
}

function findMatchingTabStep(
  target: string,
  snapshot: AgentComponent[],
  container?: string,
): { tabs: AgentComponent; value: string; label: string; score: number } | null {
  const aliases = expandTargetAliases(target)
  const containerNorm = container ? normalizeNavText(container) : ''
  const tabsComponents = snapshot.filter(entry => entry.component === 'tabs')
  let best: { tabs: AgentComponent; value: string; label: string; score: number } | null = null

  for (const tabs of tabsComponents) {
    if (containerNorm && tabs.label && !normalizeNavText(tabs.label).includes(containerNorm)) {
      continue
    }
    const items = extractTabItems(tabs)
    for (const item of items) {
      const score = scoreTargetMatch(item.value, item.label, aliases)
      if (score > (best?.score ?? 0)) {
        best = { tabs, value: item.value, label: item.label, score }
      }
    }
  }

  // Fallback: inspect live [role="tab"] elements in DOM if ui-sdk snapshot omitted items (e.g. >10 items or overflow)
  if ((best === null || best.score < 60) && typeof document !== 'undefined' && tabsComponents.length > 0) {
    const root: ParentNode = document.querySelector('main') ?? document.body
    for (const tabEl of root.querySelectorAll<HTMLElement>('[role="tab"]')) {
      if (isHiddenFromAgent(tabEl)) continue
      const aria = tabEl.getAttribute('aria-label')?.trim() ?? ''
      const visibleText = (tabEl.textContent ?? '').trim().slice(0, 60)
      const dataVal = tabEl.getAttribute('data-value') ?? tabEl.id.split('-').at(-1) ?? ''
      const label = aria || visibleText
      const score = Math.max(
        scoreTargetMatch(dataVal, label, aliases),
        scoreTargetMatch('', visibleText, aliases),
      )
      if (score > (best?.score ?? 0)) {
        const primaryTabs = tabsComponents[0]!
        best = { tabs: primaryTabs, value: dataVal || label, label, score }
      }
    }
  }

  return best && best.score >= 60 ? best : null
}

function recordHumanChange(change: ObservedChange): void {
  if (change.source === 'agent' || change.source === 'programmatic') return
  recentHumanChanges.push(change)
  if (recentHumanChanges.length > 50) recentHumanChanges.shift()
  if (change.key === 'value' || change.key === 'checked') {
    const label = change.label ?? change.ref
    humanEditedByLabel.set(label.toLowerCase(), { ref: change.ref, value: change.value })
    humanEditedByRef.set(change.ref, { label, value: change.value })
  }
}

function isStepTargetingHumanEdit(ref: string, snapshot: AgentComponent[]): { label: string; preservedValue: unknown } | null {
  const byRef = humanEditedByRef.get(ref)
  if (byRef !== undefined) {
    const current = snapshot.find(c => c.ref === ref)
    return { label: byRef.label, preservedValue: current && 'value' in current ? current.value : byRef.value }
  }
  const lower = ref.trim().toLowerCase()
  const byLabel = humanEditedByLabel.get(lower)
  if (byLabel !== undefined) {
    const current = snapshot.find(c => c.ref === byLabel.ref || c.label?.toLowerCase() === lower)
    return { label: current?.label ?? ref, preservedValue: current && 'value' in current ? current.value : byLabel.value }
  }
  const matched = snapshot.find(c => c.label?.toLowerCase().includes(lower) && humanEditedByRef.has(c.ref))
  if (matched !== undefined) {
    return { label: matched.label ?? matched.ref, preservedValue: 'value' in matched ? matched.value : undefined }
  }
  return null
}

async function handleAllow(step: AgentAction, { signal }: { signal: AbortSignal }): Promise<boolean> {
  // Blacklist-first default-allow: ONLY controls explicitly marked data-agent-confirm require gating
  if (!step.confirm) return true
  if (confirmPolicy === 'allow') {
    confirmLog.push({ confirm: step.confirm, ref: step.ref, ...(step.label ? { label: step.label } : {}), action: step.action, approved: true })
    return true
  }
  if (confirmPolicy === 'deny') {
    confirmLog.push({ confirm: step.confirm, ref: step.ref, ...(step.label ? { label: step.label } : {}), action: step.action, approved: false })
    return false
  }
  return new Promise<boolean>((resolve) => {
    const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cleanup = () => {
      pendingConfirmations.delete(id)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (approved: boolean) => {
      cleanup()
      confirmLog.push({ confirm: step.confirm!, ref: step.ref, ...(step.label ? { label: step.label } : {}), action: step.action, approved })
      resolve(approved)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    pendingConfirmations.set(id, {
      id,
      confirm: step.confirm!,
      label: step.label,
      ref: step.ref,
      action: step.action,
      args: step.args,
      resolve: finish,
    })
  })
}

const agent = createAgent({ allow: handleAllow })
const history = createHistory(agent)
agent.subscribe(recordHumanChange)

const unregisterWebMcp = registerTools(agent, { allow: () => true })
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterWebMcp()
    history.destroy()
  })
}

export const clinmeshUiAgentBridge: ClinMeshUiAgentBridge = {
  agent,
  history,
  snapshot() {
    return agent.snapshot().filter(entry => !entry.offPage)
  },
  scopedSnapshot(selector?: string) {
    const all = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    if (!selector) return all
    const container = document.querySelector(selector)
    if (!container) return all
    const labelsInScope = new Set<string>()
    for (const el of container.querySelectorAll('label, [aria-label], button, [role="tab"], [role="tablist"], [role="combobox"], h1, h2, h3, legend')) {
      if (isHiddenFromAgent(el)) continue
      const aria = el.getAttribute('aria-label')?.trim()
      if (aria) labelsInScope.add(aria.toLowerCase())
      const txt = el.textContent?.trim()
      if (txt && txt.length <= 80) labelsInScope.add(txt.toLowerCase())
    }
    const filtered = all.filter(entry => {
      // Always retain workspace tabs so the assistant can see and switch sections immediately
      if (entry.component === 'tabs') return true
      if (!entry.label) return false
      const lower = entry.label.toLowerCase()
      return labelsInScope.has(lower) || [...labelsInScope].some(l => l.includes(lower) || lower.includes(l))
    })
    return filtered.length > 0 ? filtered : all
  },
  query(input) {
    return agent.query(input)
  },
  findTargetElement(ref: string, itemLabel?: string) {
    if (itemLabel) {
      const byItem = findVisibleElementInMain(itemLabel, 'tab')
      if (byItem) return byItem
    }
    const snap = agent.snapshot().filter(entry => !entry.offPage)
    const matchedComp = snap.find(entry => entry.ref === ref || entry.label === ref)
    const searchLabel = matchedComp?.label ?? ref
    const preferRole = matchedComp?.component === 'tabs'
      ? 'tab'
      : matchedComp && ['input', 'textarea', 'select', 'combobox', 'number-input'].includes(matchedComp.component)
        ? 'field'
        : undefined
    return findVisibleElementInMain(searchLabel, preferRole)
  },
  async navigate(target: string, container?: string): Promise<UiNavigateResult> {
    const snap = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more')
    const matched = findMatchingTabStep(target, snap, container)

    if (matched !== null) {
      const previousValue = 'value' in matched.tabs ? matched.tabs.value : undefined
      const targetElement = findVisibleElementInMain(matched.label, 'tab')
      // Try switching via ui-sdk Tabs setValue using value first, then label
      let res = await agent.act({
        steps: [{ ref: matched.tabs.ref, action: 'setValue', args: [matched.value] }],
      })
      if (!res.ok && matched.label !== matched.value) {
        res = await agent.act({
          steps: [{ ref: matched.tabs.ref, action: 'setValue', args: [matched.label] }],
        })
      }
      if (res.ok) {
        return {
          ok: true,
          matchedLabel: matched.label,
          matchedValue: matched.value,
          previousValue,
          tabsRef: matched.tabs.ref,
          ...(matched.tabs.label ? { tabsLabel: matched.tabs.label } : {}),
          targetElement,
        }
      }
      // Fallback: click the live non-confirm tab element directly (e.g. responsive hidden tab)
      if (targetElement && !targetElement.hasAttribute('data-agent-confirm') && !isHiddenFromAgent(targetElement)) {
        targetElement.click()
        return {
          ok: true,
          matchedLabel: matched.label,
          matchedValue: matched.value,
          previousValue,
          tabsRef: matched.tabs.ref,
          ...(matched.tabs.label ? { tabsLabel: matched.tabs.label } : {}),
          targetElement,
        }
      }
      return {
        ok: false,
        error: res.error?.message ?? `Failed to switch tab to "${target}"`,
      }
    }

    // Fallback: locate a safe non-confirm button/tab in <main>
    const el = findVisibleElementInMain(target, 'tab')
    if (el && !el.hasAttribute('data-agent-confirm') && !el.closest('[data-agent-confirm]') && !isHiddenFromAgent(el)) {
      el.click()
      return {
        ok: true,
        matchedLabel: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60),
        targetElement: el,
      }
    }

    const availableTargets = snap
      .filter(entry => entry.component === 'tabs')
      .flatMap(entry => extractTabItems(entry).map(item => `${item.label} (${item.value})`))

    return {
      ok: false,
      availableTargets,
      error: availableTargets.length > 0
        ? `未找到与「${target}」匹配的栏位。当前可切换栏位：${availableTargets.join('、')}。`
        : `当前页面未检测到可切换的栏位或页签「${target}」。`,
    }
  },
  async act(input, options) {
    const protect = options?.protectHumanEdits ?? true
    const blockedHumanEdits: Array<{ ref: string; label: string; attemptedValue: unknown; preservedValue: unknown }> = []
    const snap = agent.snapshot().filter(entry => !entry.offPage)
    const confirmBeforeCount = confirmLog.length

    const normalizedSteps: typeof input.steps = []
    for (const step of input.steps) {
      // Auto-translate LLM "press" on a tab label (e.g. { ref: "病历记录", action: "press" }) into Tabs setValue!
      const directMatch = snap.find(c => c.ref === step.ref || c.label?.toLowerCase() === step.ref.trim().toLowerCase())
      if (directMatch === undefined && (step.action === 'press' || step.action === 'select' || step.action === 'click')) {
        const tabMatch = findMatchingTabStep(step.ref, snap)
        if (tabMatch !== null) {
          normalizedSteps.push({
            ref: tabMatch.tabs.ref,
            action: 'setValue',
            args: [tabMatch.value],
          })
          continue
        }
      }
      if (protect && (step.action === 'setValue' || step.action === 'setChecked' || step.action === 'clear')) {
        const conflict = isStepTargetingHumanEdit(step.ref, snap)
        if (conflict !== null) {
          blockedHumanEdits.push({
            ref: step.ref,
            label: conflict.label,
            attemptedValue: step.args?.[0],
            preservedValue: conflict.preservedValue,
          })
          continue
        }
      }
      normalizedSteps.push(step)
    }

    if (normalizedSteps.length === 0) {
      return {
        result: { ok: true, appeared: [], steps: [], values: {} },
        blockedHumanEdits,
      }
    }

    const result = await agent.act({ steps: normalizedSteps }, options?.signal ? { signal: options.signal } : undefined)
    const newDeniedConfirm = !result.ok
      ? confirmLog.slice(confirmBeforeCount).find(item => !item.approved)
      : undefined
    return {
      result,
      blockedHumanEdits,
      ...(newDeniedConfirm
        ? {
            needsClinicianConfirm: {
              confirmMessage: newDeniedConfirm.confirm,
              ref: newDeniedConfirm.ref,
              ...(newDeniedConfirm.label ? { label: newDeniedConfirm.label } : {}),
            },
          }
        : {}),
    }
  },
  async stage(changes, options) {
    const protect = options?.protectHumanEdits ?? true
    const snap = agent.snapshot().filter(entry => !entry.offPage)
    const skippedHumanEdited: Array<{ ref: string; label: string; attemptedValue: unknown; preservedValue: unknown }> = []
    const safeChanges: typeof changes = []
    for (const item of changes) {
      if (protect) {
        const conflict = isStepTargetingHumanEdit(item.ref, snap)
        if (conflict !== null) {
          skippedHumanEdited.push({
            ref: item.ref,
            label: conflict.label,
            attemptedValue: item.value,
            preservedValue: conflict.preservedValue,
          })
          continue
        }
      }
      safeChanges.push(item)
    }
    const staged = await stageChanges(agent, safeChanges)
    return {
      applied: staged.applied,
      skippedHumanEdited,
      revert: () => staged.revert(),
    }
  },
  undoAgent() {
    return history.undoSource('agent')
  },
  drainHumanChanges() {
    return recentHumanChanges.splice(0)
  },
  getHumanEditedLabels() {
    return [...new Set([...humanEditedByRef.values()].map(v => v.label))]
  },
  clearHumanEdits() {
    recentHumanChanges.length = 0
    humanEditedByLabel.clear()
    humanEditedByRef.clear()
  },
  setConfirmPolicy(mode: ConfirmPolicyMode) {
    confirmPolicy = mode
  },
  getConfirmLog() {
    return [...confirmLog]
  },
  getPendingConfirmations() {
    return [...pendingConfirmations.values()].map(({ resolve: _r, ...rest }) => rest)
  },
  resolveConfirmation(id: string, approved: boolean) {
    const pending = pendingConfirmations.get(id)
    if (!pending) return false
    pending.resolve(approved)
    return true
  },
}

declare global {
  interface Window {
    __clinmeshAgent?: ClinMeshUiAgentBridge
  }
}

if (typeof window !== 'undefined') {
  window.__clinmeshAgent = clinmeshUiAgentBridge
}
