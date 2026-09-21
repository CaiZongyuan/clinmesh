import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import type { WebSurfaceCaseContextState } from '@clinmesh/web/runtime'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarRightTabDefinition, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ReactSurfaceRegistry } from 'dsh-react-surface/client'
import { DoctorCaseContextRail } from '../../../web/src/app/doctor/case-context-rail.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'
import { normalizeSessionId, subscribeHostTheme, type ClientSessionsPort, type ClientThemePort } from './host-ports.ts'
import { createStyledRoot } from './styled-root.ts'

/** WebApp → 宿主右栏标签页的病例上下文通道;生命周期合同与 workspace navigation 一致。 */
export function createCaseContextPort() {
  let current: WebSurfaceCaseContextState | null = null
  let openRequester: (() => void) | null = null
  let toggleRequester: (() => void) | null = null
  const visibleTabs = new Set<() => void>()
  const visibilityListeners = new Set<() => void>()
  const emitVisibility = () => { for (const listener of visibilityListeners) listener() }
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    visibility: {
      getSnapshot: () => visibleTabs.size > 0,
      subscribe(listener: () => void) {
        visibilityListeners.add(listener)
        return () => { visibilityListeners.delete(listener) }
      },
      toggle() { toggleRequester?.() },
    },
    registerVisibility(hide: () => void) {
      visibleTabs.add(hide)
      emitVisibility()
      return () => { visibleTabs.delete(hide); emitVisibility() }
    },
    hideVisible() { for (const hide of visibleTabs) hide() },
    setToggleRequester(requester: (() => void) | null) { toggleRequester = requester },
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
    /** 宿主注册"打开/聚焦患者信息标签"的实现;WebApp 经 requestOpen 反向调用。 */
    setOpenRequester(requester: (() => void) | null) {
      openRequester = requester
    },
    /** WebApp 主动请求展示患者信息(患者横幅按钮);宿主未注册时为空操作。 */
    requestOpen() {
      openRequester?.()
    },
  }
}

export type CaseContextPort = ReturnType<typeof createCaseContextPort>

/** 本实现的标签系统身份:标签体与 chip 标题在其下注册的 key。 */
const CASE_CONTEXT_TAB_ID = '@clinmesh/dsh-web'
/** 页面型标签的 kind:ctx.sidebarRight.openTab 以它命名打开。 */
export const CASE_CONTEXT_TAB_KIND = 'clinmesh.case-context'

