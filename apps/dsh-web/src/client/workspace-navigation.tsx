import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { WebSurfaceNavigation, WebSurfaceNavigationState } from '@clinmesh/web/runtime'
import { Button } from '@clinmesh/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@clinmesh/ui/components/dropdown-menu'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ReactSurfaceRegistry } from 'dsh-react-surface/client'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { workspaceRoutes, settingsRoutes } from '../../../web/src/app/workspace-shell.tsx'
import clinmeshMarkUrl from '../../../web/src/assets/clinmesh-mark.webp'
import { clinMeshStyles } from './styles.generated.ts'

export function createWorkspaceNavigation() {
  let current: WebSurfaceNavigationState | null = null
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
    register(state: WebSurfaceNavigationState) {
      const registration: WebSurfaceNavigationState = {
        ...state,
        navigate(path) {
          if (current === registration) state.navigate(path)
        },
      }
      current = registration
      emit()
      return () => {
        if (current !== registration) return
        current = null
        emit()
      }
    },
  } satisfies WebSurfaceNavigation & {
    getSnapshot(): WebSurfaceNavigationState | null
    subscribe(listener: () => void): () => void
  }
}

type Navigation = ReturnType<typeof createWorkspaceNavigation>

function isSettingsPath(path: string) {
  return settingsRoutes.some((route) => route.path === path)
}

