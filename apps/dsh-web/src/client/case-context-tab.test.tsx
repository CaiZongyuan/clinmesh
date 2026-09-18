// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import type { WebSurfaceCaseContextState } from '@clinmesh/web/runtime'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { CASE_CONTEXT_TAB_KIND, createCaseContextPort, registerCaseContextTab } from './case-context-tab.tsx'

const caseDetail: DoctorCaseDetail = {
  allergies: [{ code: 'allergy-penicillin', display: '青霉素' }],
  caseId: 'case-001',
  encounter: { id: 'enc-001', status: 'in-progress', versionId: '1' },
  patient: {
    id: 'patient-001',
    identifier: 'HN-001',
    name: '合成患者陈明',
    synthetic: true,
    versionId: '1',
  },
  presentation: {
    chiefComplaint: '发热伴咽痛两天',
    summary: '发热伴咽痛两天',
    vitalSigns: {
      bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
      oxygenSaturationPct: 98,
      pulseBpm: 102,
      respirationBpm: 20,
      temperatureC: 38.2,
    },
  },
  priorFacts: [],
  status: 'in-progress',
  taskId: 'task-001',
  taskVersion: '1',
}

function caseState(overrides: Partial<WebSurfaceCaseContextState> = {}): WebSurfaceCaseContextState {
  return {
    caseId: 'case-001',
    completion: undefined,
    detail: caseDetail,
    locale: 'zh-CN',
    section: 'consultation',
    statusText: '接诊中',
    ...overrides,
  }
}

interface HarnessOptions {
  activeId?: string | null
  colorScheme?: 'light' | 'dark'
  hostLocale?: 'zh-CN' | 'en-US'
  seatMounted?: boolean
}

function createHarness(
  port: ReturnType<typeof createCaseContextPort>,
  {
    activeId = null,
    colorScheme = 'light',
    hostLocale = 'zh-CN',
    seatMounted = true,
  }: HarnessOptions = {},
) {
  let mounted = seatMounted
  const openTab = vi.fn(() => {
    // 宿主合同:座位未挂载时 openTab 抛错(no session surface is mounted)
    if (!mounted) throw new Error('sidebarRight: no session surface is mounted')
  })
  const surfacesListeners = new Set<() => void>()
  // useSyncExternalStore 要求快照身份稳定:仅在 setActive 时更换
  let surfacesSnapshot: { activeId: string | null; surfaces: unknown[] } = { activeId, surfaces: [] }
  const sessionListeners = new Set<() => void>()
  let sessionId: string | undefined = 'session-1'
  const localeListeners = new Set<() => void>()
  let hostLanguage: 'zh-CN' | 'en-US' = hostLocale
  let definition: SidebarRightTabDefinition | undefined
  const occupants = new Map<string, unknown>()
  const injected = new Map<string, () => () => void>()
  const ctx = {
    get(name: string) {
      if (name === 'reactSurfaces') {
        return {
          subscribe(listener: () => void) {
            surfacesListeners.add(listener)
            return () => {
              surfacesListeners.delete(listener)
            }
          },
          getSnapshot: () => surfacesSnapshot,
        }
      }
      if (name === 'sessions') {
        return {
          list: {
            subscribe(listener: () => void) {
              sessionListeners.add(listener)
              return () => {
                sessionListeners.delete(listener)
              }
            },
            getSnapshot: () => ({ current: sessionId }),
          },
        }
      }
      if (name === 'sidebarRightTabs') {
        return {
          register(captured: SidebarRightTabDefinition) {
            definition = captured
            return () => {
              definition = undefined
            }
          },
        }
      }
      if (name === 'sidebarRight') return { openTab }
      if (name === 'theme') return { getTheme: () => ({ active: { colorScheme } }) }
      if (name === 'locale') {
        return {
          subscribe: (listener: () => void) => {
            localeListeners.add(listener)
            return () => {
              localeListeners.delete(listener)
            }
          },
          getLocale: () => ({ active: hostLanguage }),
        }
      }
      return {}
    },
    on: () => () => {},
    slots: {
      inject: (name: string, register: () => () => void) => {
        injected.set(name, register)
        return register()
      },
      register: (entry: { name: string }, component: unknown) => {
        occupants.set(entry.name, component)
        return () => {
          occupants.delete(entry.name)
        }
      },
    },
  }
  const dispose = registerCaseContextTab(ctx as unknown as Context, port)
  return {
    ctx: ctx as unknown as Context,
    definition,
    occupants,
    openTab,
    dispose,
    setActive(next: string | null) {
      surfacesSnapshot = { activeId: next, surfaces: [] }
      for (const listener of surfacesListeners) listener()
    },
    setSession(next: string | undefined) {
      sessionId = next
      for (const listener of sessionListeners) listener()
    },
    setSeatMounted(next: boolean) {
      mounted = next
    },
    setHostLocale(next: 'zh-CN' | 'en-US') {
      hostLanguage = next
      for (const listener of localeListeners) listener()
    },
  }
}

