import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import type { WebSurfaceCaseContextState } from '@clinmesh/web/runtime'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ReactSurfaceRegistry } from 'dsh-react-surface/client'
import { DoctorCaseContextRail } from '../../../web/src/app/doctor/case-context-rail.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'
import { createStyledRoot } from './styled-root.ts'

/** WebApp → 宿主右栏标签页的病例上下文通道;生命周期合同与 workspace navigation 一致。 */
export function createCaseContextPort() {
  let current: WebSurfaceCaseContextState | null = null
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(state: WebSurfaceCaseContextState) {
      current = state
      emit()
      return () => {
        // 过期 disposer 不得清掉后续注册(同 workspace navigation 守卫)
        if (current !== state) return
        current = null
        emit()
      }
    },
  }
}

export type CaseContextPort = ReturnType<typeof createCaseContextPort>

/** 本实现的标签系统身份:标签体与 chip 标题在其下注册的 key。 */
const CASE_CONTEXT_TAB_ID = '@clinmesh/dsh-web'
/** 页面型标签的 kind:ctx.sidebarRight.openTab 以它命名打开。 */
export const CASE_CONTEXT_TAB_KIND = 'clinmesh.case-context'

function caseContextCopy(locale: 'zh-CN' | 'en-US') {
  return locale === 'zh-CN'
    ? {
        title: '患者信息',
        description: '当前门诊病例的患者信息与诊疗进展',
        empty: '在门诊医生页面打开病例后,此处显示患者信息。',
      }
    : {
        title: 'Patient context',
        description: 'Patient details and progress for the active outpatient case',
        empty: 'Open a case in the ClinMesh doctor page to see patient context here.',
      }
}

interface ClientThemePort {
  getTheme(): { active: { colorScheme: 'light' | 'dark' } }
}

interface ClientThemeContext {
  on(event: 'theme/change', listener: () => void): () => void
}

export function registerCaseContextTab(ctx: ClientContext, port: CaseContextPort): () => void {
  const surfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
  const sidebarRightTabs = ctx.get('sidebarRightTabs') as unknown as {
    register(definition: SidebarRightTabDefinition): () => void
  }
  const theme = ctx.get('theme') as unknown as ClientThemePort
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const subscribeTheme = (listener: () => void): (() => void) => (
    ctx as unknown as ClientThemeContext
  ).on('theme/change', listener)
  const getTheme = () => theme.getTheme().active.colorScheme
  const subscribeLocale = (listener: () => void): (() => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)

  // 阶段一:标签类型。页面型(无 patterns)按 kind 打开;thunk 每次使用重读宿主语言,
  // 语言切换无需重注册。guide 胶囊提供右侧栏引导页的手动入口。
  const disposeType = sidebarRightTabs.register({
    id: CASE_CONTEXT_TAB_ID,
    kind: CASE_CONTEXT_TAB_KIND,
    title: () => caseContextCopy(getLocale()).title,
    guide: [{
      order: 100,
      title: () => caseContextCopy(getLocale()).title,
      description: () => caseContextCopy(getLocale()).description,
    }],
  })

  // 阶段二:标签体与活动 chip 标题,均以定义 id 为 keyed 槽的 key。
  function CaseContextTabBody(): React.JSX.Element {
    const state = useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot)
    const colorScheme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
    const hostLocale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const host = useRef<HTMLDivElement>(null)
    const [container, setContainer] = useState<HTMLDivElement | null>(null)
    useLayoutEffect(() => {
      if (!host.current) return
      const { root, dispose } = createStyledRoot(host.current)
      setContainer(root)
      return dispose
    }, [])
    useLayoutEffect(() => {
      if (!container) return
      container.classList.toggle('dark', colorScheme === 'dark')
      container.style.colorScheme = colorScheme
    }, [colorScheme, container])
    const panelLocale = state?.locale ?? hostLocale
    return (
      <div
        ref={host}
        data-clinmesh-host-case-context-tab=""
        style={{ height: '100%', minWidth: 0, width: '100%' }}
      >
        {container !== null && createPortal(
          state === null
            ? <p className="p-4 text-sm text-muted-foreground">{caseContextCopy(panelLocale).empty}</p>
            : (
              <PortalContainerProvider container={container}>
                <DoctorCaseContextRail
                  completion={state.completion}
                  detail={state.detail}
                  expanded
                  locale={state.locale}
                  messages={getWorkspaceMessages(panelLocale)}
                  section={state.section}
                  statusText={state.statusText}
                />
              </PortalContainerProvider>
            ),
          container,
        )}
      </div>
    )
  }

  function CaseContextTabTitle(): React.JSX.Element {
    const hostLocale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    return <>{caseContextCopy(hostLocale).title}</>
  }

  const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: CASE_CONTEXT_TAB_ID, registrant: 'clinmesh-case-context-tab' },
      CaseContextTabBody,
    ))
  const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: CASE_CONTEXT_TAB_ID, registrant: 'clinmesh-case-context-tab-title' },
      CaseContextTabTitle,
    ))

  // 自动打开只在上升沿(surface 激活且存在病例快照):openTab 对页面型标签幂等,
  // 已开即聚焦不新开。下降沿不关标签——标签页语义下由用户手动关闭,无快照时
  // 标签体显示空态而非消失。
  let openRequested = false
  const reevaluate = (): void => {
    const should = surfaces.getSnapshot().activeId === 'clinmesh.his' && port.getSnapshot() !== null
    if (should === openRequested) return
    if (!should) {
      openRequested = false
      return
    }
    try {
      const sidebarRight = ctx.get('sidebarRight') as unknown as { openTab(kind: string): void }
      sidebarRight.openTab(CASE_CONTEXT_TAB_KIND)
      openRequested = true
    } catch (error) {
      // 右栏座位尚未挂载等瞬时失败:保持未请求,下一次快照事件重试
      console.error('[clinmesh-dsh-web] open case context tab failed', error)
    }
  }
  const disposeSurfaces = surfaces.subscribe(reevaluate)
  const disposePort = port.subscribe(reevaluate)
  reevaluate()

  return () => {
    disposeSurfaces()
    disposePort()
    disposeTitle()
    disposeBody()
    disposeType()
  }
}