function createStyledRoot(host: HTMLElement) {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = clinMeshStyles
  const root = document.createElement('div')
  root.className = 'clinmesh-web-root'
  root.style.cssText = 'min-height:0;min-width:0;background:transparent;'
  shadow.append(style, root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

export function WorkspaceNavigation({
  navigation,
  wide,
  open,
  close,
  active = false,
  colorScheme = 'light',
  locale: hostLocale = 'zh-CN',
  applications = [],
}: {
  navigation: Navigation
  wide: boolean
  open(): void
  close?: () => void
  active?: boolean
  colorScheme?: 'light' | 'dark'
  locale?: 'zh-CN' | 'en-US'
  applications?: readonly { id: string; title: string; open(): void }[]
}) {
  const host = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [routeContainer, setRouteContainer] = useState<HTMLDivElement | null>(null)
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  useLayoutEffect(() => {
    if (!host.current) return
    const { root, dispose } = createStyledRoot(host.current)
    setContainer(root)
    return dispose
  }, [])
  useLayoutEffect(() => {
    const sidebar = host.current?.closest('[data-slot="sidebar"]')
    if (!sidebar) return
    const routes = document.createElement('div')
    routes.dataset.clinmeshHostRoutes = ''
    routes.style.cssText = 'flex-shrink:0;max-height:40%;overflow-y:auto;'
    const { root, dispose } = createStyledRoot(routes)
    // DSH 0.1.5-rc.1 has no section slot here. Anchor beside its workspace
    // region without replacing, moving, or remounting the native browser.
    const place = () => {
      const region = sidebar.querySelector('[data-slot="sidebar.workspaces"]')?.parentElement
      if (!region || region === sidebar || !region.parentElement) {
        routes.remove()
        return
      }
      if (routes.nextElementSibling !== region) region.before(routes)
    }
    place()
    const observer = new MutationObserver(place)
    observer.observe(sidebar, { childList: true, subtree: true })
    setRouteContainer(root)
    return () => {
      observer.disconnect()
      routes.remove()
      dispose()
    }
  }, [])
  useLayoutEffect(() => {
    for (const root of [container, routeContainer]) {
      if (!root) continue
      root.classList.toggle('dark', colorScheme === 'dark')
      root.style.colorScheme = colorScheme
    }
  }, [colorScheme, container, routeContainer])
  const locale = state?.locale ?? hostLocale
  const label = locale === 'zh-CN' ? '医院工作台' : 'Hospital workspace'
  const menuLabel = locale === 'zh-CN' ? '设置' : 'Settings'
  const messages = getWorkspaceMessages(locale)
  return (
    <div ref={host} data-clinmesh-host-navigation="" style={{ width: wide ? '100%' : 36, minWidth: 36 }}>
      {routeContainer && state && createPortal(
        <nav aria-label={messages.navigationLabel} className="flex flex-col gap-1 py-2">
          {state.items.filter((item) => !isSettingsPath(item.path)).map((item) => {
            const Icon = workspaceRoutes.find((route) => route.path === item.path)?.icon
            return (
              <Button
                key={item.path}
                variant={state.activePath === item.path ? 'secondary' : 'ghost'}
                className={wide ? 'w-full justify-start' : 'w-full'}
                aria-label={item.label}
                title={item.label}
                aria-current={state.activePath === item.path ? 'page' : undefined}
                onClick={() => { open(); state.navigate(item.path) }}
              >
                {Icon && <Icon aria-hidden="true" data-icon="inline-start" />}
                {wide && <span className="truncate">{item.label}</span>}
              </Button>
            )
          })}
        </nav>, routeContainer,
      )}
      {container &&
        createPortal(
          <PortalContainerProvider container={container}>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={label}
                title={label}
                render={<Button variant="ghost" className={wide ? 'w-full justify-start' : 'w-full'} />}
              >
                <img alt="" src={clinmeshMarkUrl} width={24} height={24} />
                {wide ? <span className="truncate">{label}</span> : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="min-w-56" aria-label={menuLabel}>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
                  {!active && !state && (
                    <DropdownMenuItem onClick={open}>
                      {locale === 'zh-CN' ? '打开 ClinMesh' : 'Open ClinMesh'}
                    </DropdownMenuItem>
                  )}
                  {state && (
                    state.items.filter((item) => isSettingsPath(item.path)).map((item) => (
                      <DropdownMenuItem
                        key={item.path}
                        aria-current={state.activePath === item.path ? 'page' : undefined}
                        onClick={() => {
                          open()
                          state.navigate(item.path)
                        }}
                      >
                        {item.label}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuGroup>
                {applications.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>
                        {locale === 'zh-CN' ? '其他应用' : 'Other applications'}
                      </DropdownMenuLabel>
                      {applications.map((application) => (
                        <DropdownMenuItem key={application.id} onClick={application.open}>
                          {application.title}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
                {((state && !active) || close) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      {state && !active && (
                        <DropdownMenuItem onClick={open}>
                          {locale === 'zh-CN' ? '返回 HIS 页面' : 'Return to HIS'}
                        </DropdownMenuItem>
                      )}
                      {close && (
                        <DropdownMenuItem onClick={close}>
                          {locale === 'zh-CN' ? '返回 DSH 会话' : 'Return to DSH conversation'}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </PortalContainerProvider>,
          container,
        )}
    </div>
  )
}

export function registerWorkspaceNavigation(ctx: ClientContext, navigation: Navigation): () => void {
  const surfaces = ctx.get('reactSurfaces') as unknown as ReactSurfaceRegistry
  const theme = ctx.get('theme') as unknown as { getTheme(): { active: { colorScheme: 'light' | 'dark' } } }
  const locale = ctx.get('locale') as unknown as {
    getLocale(): { active: string }
    subscribe(listener: () => void): () => void
  }
  const subscribeTheme = (listener: () => void) =>
    (
      ctx as unknown as {
        on(event: 'theme/change', callback: () => void): () => void
      }
    ).on('theme/change', listener)
  const getTheme = () => theme.getTheme().active.colorScheme
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => locale.getLocale().active
  function Entry({ wide }: SidebarFooterActionOwnerProps) {
    const colorScheme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
    const language = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const snapshot = useSyncExternalStore(surfaces.subscribe, surfaces.getSnapshot, surfaces.getSnapshot)
    return (
      <WorkspaceNavigation
        navigation={navigation}
        wide={wide}
        colorScheme={colorScheme}
        locale={language.startsWith('zh') ? 'zh-CN' : 'en-US'}
        open={() => surfaces.open('clinmesh.his')}
        active={snapshot.activeId === 'clinmesh.his'}
        {...(snapshot.activeId === null ? {} : { close: () => surfaces.close() })}
        applications={snapshot.surfaces
          .filter((surface) => surface.definition.id !== 'clinmesh.his')
          .map(({ definition }) => ({
            id: definition.id,
            title: definition.title,
            open: () => surfaces.open(definition.id),
          }))}
      />
    )
  }
  return ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        // Replace the runtime launcher cell, preserving other applications in the menu.
        name: 'sidebar.footer.action',
        id: 'dsh-react-surface-launcher',
        priority: -100,
        order: 100,
        label: '医院工作台',
        registrant: 'clinmesh-workspace-navigation',
      },
      Entry,
    ),
  )
}
