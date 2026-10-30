import { ResponsiveSidebarProvider } from './responsive-sidebar.tsx'
import { SurfaceDisplayButton } from './surface-display-control.tsx'
import { WorkspaceHeaderPatientSlot, WorkspaceHeaderProvider } from './workspace-card-layout.tsx'
import { useWorkspaceMode, workspaceModeScope } from './workspace-mode.tsx'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { WorkspaceSelect } from './workspace-select.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@clinmesh/ui/components/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@clinmesh/ui/components/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { TooltipProvider } from '@clinmesh/ui/components/tooltip'
import { Link, useNavigate } from '@tanstack/react-router'
import type { SessionContext } from '@clinmesh/contracts/his'
import {
  BellIcon,
  ChartNoAxesCombinedIcon,
  ClipboardPlusIcon,
  ChevronDownIcon,
  ComponentIcon,
  DatabaseIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MonitorIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoonIcon,
  PillIcon,
  ReceiptTextIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  StethoscopeIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import clinmeshWordmarkUrl from '../assets/clinmesh-wordmark.webp'
import { useWebRuntime, type WebSurfaceAgentStatus } from './web-runtime.tsx'
import { getWorkspaceMessages, type WorkspaceLocale, type WorkspaceMessageKey } from './workspace-i18n.ts'

export type WorkspaceTheme = 'system' | 'light' | 'dark'

export const workspaceRoutes = [
  { key: 'overview', path: '/', icon: LayoutDashboardIcon },
  { key: 'scenarioData', path: '/scenario-data', icon: DatabaseIcon },
  { key: 'registration', path: '/registration', icon: ClipboardPlusIcon },
  { key: 'triage', path: '/triage', icon: HeartPulseIcon },
  { key: 'consultation', path: '/consultation', icon: StethoscopeIcon },
  { key: 'billing', path: '/billing', icon: ReceiptTextIcon },
  { key: 'pharmacy', path: '/pharmacy', icon: PillIcon },
  { key: 'inpatient', path: '/inpatient', icon: HeartPulseIcon },
] as const

export type WorkspaceSection = (typeof workspaceRoutes)[number]['key']

export const settingsRoutes = [
  { key: 'settingsGeneral', path: '/settings', icon: SlidersHorizontalIcon },
  { key: 'modelUsage', path: '/settings/model-usage', icon: ChartNoAxesCombinedIcon },
  { key: 'uiComponents', path: '/settings/developer/components', icon: ComponentIcon },
] as const

export type SettingsSection = (typeof settingsRoutes)[number]['key']
export type AppSection = WorkspaceSection | SettingsSection

export function isSettingsSection(section: AppSection): section is SettingsSection {
  return settingsRoutes.some(route => route.key === section)
}

interface WorkspaceShellProps {
  activeSection: AppSection
  children: ReactNode
  session: SessionContext
  locale: WorkspaceLocale
  onLocaleChange: (locale: WorkspaceLocale) => void
  onRoleChange: (practitionerRoleId: string) => void
  onSignOut: () => void
  onThemeChange: (theme: WorkspaceTheme) => void
  roleChangePending: boolean
  signOutPending: boolean
  theme: WorkspaceTheme
}

type PreferenceControlProps = Pick<
  WorkspaceShellProps,
  'locale' | 'onLocaleChange' | 'onThemeChange' | 'theme'
> & {
  messages: ReturnType<typeof getWorkspaceMessages>
  showLabel?: boolean
  showLocale?: boolean
}

export const roleSections: Record<SessionContext['actor']['roleCode'], WorkspaceSection> = {
  administrator: 'scenarioData',
  cashier: 'billing',
  'outpatient-doctor': 'consultation',
  'inpatient-doctor': 'inpatient',
  'ward-nurse': 'inpatient',
  'medical-records': 'inpatient',
  'medical-insurance': 'inpatient',
  pharmacist: 'pharmacy',
  registrar: 'registration',
  'triage-nurse': 'triage',
}

const themeOptions = [
  { value: 'system', label: 'themeSystem', icon: MonitorIcon },
  { value: 'light', label: 'themeLight', icon: SunIcon },
  { value: 'dark', label: 'themeDark', icon: MoonIcon },
] satisfies Array<{
  value: WorkspaceTheme
  label: WorkspaceMessageKey
  icon: typeof MonitorIcon
}>

const localeOptions = [
  { value: 'zh-CN', label: 'chinese' },
  { value: 'en-US', label: 'english' },
] satisfies Array<{
  value: WorkspaceLocale
  label: WorkspaceMessageKey
}>

const assistantLabels = {
  unavailable: ['助手未连接', 'Assistant not connected'],
  idle: ['助手等待连接', 'Assistant waiting to connect'],
  connecting: ['助手连接中', 'Assistant connecting'],
  active: ['助手就绪', 'Assistant ready'],
  contended: ['助手正在其他窗口工作', 'Assistant active in another window'],
  error: ['助手连接失败', 'Assistant connection failed'],
} satisfies Record<WebSurfaceAgentStatus, readonly [string, string]>

const roleMessageKeys: Record<SessionContext['actor']['roleCode'], WorkspaceMessageKey> = {
  administrator: 'role_administrator',
  cashier: 'role_cashier',
  'outpatient-doctor': 'role_outpatientDoctor',
  'inpatient-doctor': 'role_inpatientDoctor',
  'ward-nurse': 'role_wardNurse',
  'medical-records': 'role_medicalRecords',
  'medical-insurance': 'role_medicalInsurance',
  pharmacist: 'role_pharmacist',
  registrar: 'role_registrar',
  'triage-nurse': 'role_triageNurse',
}

const roleGroups: Record<SessionContext['actor']['roleCode'], 'outpatient' | 'inpatient' | 'system'> = {
  administrator: 'system',
  cashier: 'outpatient',
  'outpatient-doctor': 'outpatient',
  'inpatient-doctor': 'inpatient',
  'ward-nurse': 'inpatient',
  'medical-records': 'inpatient',
  'medical-insurance': 'inpatient',
  pharmacist: 'outpatient',
  registrar: 'outpatient',
  'triage-nurse': 'outpatient',
}

const roleGroupSections = [
  { key: 'outpatient', messageKey: 'roleGroupOutpatient' },
  { key: 'inpatient', messageKey: 'roleGroupInpatient' },
  { key: 'system', messageKey: 'roleGroupSystem' },
] as const satisfies ReadonlyArray<{ key: 'outpatient' | 'inpatient' | 'system'; messageKey: WorkspaceMessageKey }>

function actingPractitionerLabel(
  role: SessionContext['availableRoles'][number],
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  const roleLabel = messages[roleMessageKeys[role.code]]
  const practitionerName = clinicalDisplayName(role.practitionerName)
  return practitionerName === roleLabel ? roleLabel : `${roleLabel} · ${practitionerName}`
}

function clinicalDisplayName(value: string): string {
  return value.replace(/^合成/, '').replace(/^Synthetic\s+/i, '')
}

function firstValue<Value extends string>(values: Value[]): Value | undefined {
  return values[0]
}

function Brand({
  appName,
  logoAlt,
  productTagline,
}: {
  appName: string
  logoAlt: string
  productTagline: string
}): React.JSX.Element {
  const { isMobile, state } = useSidebar()

  if (!isMobile && state === 'collapsed') {
    return (
      <div className="flex h-10 w-full items-center justify-center">
        <img alt={logoAlt} className="size-8 shrink-0" src={clinmeshMarkUrl} />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-3 px-1 py-1">
      <div className="flex w-16 shrink-0 flex-col items-center justify-center bg-white py-1">
        <img alt={logoAlt} className="size-9 shrink-0" src={clinmeshMarkUrl} />
        <img alt="Clinmesh" className="mt-0.5 h-auto w-14 shrink-0" src={clinmeshWordmarkUrl} />
      </div>
      <div className="min-w-0 whitespace-nowrap">
        <div className="text-sm font-semibold">{appName}</div>
        <div className="mt-1 text-[length:var(--text-2xs)] leading-none text-muted-foreground">{productTagline}</div>
      </div>
    </div>
  )
}

export function AppearanceControls({
  locale,
  messages,
  onLocaleChange,
  onThemeChange,
  showLabel = true,
  showLocale = true,
  theme,
}: PreferenceControlProps): React.JSX.Element {
  const runtime = useWebRuntime()
  return (
    <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
      {showLabel ? (
        <div className="text-xs font-medium text-muted-foreground">{messages.appearanceLabel}</div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {showLocale && runtime.mode === 'standalone' ? (
          <ToggleGroup
            aria-label={messages.languageLabel}
            onValueChange={values => {
              const value = firstValue(values as WorkspaceLocale[])
              if (value !== undefined) onLocaleChange(value)
            }}
            size="sm"
            spacing={0}
            value={[locale]}
            variant="outline"
          >
            {localeOptions.map(option => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {messages[option.label]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        {runtime.mode === 'standalone' ? (
          <ToggleGroup
            aria-label={messages.themeLabel}
            onValueChange={values => {
              const value = firstValue(values as WorkspaceTheme[])
              if (value !== undefined) onThemeChange(value)
            }}
            size="sm"
            spacing={0}
            value={[theme]}
            variant="outline"
          >
            {themeOptions.map(option => (
              <ToggleGroupItem
                aria-label={messages[option.label]}
                key={option.value}
                title={messages[option.label]}
                value={option.value}
              >
                <option.icon aria-hidden="true" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>
    </div>
  )
}

function UserMenu({
  locale,
  settingsMode,
  messages,
  onRoleChange,
  onSignOut,
  onThemeChange,
  roleChangePending,
  signOutPending,
  theme,
  session,
}: Pick<PreferenceControlProps, 'messages' | 'onThemeChange' | 'theme'> & {
  locale: WorkspaceLocale
  settingsMode: boolean
  onRoleChange: (practitionerRoleId: string) => void
  onSignOut: () => void
  roleChangePending: boolean
  session: SessionContext
  signOutPending: boolean
}): React.JSX.Element {
  const runtime = useWebRuntime()
  const activeRole = session.availableRoles.find(role => role.id === session.actor.practitionerRoleId)
  const people = new Map<string, SessionContext['availableRoles'][number]>()
  for (const role of session.availableRoles) {
    const key = `${role.practitionerId}/${role.code}`
    if (!people.has(key) || role.id === session.actor.practitionerRoleId) people.set(key, role)
  }
  const activeRoleLabel = activeRole === undefined
    ? messages[roleMessageKeys[session.actor.roleCode]]
    : actingPractitionerLabel(activeRole, messages)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={messages.userMenu}
        render={(
          <Button
            className="max-w-40 min-w-0 justify-start px-2 sm:max-w-64"
            size="sm"
            title={activeRoleLabel}
            variant="ghost"
          />
        )}
      >
        <Avatar className="size-6 shrink-0 rounded-md">
          <AvatarFallback className="rounded-md">
            <UserRoundIcon aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
        <span className="hidden truncate text-xs font-medium @min-[480px]/workspace-header:inline">{activeRoleLabel}</span>
        <ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-foreground">{clinicalDisplayName(session.user.name)}</span>
            <span className="block font-normal">{session.user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{messages.practitionerRole}</DropdownMenuLabel>
        </DropdownMenuGroup>
        {roleGroupSections.map(section => {
          const members = [...people.values()].filter(role => roleGroups[role.code] === section.key)
          if (members.length === 0) return null
          return (
            <Fragment key={section.key}>
              <DropdownMenuSeparator />
              <DropdownMenuGroup aria-label={messages[section.messageKey]}>
                <DropdownMenuLabel>{messages[section.messageKey]}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  onValueChange={onRoleChange}
                  value={session.actor.practitionerRoleId}
                >
                  {members.map(role => (
                    <DropdownMenuRadioItem
                      disabled={roleChangePending}
                      key={role.id}
                      value={role.id}
                    >
                      {actingPractitionerLabel(role, messages)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </Fragment>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to={workspaceRoutes.find(route => route.key === roleSections[session.actor.roleCode])?.path ?? '/'} />}>
            <LayoutDashboardIcon aria-hidden="true" />{messages[roleSections[session.actor.roleCode]]}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings" />}><SettingsIcon aria-hidden="true" />{messages.settings}</DropdownMenuItem>
          {settingsMode && runtime.mode === 'standalone' ? <SettingsNavigationItem label={messages.settingsNavigation} /> : null}
          {runtime.surfaceDisplay?.conversation && !runtime.surfaceDisplay.fullscreen ? <DropdownMenuItem onClick={runtime.surfaceDisplay.conversation.toggle}>
            {locale === 'zh-CN'
              ? runtime.surfaceDisplay.conversation.collapsed ? '展开会话' : '收起会话'
              : runtime.surfaceDisplay.conversation.collapsed ? 'Expand conversation' : 'Collapse conversation'}
          </DropdownMenuItem> : null}
          <NotificationsMenu messages={messages} />
        </DropdownMenuGroup>
        {runtime.mode === 'standalone' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{messages.themeLabel}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={value => onThemeChange(value as WorkspaceTheme)}
                value={theme}
              >
                {themeOptions.map(option => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    <option.icon aria-hidden="true" />
                    {messages[option.label]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOutPending} onClick={onSignOut}>
          <LogOutIcon aria-hidden="true" />
          {signOutPending ? messages.signingOut : messages.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NotificationsMenu({ messages }: { messages: ReturnType<typeof getWorkspaceMessages> }): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <BellIcon aria-hidden="true" data-icon="inline-start" />
        {messages.notifications}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{messages.notificationsTitle}</DropdownMenuLabel>
          <DropdownMenuItem disabled>{messages.noNotifications}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function SettingsNavigationItem({ label }: { label: string }) {
  const { toggleSidebar } = useSidebar()
  return <DropdownMenuItem onClick={toggleSidebar}><LayoutDashboardIcon aria-hidden="true" />{label}</DropdownMenuItem>
}

function WorkspaceDisplayButton({ locale }: { locale: WorkspaceLocale }) {
  const runtime = useWebRuntime()
  if (runtime.mode === 'surface') return <SurfaceDisplayButton locale={locale} icon={runtime.surfaceDisplay?.fullscreen ? MinimizeIcon : MaximizeIcon} />
  return <StandaloneDisplayButton locale={locale} />
}

function StandaloneDisplayButton({ locale }: { locale: WorkspaceLocale }) {
  const runtime = useWebRuntime()
  const [fullscreen, setFullscreen] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const update = () => { setFullscreen(document.fullscreenElement !== null); setFailed(false) }
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  const label = locale === 'zh-CN' ? fullscreen ? '退出全屏' : '全屏 ClinMesh' : fullscreen ? 'Exit fullscreen' : 'Fullscreen ClinMesh'
  const Icon = fullscreen ? MinimizeIcon : MaximizeIcon
  const available = typeof document.documentElement.requestFullscreen === 'function'
  const toggle = async () => {
    try {
      if (fullscreen) await document.exitFullscreen()
      else await (runtime.appearanceRoot.current ?? document.documentElement).requestFullscreen()
    } catch { setFailed(true) }
  }
  return <Button type="button" variant="ghost" size="icon" aria-label={label} disabled={!available}
    title={!available ? locale === 'zh-CN' ? '此浏览器不支持全屏' : 'Fullscreen is unavailable in this browser'
      : failed ? locale === 'zh-CN' ? '无法切换全屏，请重试' : 'Unable to change fullscreen; try again' : label}
    onClick={() => void toggle()}><Icon aria-hidden="true" /></Button>
}

export function WorkspaceShell({
  activeSection,
  children,
  locale,
  onLocaleChange,
  onRoleChange,
  onSignOut,
  onThemeChange,
  roleChangePending,
  session,
  signOutPending,
  theme,
}: WorkspaceShellProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const runtime = useWebRuntime()
  const navigate = useNavigate()
  const mode = useWorkspaceMode(workspaceModeScope(session))
  const assistantLabel = assistantLabels[runtime.surfaceAgentStatus ?? 'unavailable'][locale === 'zh-CN' ? 0 : 1]
  const activeRoleSection = roleSections[session.actor.roleCode]
  const inpatientTitles: Partial<Record<SessionContext['actor']['roleCode'], string>> = {
    registrar: locale === 'zh-CN' ? '住院登记' : 'Inpatient registration',
    cashier: locale === 'zh-CN' ? '住院收费' : 'Inpatient billing',
    pharmacist: locale === 'zh-CN' ? '住院药房' : 'Inpatient pharmacy',
  }
  const workspaceTitle = mode === 'inpatient' ? inpatientTitles[session.actor.roleCode] ?? messages[activeRoleSection] : messages[activeRoleSection]
  const visibleRoutes = useMemo(() => workspaceRoutes.filter(route => (
    route.key === activeRoleSection
  )), [activeRoleSection, session.actor.roleCode])
  useEffect(() => {
    if (runtime.mode !== 'surface' || !runtime.surfaceNavigation) return
    const routes = [...visibleRoutes, ...settingsRoutes.filter(route => route.key !== 'settingsGeneral')]
    return runtime.surfaceNavigation.register({
      items: routes.map(route => ({ path: route.path, label: route.key === activeRoleSection ? workspaceTitle : messages[route.key] })),
      activePath: routes.find(route => route.key === activeSection)?.path ?? '/',
      locale,
      navigate(path) {
        const target = routes.find(route => route.path === path)
        if (target) void navigate({ to: target.path })
      },
    })
  }, [activeSection, activeRoleSection, locale, messages, navigate, runtime.mode, runtime.surfaceNavigation, visibleRoutes, workspaceTitle])
  const settingsMode = isSettingsSection(activeSection)
  const workingRoles = session.availableRoles.filter(role => role.practitionerId === session.actor.practitionerId
    && role.code === session.actor.roleCode)
  const navigationLabel = settingsMode ? messages.settingsNavigation : messages.navigationLabel
  const mobileDescription = settingsMode
    ? messages.mobileSettingsNavigationDescription
    : messages.mobileNavigationDescription

  const content = (
    <>
      <header className="@container/workspace-header sticky top-0 z-10 flex h-[3.375rem] shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
        <h1 data-agent-page-title="" className="min-w-0 max-w-40 truncate text-sm font-semibold">
          {activeSection === activeRoleSection ? workspaceTitle : messages[activeSection]}
        </h1>
        <div className="min-w-0 flex-1"><WorkspaceHeaderPatientSlot /></div>
        <div className="clinmesh-shell-assistant min-w-0 max-w-[35%] text-xs text-muted-foreground" data-agent-feedback-status="">
          <span className="clinmesh-shell-assistant-placeholder block truncate">{assistantLabel}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <WorkspaceDisplayButton locale={locale} />
          <UserMenu
            locale={locale}
            settingsMode={settingsMode}
            messages={messages}
            onRoleChange={onRoleChange}
            onSignOut={onSignOut}
            onThemeChange={onThemeChange}
            roleChangePending={roleChangePending}
            session={session}
            signOutPending={signOutPending}
            theme={theme}
          />
        </div>
      </header>
      <div
        className={settingsMode ? 'flex min-h-0 flex-1 flex-col overflow-y-auto bg-background outline-none' : 'flex min-h-0 flex-1 flex-col overflow-hidden bg-background outline-none'}
        data-clinmesh-workspace-panel=""
        tabIndex={-1}
      >
        {/* 住院工作台先绑定会话的单一病区，不展示工作病区切换；其他岗位保留工作地点选择。 */}
        {!settingsMode && workingRoles.length > 1 && activeSection !== 'inpatient' ? (
          <FieldSet className="shrink-0 border-b p-3" disabled={roleChangePending}>
            <FieldGroup className="max-w-sm">
              <Field>
                <FieldLabel htmlFor="workspace-working-location">{messages.workingLocation}</FieldLabel>
                <WorkspaceSelect id="workspace-working-location" value={session.actor.practitionerRoleId ?? null}
                  items={workingRoles.map(role => ({ value: role.id, label: clinicalDisplayName(role.locationName ?? role.locationId) }))}
                  onValueChange={value => { if (value !== null) onRoleChange(value) }} />
              </Field>
            </FieldGroup>
          </FieldSet>
        ) : null}
        {children}
      </div>
    </>
  )

  if (runtime.mode === 'surface' || !settingsMode) {
    return (
      <WorkspaceHeaderProvider><TooltipProvider>
        <main className={runtime.mode === 'surface' ? 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden' : 'flex h-svh min-h-0 min-w-0 flex-col overflow-hidden'}>
          {content}
        </main>
      </TooltipProvider></WorkspaceHeaderProvider>
    )
  }

  return (
    <WorkspaceHeaderProvider><TooltipProvider>
      <ResponsiveSidebarProvider
        className={['consultation', 'inpatient', 'registration', 'billing', 'pharmacy'].includes(activeSection)
          ? 'h-svh overflow-hidden' : undefined}
        heightMode="viewport"
        style={{
          '--sidebar-width': '13.75rem',
          '--sidebar-width-icon': '3rem',
        } as React.CSSProperties}
      >
        <Sidebar
          collapsible="icon"
          mobileDescription={mobileDescription}
          mobileTitle={navigationLabel}
          variant="inset"
        >
          <SidebarHeader>
            <Brand
              appName={messages.appName}
              logoAlt={messages.logoAlt}
              productTagline={messages.productTagline}
            />
          </SidebarHeader>
          <SidebarContent>
            {settingsMode ? (
              <nav aria-label={messages.settingsNavigation}>
                <SidebarGroup>
                  <SidebarGroupLabel>{messages.settings}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {settingsRoutes.filter(item => item.key !== 'uiComponents').map(item => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            aria-current={item.key === activeSection ? 'page' : undefined}
                            isActive={item.key === activeSection}
                            render={<Link to={item.path} />}
                            tooltip={messages[item.key]}
                          >
                            <item.icon aria-hidden="true" />
                            <span>{messages[item.key]}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup>
                  <SidebarGroupLabel>{messages.developer}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {settingsRoutes.filter(item => item.key === 'uiComponents').map(item => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            aria-current={item.key === activeSection ? 'page' : undefined}
                            isActive={item.key === activeSection}
                            render={<Link to={item.path} />}
                            tooltip={messages[item.key]}
                          >
                            <item.icon aria-hidden="true" />
                            <span>{messages[item.key]}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </nav>
            ) : (
              <SidebarGroup>
                <SidebarGroupLabel>{messages.navigationGroup}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <nav aria-label={messages.navigationLabel}>
                  <SidebarMenu>
                    {visibleRoutes.map(item => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          aria-current={item.key === activeSection ? 'page' : undefined}
                          isActive={item.key === activeSection}
                          render={<Link to={item.path} />}
                          tooltip={messages[item.key]}
                        >
                          <item.icon aria-hidden="true" />
                          <span>{messages[item.key]}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                  </nav>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-label={messages.settings}
                  isActive={settingsMode}
                  render={<Link to="/settings" />}
                  tooltip={messages.settings}
                >
                  <SettingsIcon aria-hidden="true" />
                  <span>{messages.settings}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <AppearanceControls
              locale={locale}
              messages={messages}
              onLocaleChange={onLocaleChange}
              onThemeChange={onThemeChange}
              showLabel={false}
              showLocale={false}
              theme={theme}
            />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          {content}
        </SidebarInset>
      </ResponsiveSidebarProvider>
    </TooltipProvider></WorkspaceHeaderProvider>
  )
}
