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
  openTabFailure?: boolean
}

function createHarness(
  port: ReturnType<typeof createCaseContextPort>,
  {
    activeId = null,
    colorScheme = 'light',
    hostLocale = 'zh-CN',
    openTabFailure = false,
  }: HarnessOptions = {},
) {
  const openTab = vi.fn(() => {
    if (openTabFailure) throw new Error('no seat mounted')
  })
  const surfacesListeners = new Set<() => void>()
  // useSyncExternalStore 要求快照身份稳定:仅在 setActive 时更换
  let surfacesSnapshot: { activeId: string | null; surfaces: unknown[] } = { activeId, surfaces: [] }
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

it('opens the tab only on the rising edge of active surface with a snapshot and never closes it', () => {
  const port = createCaseContextPort()
  const harness = createHarness(port, { activeId: null })
  // 非激活:不打开
  expect(harness.openTab).not.toHaveBeenCalled()

  // 激活但无快照:仍不打开
  harness.setActive('clinmesh.his')
  expect(harness.openTab).not.toHaveBeenCalled()

  // 快照到达即打开,且以页面 kind 命名
  const disposeState = port.register(caseState())
  expect(harness.openTab).toHaveBeenCalledTimes(1)
  expect(harness.openTab).toHaveBeenCalledWith('clinmesh.case-context')

  // 快照更新(切病例)不重复打开:openTab 幂等,无需再请求
  const disposeSecond = port.register(caseState({ caseId: 'case-002' }))
  expect(harness.openTab).toHaveBeenCalledTimes(1)

  // 快照撤销(切完诊/切角色)不关闭标签;重新发布即再次请求(幂等聚焦)
  disposeSecond()
  expect(harness.openTab).toHaveBeenCalledTimes(1)
  port.register(caseState())
  expect(harness.openTab).toHaveBeenCalledTimes(2)

  // surface 切走再回来:下降沿不做事,上升沿重开
  harness.setActive(null)
  expect(harness.openTab).toHaveBeenCalledTimes(2)
  harness.setActive('clinmesh.his')
  expect(harness.openTab).toHaveBeenCalledTimes(3)
  disposeState()
  harness.dispose()
})

it('retries opening on the next event when the right sidebar seat is not mounted yet', () => {
  const port = createCaseContextPort()
  const harness = createHarness(port, { activeId: 'clinmesh.his', openTabFailure: true })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const disposeState = port.register(caseState())
    expect(harness.openTab).toHaveBeenCalledTimes(1)
    // 失败后保持未请求:下一次快照事件自动重试而非永久放弃
    const disposeSecond = port.register(caseState({ caseId: 'case-002' }))
    expect(harness.openTab).toHaveBeenCalledTimes(2)
    disposeSecond()
    disposeState()
    harness.dispose()
  } finally {
    errorSpy.mockRestore()
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
