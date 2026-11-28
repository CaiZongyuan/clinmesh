import type { AppSpaceId } from '@clinmesh/ui/appearance'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
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
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { HighlightText } from '@clinmesh/ui/components/highlight-text'
import { Input } from '@clinmesh/ui/components/input'
import { Kbd } from '@clinmesh/ui/components/kbd'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@clinmesh/ui/components/sheet'
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
import { ThemeSwatch } from '@clinmesh/ui/components/theme-swatch'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { TooltipProvider } from '@clinmesh/ui/components/tooltip'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  BellIcon,
  BotIcon,
  ChartNoAxesCombinedIcon,
  ChevronDownIcon,
  ClipboardPlusIcon,
  ComponentIcon,
  CpuIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  HeartPulseIcon,
  KeyboardIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MaximizeIcon,
  MenuIcon,
  MessageSquareIcon,
  MicroscopeIcon,
  MinimizeIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PillIcon,
  ReceiptTextIcon,
  SearchIcon,
  SettingsIcon,
  StethoscopeIcon,
  SunIcon,
  UserRoundIcon,
  XIcon,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import clinmeshWordmarkUrl from '../assets/clinmesh-wordmark.webp'
import { AppRail } from './app-rail.tsx'
import { useAppearance } from './appearance-context.tsx'
import { ClinicianAssistantSidebar } from './clinician-assistant-sidebar.tsx'
import { GlobalCommandPalette } from './command-palette.tsx'
import { useLlmSettings } from './llm-settings-storage.ts'
import { ResponsiveSidebarProvider } from './responsive-sidebar.tsx'
import { SETTINGS_SEARCH_INDEX } from './settings-layout.tsx'
import { useSpaceNavigationStore } from './space-navigation-store.ts'
import { useWebRuntime } from './web-runtime.tsx'
import {
  WorkspaceHeaderFlowSlot,
  WorkspaceHeaderLeadSlot,
  WorkspaceHeaderPatientSlot,
  WorkspaceHeaderProvider,
} from './workspace-card-layout.tsx'
import { getWorkspaceMessages, type WorkspaceLocale, type WorkspaceMessageKey } from './workspace-i18n.ts'
import { useWorkspaceMode, workspaceModeScope } from './workspace-mode.tsx'
import { WorkspaceSelect } from './workspace-select.tsx'

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

export const platformSpaceRoutes = [
  { key: 'chatSpace', path: '/chat', icon: MessageSquareIcon },
  { key: 'agentsSpace', path: '/agents', icon: BotIcon },
  { key: 'researchSpace', path: '/research', icon: MicroscopeIcon },
] as const

export type PlatformSpaceSection = (typeof platformSpaceRoutes)[number]['key']

export const settingsRoutes = [
  { key: 'settingsGeneral', path: '/settings', icon: PaletteIcon },
  { key: 'settingsShortcuts', path: '/settings/shortcuts', icon: KeyboardIcon },
  { key: 'modelsProvider', path: '/settings/models', icon: CpuIcon },
  { key: 'modelUsage', path: '/settings/model-usage', icon: ChartNoAxesCombinedIcon },
  { key: 'uiComponents', path: '/settings/developer/components', icon: ComponentIcon },
] as const

export type SettingsSection = (typeof settingsRoutes)[number]['key']
export type AppSection = WorkspaceSection | PlatformSpaceSection | SettingsSection

export function isSettingsSection(section: AppSection): section is SettingsSection {
  return settingsRoutes.some(route => route.key === section)
}

export function isPlatformSpaceSection(section: AppSection): section is PlatformSpaceSection {
  return platformSpaceRoutes.some(route => route.key === section)
}