export function registerCaseContextTab(ctx: ClientContext, port: CaseContextPort): () => void {
  const surfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
  const sidebarRightTabs = ctx.get('sidebarRightTabs') as unknown as {
    register(definition: SidebarRightTabDefinition): () => void
  }
  const theme = ctx.get('theme') as unknown as ClientThemePort
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const sessions = ctx.get('sessions') as unknown as ClientSessionsPort
  const subscribeTheme = (listener: () => void): (() => void) => subscribeHostTheme(ctx, listener)
  const getTheme = () => theme.getTheme().active.colorScheme
  const subscribeLocale = (listener: () => void): (() => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)

  // 阶段一:标签类型。页面型(无 patterns)按 kind 打开;thunk 每次使用重读宿主语言,
  // 语言切换无需重注册。guide 胶囊提供右侧栏引导页的手动入口。
  const disposeType = sidebarRightTabs.register({
    id: CASE_CONTEXT_TAB_ID,
    kind: CASE_CONTEXT_TAB_KIND,
    title: () => getWorkspaceMessages(getLocale()).caseContextTabTitle,
    guide: [{
      order: 100,
      title: () => getWorkspaceMessages(getLocale()).caseContextTabTitle,
      description: () => getWorkspaceMessages(getLocale()).caseContextTabDescription,
    }],
  })

  // 阶段二:标签体与活动 chip 标题,均以定义 id 为 keyed 槽的 key。
  function CaseContextTabBody({ useTabInfo }: { useTabInfo: UseSidebarRightTabInfo }): React.JSX.Element {
    const info = useTabInfo()
    useLayoutEffect(() => {
      if (!info.tab.visible) return
      return port.registerVisibility(() => { info.tab.actions.close() })
    }, [info.tab.visible, info.tab.id, info.tab.actions])
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
            ? <p className="p-4 text-sm text-muted-foreground">{getWorkspaceMessages(panelLocale).caseContextTabEmpty}</p>
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
    return <>{getWorkspaceMessages(hostLocale).caseContextTabTitle}</>
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

  // 自动打开按"surface 激活 + 存在病例快照 + 当前会话"门控,以会话 id 记账:
  // 右栏停靠面按会话隔离(每会话一份布局,切换会话后原标签不在新会话布局里),
  // 会话变化即对新的当前会话重新请求。下降沿(含离开医生页)重置记账。
  //
  // 关键时序:座位绑定跟随会话 surface 的 React 挂载效果,而 sessions.list 等
  // store 事件先于提交触发——同步 openTab 要么落进旧会话布局(成功但不可见),
  // 要么因座位未挂载抛错且不再有事件。因此触发事件只比对记账,真正的 openTab
  // 一律推迟到事件循环之后执行;失败(座位未挂载)以短定时器自愈重试直到成功、
  // 门控失效或重试预算耗尽,不依赖下一次事件。openTab 对页面型标签幂等(已开
  // 即聚焦),并把右栏展开纳入同一步。
  const RETRY_DELAY_MS = 200
  // 单个请求段的重试预算:座位永不挂载的永久性故障(接线错误等)不得退化为
  // 插件生命周期内的无限后台循环;预算随新的请求段(会话切换、手动请求)重置。
  const RETRY_MAX_ATTEMPTS = 25
  let requestedSession: string | null = null
  let hiddenSession: string | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempts = 0
  let loggedFailure = false
  const gateOpen = (): boolean =>
    surfaces.getSnapshot().activeId === 'clinmesh.his' && port.getSnapshot() !== null
  const currentSessionId = (): string | undefined =>
    normalizeSessionId(sessions.list.getSnapshot().current)
  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  const attempt = (force: boolean): void => {
    // 入口先清挂起的重试定时器:手动强制尝试可能与自动重试并发,不清会孤儿化
    // 旧定时器形成双重重试链(定时器自触发时 clearTimeout 为无害空操作)。
    clearRetry()
    if (!gateOpen()) {
      requestedSession = null
      return
    }
    const sessionId = currentSessionId()
    if (sessionId === undefined) {
      requestedSession = null
      return
    }
    if (!force && hiddenSession === sessionId) return
    // force = WebApp 内用户主动请求(患者横幅按钮):绕过会话记账,已开即聚焦,
    // 关闭后点击即可恢复;自动路径仍按会话 id 去重。
    if (!force && requestedSession === sessionId) return
    try {
      const sidebarRight = ctx.get('sidebarRight') as unknown as { openTab(kind: string): void }
      sidebarRight.openTab(CASE_CONTEXT_TAB_KIND)
      requestedSession = sessionId
      loggedFailure = false
      retryAttempts = 0
    } catch (error) {
      // 座位挂载没有公开事件(hero 会话首次激活、慢机器上的座位重挂):短延迟
      // 重试直到成功、门控失效或预算耗尽;每个失败段只记录一次错误避免刷屏,
      // 预算耗尽补记终态错误后放弃,等下一次请求段再重置。
      retryAttempts += 1
      if (retryAttempts >= RETRY_MAX_ATTEMPTS) {
        console.error(
          `[clinmesh-dsh-web] open case context tab failed ${retryAttempts} times, giving up until the next request`,
          error,
        )
        return
      }
      if (!loggedFailure) {
        loggedFailure = true
        console.error('[clinmesh-dsh-web] open case context tab failed, retrying', error)
      }
      retryTimer = setTimeout(() => { attempt(false) }, RETRY_DELAY_MS)
    }
  }
  const reevaluate = (): void => {
    if (!gateOpen()) {
      requestedSession = null
      loggedFailure = false
      retryAttempts = 0
      clearRetry()
      return
    }
    const sessionId = currentSessionId()
    if (sessionId === undefined) {
      // hero/新会话未发首条消息:无会话可绑定,清记账等会话激活事件
      requestedSession = null
      loggedFailure = false
      retryAttempts = 0
      clearRetry()
      return
    }
    if (hiddenSession === sessionId) return
    if (requestedSession !== sessionId && retryTimer === null) {
      // 新的请求段(新会话):重置重试预算与失败日志记账
      loggedFailure = false
      retryAttempts = 0
      retryTimer = setTimeout(() => { attempt(false) }, RETRY_DELAY_MS)
    }
  }
  // WebApp 患者横幅的"显示患者信息"按钮:requestOpen 反向通道,立即强制尝试;
  // 座位未挂载(如 hero 会话)时沿用重试循环,座位出现后自动补开。手动请求是
  // 新的用户动作,重置重试预算后再试。
  port.setOpenRequester(() => {
    hiddenSession = null
    requestedSession = null
    retryAttempts = 0
    attempt(true)
  })
  port.setToggleRequester(() => {
    if (!gateOpen()) return
    if (port.visibility.getSnapshot()) {
      clearRetry()
      requestedSession = currentSessionId() ?? null
      hiddenSession = requestedSession
      port.hideVisible()
    } else {
      hiddenSession = null
      requestedSession = null
      retryAttempts = 0
      attempt(true)
    }
  })
  const disposeSurfaces = surfaces.subscribe(reevaluate)
  const disposePort = port.subscribe(reevaluate)
  const disposeSessions = sessions.list.subscribe(reevaluate)
  reevaluate()

  return () => {
    port.setOpenRequester(null)
    port.setToggleRequester(null)
    clearRetry()
    disposeSurfaces()
    disposePort()
    disposeSessions()
    disposeTitle()
    disposeBody()
    disposeType()
  }
}