it('keeps snapshot ownership with the port and ignores stale disposers', () => {
  const port = createCaseContextPort()
  expect(port.getSnapshot()).toBeNull()
  const first = port.register(caseState({ caseId: 'case-001' }))
  expect(port.getSnapshot()?.caseId).toBe('case-001')
  const second = port.register(caseState({ caseId: 'case-002' }))
  first()
  expect(port.getSnapshot()?.caseId).toBe('case-002')
  second()
  expect(port.getSnapshot()).toBeNull()
})

it('registers a page-type tab definition with a localized guide entry', () => {
  const harness = createHarness(createCaseContextPort(), { hostLocale: 'zh-CN' })
  expect(harness.definition?.id).toBe('@clinmesh/dsh-web')
  expect(harness.definition?.kind).toBe(CASE_CONTEXT_TAB_KIND)
  expect(harness.definition?.patterns).toBeUndefined()
  expect(harness.definition?.title('clinmesh:page')).toBe('患者信息')
  expect(harness.definition?.guide?.[0]?.title()).toBe('患者信息')
  expect(harness.definition?.guide?.[0]?.description?.()).toBe('当前门诊病例的患者信息与诊疗进展')
  // thunk 每次重读宿主语言:语言切换无需重注册
  harness.setHostLocale('en-US')
  expect(harness.definition?.title('clinmesh:page')).toBe('Patient context')
  harness.dispose()
})

// openTab 尝试统一延迟 ~200ms 执行(见实现注释):测试用假时钟推进
const RETRY_DELAY_MS = 200

async function flushAttempt(): Promise<void> {
  // 推进一个延迟周期(250 > 200,且 < 2×200,每次恰好触发一次尝试)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 50)
  })
}

it('opens the tab only on the rising edge of active surface with a snapshot and never closes it', async () => {
  vi.useFakeTimers()
  try {
    const port = createCaseContextPort()
    const harness = createHarness(port, { activeId: null })
    // 非激活:不打开
    await flushAttempt()
    expect(harness.openTab).not.toHaveBeenCalled()

    // 激活但无快照:仍不打开
    harness.setActive('clinmesh.his')
    await flushAttempt()
    expect(harness.openTab).not.toHaveBeenCalled()

    // 快照到达即打开(延迟尝试),且以页面 kind 命名
    const disposeState = port.register(caseState())
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)
    expect(harness.openTab).toHaveBeenCalledWith('clinmesh.case-context')

    // 快照更新(切病例)不重复打开:openTab 幂等,无需再请求
    const disposeSecond = port.register(caseState({ caseId: 'case-002' }))
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)

    // 快照撤销(切完诊/切角色)不关闭标签;重新发布即再次请求(幂等聚焦)
    disposeSecond()
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)
    port.register(caseState())
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(2)

    // surface 切走再回来:下降沿不做事,上升沿重开
    harness.setActive(null)
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(2)
    harness.setActive('clinmesh.his')
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(3)
    disposeState()
    harness.dispose()
  } finally {
    vi.useRealTimers()
  }
})

it('retries opening on a short timer until the seat mounts, logging once per failure streak', async () => {
  vi.useFakeTimers()
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const port = createCaseContextPort()
    const harness = createHarness(port, { activeId: 'clinmesh.his', seatMounted: false })
    const disposeState = port.register(caseState())
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)
    // 座位仍未挂载:不依赖下一次事件,定时器自愈重试;失败段只记录一次错误
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    // 座位挂载后下一次尝试成功
    harness.setSeatMounted(true)
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(3)
    expect(harness.openTab).toHaveBeenCalledWith('clinmesh.case-context')
    // 成功后停止重试
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(3)
    disposeState()
    harness.dispose()
  } finally {
    errorSpy.mockRestore()
    vi.useRealTimers()
  }
})