export function sectionToAppSpace(section: AppSection): AppSpaceId {
  if (isSettingsSection(section)) return 'settings'
  if (section === 'chatSpace') return 'chat'
  if (section === 'agentsSpace') return 'agents'
  if (section === 'researchSpace') return 'research'
  return 'clinical'
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
  onJumpToSettingsAnchor?: (path: string, anchor?: string) => void
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
  return (
    <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
      {showLabel ? (
        <div className="text-xs font-medium text-muted-foreground">{messages.appearanceLabel}</div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {showLocale ? (
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
      </div>
    </div>
  )
}

function UserMenu({
  settingsMode,
  locale,
  messages,
  onRoleChange,
  onSignOut,
  onThemeChange,
  roleChangePending,
  signOutPending,
  theme,
  session,
}: Pick<PreferenceControlProps, 'messages' | 'onThemeChange' | 'theme'> & {
  settingsMode: boolean
  locale: WorkspaceLocale
  onRoleChange: (practitionerRoleId: string) => void
  onSignOut: () => void
  roleChangePending: boolean
  session: SessionContext
  signOutPending: boolean
}): React.JSX.Element {
  const { allThemes, activeTheme, resolvedColorMode, setTheme } = useAppearance()
  const zh = locale === 'zh-CN'
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
          <DropdownMenuItem render={<Link to="/chat" />}>
            <MessageSquareIcon aria-hidden="true" />{messages.chatSpace}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/agents" />}>
            <BotIcon aria-hidden="true" />{messages.agentsSpace}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/research" />}>
            <MicroscopeIcon aria-hidden="true" />{messages.researchSpace}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings" />}><SettingsIcon aria-hidden="true" />{messages.settings}</DropdownMenuItem>
          {settingsMode ? <SettingsNavigationItem label={messages.settingsNavigation} /> : null}
          <NotificationsMenu messages={messages} />
        </DropdownMenuGroup>
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <PaletteIcon aria-hidden="true" data-icon="inline-start" />
              <span>{zh ? '界面皮肤' : 'Interface Theme'}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {zh ? activeTheme.name : (activeTheme.enName ?? activeTheme.name)}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-52">
              <DropdownMenuRadioGroup
                onValueChange={value => setTheme(value)}
                value={activeTheme.id}
              >
                {allThemes.map(item => (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    <ThemeSwatch mode={resolvedColorMode} theme={item} />
                    <span className="truncate">{zh ? item.name : (item.enName ?? item.name)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
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
  return (
    <Button
      aria-label={label}
      disabled={!available}
      onClick={() => void toggle()}
      size="icon"
      title={!available
        ? locale === 'zh-CN' ? '此浏览器不支持全屏' : 'Fullscreen is unavailable in this browser'
        : failed ? locale === 'zh-CN' ? '无法切换全屏，请重试' : 'Unable to change fullscreen; try again' : label}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}

function SettingsSidebarSearch({
  locale,
  onSelect,
}: {
  locale: WorkspaceLocale
  onSelect: (path: string, anchor?: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return SETTINGS_SEARCH_INDEX.filter(item =>
      item.titleZh.toLowerCase().includes(q)
      || item.titleEn.toLowerCase().includes(q)
      || item.sectionZh.toLowerCase().includes(q)
      || item.sectionEn.toLowerCase().includes(q)
      || item.keywords.some(k => k.toLowerCase().includes(q)),
    )
  }, [query])

  const openMatch = (index: number) => {
    const chosen = matches[index]
    if (!chosen) return
    onSelect(chosen.path, chosen.anchor)
    setQuery('')
    setActiveIndex(0)
  }

  return (
    <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
      <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={zh ? '搜索设置项' : 'Search settings'}
          className="h-8 pr-7 pl-8 text-xs"
          onChange={event => {
            setQuery(event.currentTarget.value)
            setActiveIndex(0)
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' && matches.length > 0) {
              event.preventDefault()
              setActiveIndex(curr => Math.min(curr + 1, matches.length - 1))
            } else if (event.key === 'ArrowUp' && matches.length > 0) {
              event.preventDefault()
              setActiveIndex(curr => Math.max(curr - 1, 0))
            } else if (event.key === 'Enter' && matches.length > 0) {
              event.preventDefault()
              openMatch(activeIndex)
            } else if (event.key === 'Escape' && query.length > 0) {
              event.preventDefault()
              setQuery('')
              setActiveIndex(0)
            }
          }}
          placeholder={zh ? '搜索设置项…' : 'Search settings…'}
          value={query}
        />
        {query.length > 0 ? (
          <Button
            aria-label={zh ? '清空设置搜索' : 'Clear settings search'}
            className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-muted-foreground"
            onClick={() => {
              setQuery('')
              setActiveIndex(0)
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </Button>
        ) : null}
      </div>
      {query.trim().length > 0 ? (
        <div
          aria-label={zh ? '设置搜索结果' : 'Settings search results'}
          className="mt-1.5 flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border bg-card p-1 shadow-sm"
          role="listbox"
        >
          {matches.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {zh ? '无匹配设置项' : 'No matching settings'}
            </div>
          ) : (
            matches.map((item, index) => (
              <Button
                aria-selected={index === activeIndex}
                className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal"
                key={item.id}
                onClick={() => openMatch(index)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                size="sm"
                type="button"
                variant={index === activeIndex ? 'secondary' : 'ghost'}
              >
                <span className="w-full truncate text-xs font-medium text-foreground">
                  <HighlightText query={query} text={zh ? item.titleZh : item.titleEn} />
                </span>
                <span className="text-[10px] text-muted-foreground">
                  <HighlightText query={query} text={zh ? item.sectionZh : item.sectionEn} />
                </span>
              </Button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function NavigationProgress({ sectionKey }: { sectionKey: string }): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), 320)
    return () => window.clearTimeout(timer)
  }, [sectionKey])
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden transition-opacity duration-200"
      data-cm="nav-progress"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {visible ? <div className="clinmesh-nav-progress-sweep h-full w-1/3 bg-brand" /> : null}
    </div>
  )
}

function CompactSpaceSheet({
  open,
  onOpenChange,
  activeSpace,
  locale,
  onSelectSpace,
  onOpenCommandPalette,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeSpace: AppSpaceId
  locale: WorkspaceLocale
  onSelectSpace: (space: AppSpaceId) => void
  onOpenCommandPalette: () => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const items: Array<{ id: AppSpaceId; label: string; icon: typeof StethoscopeIcon }> = [
    { id: 'clinical', label: zh ? '临床工作台' : 'Clinical Workbench', icon: StethoscopeIcon },
    { id: 'chat', label: zh ? '全屏聊天' : 'Chat', icon: MessageSquareIcon },
    { id: 'agents', label: zh ? '个人智能体' : 'Personal Agents', icon: BotIcon },
    { id: 'research', label: zh ? '临床科研' : 'Clinical Research', icon: MicroscopeIcon },
    { id: 'settings', label: zh ? '设置中心' : 'Settings', icon: SettingsIcon },
  ]
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-64 p-0" side="left">
        <SheetHeader className="border-b px-4 py-3 text-left">
          <SheetTitle className="text-sm">{zh ? '应用空间导航' : 'App Spaces'}</SheetTitle>
          <SheetDescription className="text-xs">
            {zh ? '在临床工作台、聊天、智能体、科研与设置间快速切换。' : 'Switch between Clinical, Chat, Agents, Research, and Settings.'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-1 p-3">
          <Button
            className="mb-2 w-full justify-start gap-2 text-muted-foreground"
            onClick={() => {
              onOpenChange(false)
              onOpenCommandPalette()
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <SearchIcon aria-hidden="true" className="size-3.5" />
            <span>{zh ? '搜索或跳转…' : 'Search or jump…'}</span>
          </Button>
          {items.map(item => {
            const Icon = item.icon
            const active = activeSpace === item.id
            return (
              <Button
                aria-current={active ? 'page' : undefined}
                className="w-full justify-start gap-2.5"
                key={item.id}
                onClick={() => {
                  onSelectSpace(item.id)
                  onOpenChange(false)
                }}
                size="sm"
                type="button"
                variant={active ? 'secondary' : 'ghost'}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{item.label}</span>
              </Button>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function WorkspaceShell({
  activeSection,
  children,
  locale,
  onLocaleChange: _onLocaleChange,
  onRoleChange,
  onSignOut,
  onThemeChange,
  onJumpToSettingsAnchor,
  roleChangePending,
  session,
  signOutPending,
  theme,
}: WorkspaceShellProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const zh = locale === 'zh-CN'
  const navigate = useNavigate()
  const llmSettings = useLlmSettings()
  const { appearance, setRailMode } = useAppearance()
  const spaceLastUrls = useSpaceNavigationStore(s => s.spaceLastUrls)
  const lastNonSettingsPath = useSpaceNavigationStore(s => s.lastNonSettingsPath)
  const recordVisit = useSpaceNavigationStore(s => s.recordVisit)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantRunning, setAssistantRunning] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const mode = useWorkspaceMode(workspaceModeScope(session))
  const activeRoleSection = roleSections[session.actor.roleCode]
  const clinicalHomePath = workspaceRoutes.find(route => route.key === activeRoleSection)?.path ?? '/'
  const inpatientTitles: Partial<Record<SessionContext['actor']['roleCode'], string>> = {
    registrar: locale === 'zh-CN' ? '住院登记' : 'Inpatient registration',
    cashier: locale === 'zh-CN' ? '住院收费' : 'Inpatient billing',
    pharmacist: locale === 'zh-CN' ? '住院药房' : 'Inpatient pharmacy',
  }
  const workspaceTitle = mode === 'inpatient'
    ? inpatientTitles[session.actor.roleCode] ?? messages[activeRoleSection]
    : messages[activeRoleSection]

  const settingsMode = isSettingsSection(activeSection)
  const platformSpaceMode = isPlatformSpaceSection(activeSection)
  const clinicalMode = !settingsMode && !platformSpaceMode
  const activeSpace = sectionToAppSpace(activeSection)
  const workingRoles = session.availableRoles.filter(role => role.practitionerId === session.actor.practitionerId
    && role.code === session.actor.roleCode)

  const headerTitle = activeSection === activeRoleSection ? workspaceTitle : messages[activeSection]
  const backToAppPath = lastNonSettingsPath ?? clinicalHomePath

  // Record per-space last URL and recent visits (Multica space-memory pattern)
  useEffect(() => {
    const pathname = typeof window !== 'undefined' ? window.location.pathname : clinicalHomePath
    recordVisit({
      path: pathname,
      space: activeSpace,
      labelZh: headerTitle,
      labelEn: headerTitle,
    })
  }, [activeSection, activeSpace, clinicalHomePath, headerTitle, recordVisit])

  const handleNavigate = useCallback((path: string, anchor?: string) => {
    if (onJumpToSettingsAnchor) {
      onJumpToSettingsAnchor(path, anchor)
    } else {
      void navigate({ to: path })
    }
  }, [navigate, onJumpToSettingsAnchor])

  const handleSelectSpace = useCallback((space: AppSpaceId) => {
    const home =
      space === 'clinical'
        ? clinicalHomePath
        : space === 'chat'
          ? '/chat'
          : space === 'agents'
            ? '/agents'
            : space === 'research'
              ? '/research'
              : '/settings'
    // Clicking another space restores its last visited path; clicking active space returns to its home.
    const target = space === activeSpace ? home : (spaceLastUrls[space] ?? home)
    handleNavigate(target)
  }, [activeSpace, clinicalHomePath, handleNavigate, spaceLastUrls])

  const content = (
    <>
      <header className="@container/workspace-header sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3" data-cm="header">
        <Button
          aria-label={zh ? '打开应用空间导航' : 'Open space navigation'}
          className="md:hidden"
          onClick={() => setMobileNavOpen(true)}
          size="icon-sm"
          title={zh ? '切换空间' : 'Switch space'}
          type="button"
          variant="ghost"
        >
          <MenuIcon aria-hidden="true" className="size-4" />
        </Button>
        {settingsMode ? (
          <Button
            aria-label={zh ? '返回工作台' : 'Back to workspace'}
            className="gap-1 md:hidden"
            onClick={() => handleNavigate(backToAppPath)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            <span>{zh ? '返回' : 'Back'}</span>
          </Button>
        ) : null}
        {appearance.railMode === 'hidden' ? (
          <Button
            aria-label={locale === 'zh-CN' ? '显示左侧应用导航轨' : 'Show left navigation rail'}
            onClick={() => setRailMode('rail')}
            size="icon-sm"
            title={locale === 'zh-CN' ? '显示左侧应用导航轨 (Ctrl+B)' : 'Show navigation rail (Ctrl+B)'}
            type="button"
            variant="ghost"
          >
            <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <WorkspaceHeaderLeadSlot />
        <h1 data-agent-page-title="" className="min-w-0 max-w-44 shrink-0 truncate text-[0.9375rem] font-semibold">
          {headerTitle}
        </h1>
        <WorkspaceHeaderPatientSlot />
        <WorkspaceHeaderFlowSlot />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {llmSettings.mockMode ? (
            <Link
              aria-label={locale === 'zh-CN' ? '当前为 Mock 模式，点击前往模型设置' : 'Mock Mode active, open Models settings'}
              className="inline-flex items-center"
              to="/settings/models"
            >
              <Badge data-clinmesh-mock-badge="" variant="secondary">
                <FlaskConicalIcon aria-hidden="true" className="size-3" />
                <span>Mock Mode</span>
              </Badge>
            </Link>
          ) : null}
          {clinicalMode ? (
            <Button
              aria-expanded={assistantOpen}
              aria-label={locale === 'zh-CN'
                ? (assistantOpen ? '收起临床助手' : '展开临床助手')
                : (assistantOpen ? 'Hide clinician assistant' : 'Show clinician assistant')}
              className="relative"
              onClick={() => setAssistantOpen(open => !open)}
              size="icon"
              title={locale === 'zh-CN'
                ? (assistantOpen ? '收起临床助手' : '展开临床助手')
                : (assistantOpen ? 'Hide clinician assistant' : 'Show clinician assistant')}
              type="button"
              variant="ghost"
            >
              {assistantOpen
                ? <PanelRightCloseIcon aria-hidden="true" />
                : <PanelRightOpenIcon aria-hidden="true" />}
              {!assistantOpen && assistantRunning ? (
                <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
              ) : null}
            </Button>
          ) : null}
          <StandaloneDisplayButton locale={locale} />
          <UserMenu
            locale={locale}
            messages={messages}
            onRoleChange={onRoleChange}
            onSignOut={onSignOut}
            onThemeChange={onThemeChange}
            roleChangePending={roleChangePending}
            session={session}
            settingsMode={settingsMode}
            signOutPending={signOutPending}
            theme={theme}
          />
        </div>
      </header>
      <div
        className={settingsMode
          ? 'flex min-h-0 flex-1 flex-col overflow-y-auto bg-background outline-none'
          : 'flex min-h-0 flex-1 flex-col overflow-hidden bg-background outline-none'}
        data-clinmesh-workspace-panel=""
        tabIndex={-1}
      >
        {clinicalMode && workingRoles.length > 1 && activeSection !== 'inpatient' ? (
          <FieldSet className="shrink-0 border-b p-3" disabled={roleChangePending}>
            <FieldGroup className="max-w-sm">
              <Field>
                <FieldLabel htmlFor="workspace-working-location">{messages.workingLocation}</FieldLabel>
                <WorkspaceSelect
                  id="workspace-working-location"
                  items={workingRoles.map(role => ({ value: role.id, label: clinicalDisplayName(role.locationName ?? role.locationId) }))}
                  onValueChange={value => { if (value !== null) onRoleChange(value) }}
                  value={session.actor.practitionerRoleId ?? null}
                />
              </Field>
            </FieldGroup>
          </FieldSet>
        ) : null}
        {children}
      </div>
    </>
  )

  const commandPalette = (
    <GlobalCommandPalette
      clinicalHomePath={clinicalHomePath}
      locale={locale}
      onNavigate={handleNavigate}
      onOpenChange={setCommandOpen}
      onToggleAssistant={clinicalMode ? () => setAssistantOpen(open => !open) : undefined}
      open={commandOpen}
    />
  )

  const compactNavSheet = (
    <CompactSpaceSheet
      activeSpace={activeSpace}
      locale={locale}
      onOpenChange={setMobileNavOpen}
      onOpenCommandPalette={() => setCommandOpen(true)}
      onSelectSpace={handleSelectSpace}
      open={mobileNavOpen}
    />
  )

  if (!settingsMode) {
    return (
      <WorkspaceHeaderProvider>
        <TooltipProvider>
          <div className="flex h-svh min-h-0 min-w-0 overflow-hidden bg-app-shell">
            <AppRail
              activeSpace={activeSpace}
              assistantRunning={assistantRunning}
              locale={locale}
              onOpenCommandPalette={() => setCommandOpen(true)}
              onSelectSpace={handleSelectSpace}
            />
            <div
              className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:my-1.5 md:mr-1.5 md:rounded-xl md:border md:border-border/80 md:shadow-2xs"
              data-cm="app-shell-card"
            >
              <NavigationProgress sectionKey={activeSection} />
              <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {content}
              </main>
              {clinicalMode ? (
                <ClinicianAssistantSidebar
                  locale={locale}
                  onCollapse={() => setAssistantOpen(false)}
                  onExpand={() => setAssistantOpen(true)}
                  onRunningChange={setAssistantRunning}
                  open={assistantOpen}
                  session={session}
                />
              ) : null}
            </div>
          </div>
          {compactNavSheet}
          {commandPalette}
        </TooltipProvider>
      </WorkspaceHeaderProvider>
    )
  }

  return (
    <WorkspaceHeaderProvider>
      <TooltipProvider>
        <div className="flex h-svh min-h-0 min-w-0 overflow-hidden bg-app-shell">
          <AppRail
            activeSpace={activeSpace}
            assistantRunning={assistantRunning}
            locale={locale}
            onOpenCommandPalette={() => setCommandOpen(true)}
            onSelectSpace={handleSelectSpace}
          />
          <div
            className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:my-1.5 md:mr-1.5 md:rounded-xl md:border md:border-border/80 md:shadow-2xs"
            data-cm="app-shell-card"
          >
            <NavigationProgress sectionKey={activeSection} />
            <ResponsiveSidebarProvider
              heightMode="viewport"
              style={{
                '--sidebar-width': '14.5rem',
                '--sidebar-width-icon': '3rem',
              } as React.CSSProperties}
            >
              <Sidebar
                className="absolute"
                collapsible="icon"
                mobileDescription={messages.mobileSettingsNavigationDescription}
                mobileTitle={messages.settingsNavigation}
                variant="sidebar"
              >
                <SidebarHeader className="gap-2 border-b pb-2.5">
                  <Button
                    className="h-8 w-full justify-start gap-2 px-2 text-xs font-medium text-foreground"
                    data-cm="settings-back-to-app"
                    onClick={() => handleNavigate(backToAppPath)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">{zh ? '返回工作台' : 'Back to workspace'}</span>
                  </Button>
                  <Brand
                    appName={messages.appName}
                    logoAlt={messages.logoAlt}
                    productTagline={messages.productTagline}
                  />
                </SidebarHeader>
                <SidebarContent className="pt-2">
                  <SettingsSidebarSearch locale={locale} onSelect={handleNavigate} />
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
                </SidebarContent>
                <SidebarFooter className="border-t pt-2">
                  <Button
                    className="h-8 w-full justify-between px-2 text-xs text-muted-foreground"
                    onClick={() => setCommandOpen(true)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <SearchIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '命令面板' : 'Commands'}</span>
                    </span>
                    <Kbd>Ctrl K</Kbd>
                  </Button>
                </SidebarFooter>
              </Sidebar>
              <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
                {content}
              </SidebarInset>
            </ResponsiveSidebarProvider>
          </div>
        </div>
        {compactNavSheet}
        {commandPalette}
      </TooltipProvider>
    </WorkspaceHeaderProvider>
  )
}