it('reopens the tab for a new DSH session and resets the request after leaving the doctor page', async () => {
  vi.useFakeTimers()
  try {
    const port = createCaseContextPort()
    const harness = createHarness(port, { activeId: 'clinmesh.his' })
    const disposeState = port.register(caseState())
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)

    // 右栏停靠面按会话隔离:切换/新建会话后原标签不在新会话布局里,须重新请求
    harness.setSession('session-2')
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(2)
    // 同一会话内的重复事件不重开
    harness.setSession('session-2')
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(2)

    // 离开医生页重置记账:回到医生页即使同会话也重新打开(幂等聚焦)
    harness.setActive(null)
    harness.setActive('clinmesh.his')
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(3)
    disposeState()
    harness.dispose()
  } finally {
    vi.useRealTimers()
  }
})

it('skips opening while no DSH session is current and opens once a session appears', async () => {
  vi.useFakeTimers()
  try {
    const port = createCaseContextPort()
    const harness = createHarness(port, { activeId: 'clinmesh.his' })
    harness.setSession(undefined)
    const disposeState = port.register(caseState())
    await flushAttempt()
    // hero/新会话未发首条消息:无会话可绑定,不请求也不报错
    expect(harness.openTab).not.toHaveBeenCalled()
    // 会话激活(发出首条消息或选中会话)即打开
    harness.setSession('session-9')
    await flushAttempt()
    expect(harness.openTab).toHaveBeenCalledTimes(1)
    expect(harness.openTab).toHaveBeenCalledWith('clinmesh.case-context')
    disposeState()
    harness.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function mountComponent(component: unknown, props: Record<string, unknown> = {}): Promise<{
  host: HTMLElement
  unmount(): Promise<void>
}> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(() => {
    root.render(createElement(component as never, props as never))
  })
  return {
    host,
    async unmount() {
      await act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

it('renders the rail into a shadow root while a snapshot is published', async () => {
  const port = createCaseContextPort()
  const harness = createHarness(port, { activeId: 'clinmesh.his', colorScheme: 'dark', hostLocale: 'en-US' })
  const body = harness.occupants.get('sidebar.right.pane.tab')
  if (typeof body !== 'function') throw new Error('Missing tab body registration')
  await act(() => {
    port.register(caseState())
  })
  const mounted = await mountComponent(body)
  try {
    const shadow = mounted.host.querySelector('[data-clinmesh-host-case-context-tab]')?.shadowRoot
    if (!shadow) throw new Error('Missing case context shadow root')
    expect(shadow.textContent).toContain('过敏提示')
    expect(shadow.textContent).toContain('青霉素')
    expect(shadow.textContent).toContain('发热伴咽痛两天')
    expect(shadow.textContent).toContain('生命体征')
    // 宿主右列没有折叠形态:不渲染折叠按钮
    expect(shadow.querySelector('button[aria-expanded]')).toBeNull()
    const root = shadow.querySelector<HTMLElement>('.clinmesh-web-root')
    expect(root?.classList.contains('dark')).toBe(true)
    expect(root?.style.colorScheme).toBe('dark')
    // 快照 locale(zh-CN)优先于宿主 locale(en-US)
    expect(shadow.textContent).toContain('过敏提示')
    expect(shadow.textContent).not.toContain('Allergy warnings')
  } finally {
    await mounted.unmount()
    harness.dispose()
  }
})

it('renders the empty state instead of the rail when no snapshot is published', async () => {
  const port = createCaseContextPort()
  const harness = createHarness(port, { activeId: 'clinmesh.his' })
  const body = harness.occupants.get('sidebar.right.pane.tab')
  if (typeof body !== 'function') throw new Error('Missing tab body registration')
  const mounted = await mountComponent(body)
  try {
    const shadow = mounted.host.querySelector('[data-clinmesh-host-case-context-tab]')?.shadowRoot
    if (!shadow) throw new Error('Missing case context shadow root')
    expect(shadow.textContent).toContain('在门诊医生页面打开病例后')
    expect(shadow.textContent).not.toContain('过敏提示')
  } finally {
    await mounted.unmount()
    harness.dispose()
  }
})

it('keeps the live chip title following the host language', async () => {
  const harness = createHarness(createCaseContextPort(), { hostLocale: 'zh-CN' })
  const title = harness.occupants.get('sidebar.right.pane.tab.title')
  if (typeof title !== 'function') throw new Error('Missing tab title registration')
  const mounted = await mountComponent(title)
  try {
    expect(mounted.host.textContent).toBe('患者信息')
    await act(() => {
      harness.setHostLocale('en-US')
    })
    expect(mounted.host.textContent).toBe('Patient context')
  } finally {
    await mounted.unmount()
    harness.dispose()
  }
})
