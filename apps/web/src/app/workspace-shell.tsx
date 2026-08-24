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
  SidebarProvider,
  SidebarTrigger,
} from '@clinmesh/ui/components/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { TooltipProvider } from '@clinmesh/ui/components/tooltip'
import { Link } from '@tanstack/react-router'
import type { SessionContext } from '@clinmesh/contracts/his'
import {
  BellIcon,
  ClipboardPlusIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  PillIcon,
  ReceiptTextIcon,
  LogOutIcon,
  StethoscopeIcon,
  SunIcon,
  UserRoundIcon,
  ChevronDownIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale, type WorkspaceMessageKey } from './workspace-i18n.ts'

export type WorkspaceTheme = 'system' | 'light' | 'dark'

export const workspaceRoutes = [
  { key: 'overview', path: '/', icon: LayoutDashboardIcon },
  { key: 'registration', path: '/registration', icon: ClipboardPlusIcon },
  { key: 'triage', path: '/triage', icon: HeartPulseIcon },
  { key: 'consultation', path: '/consultation', icon: StethoscopeIcon },
  { key: 'billing', path: '/billing', icon: ReceiptTextIcon },
  { key: 'pharmacy', path: '/pharmacy', icon: PillIcon },
] as const

export type WorkspaceSection = (typeof workspaceRoutes)[number]['key']

interface WorkspaceShellProps {
  activeSection: WorkspaceSection
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
> & { messages: ReturnType<typeof getWorkspaceMessages> }

export const roleSections: Record<SessionContext['actor']['roleCode'], WorkspaceSection> = {
  administrator: 'overview',
  cashier: 'billing',
  'outpatient-doctor': 'consultation',
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
  pharmacist: 'role_pharmacist',
  registrar: 'role_registrar',
  'triage-nurse': 'role_triageNurse',
}

function actingPractitionerLabel(
  role: SessionContext['availableRoles'][number],
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  return `${messages[roleMessageKeys[role.code]]} · ${role.practitionerName}`
}

function firstValue<Value extends string>(values: Value[]): Value | undefined {
  return values[0]
}

function Brand({ appName, hospitalName }: { appName: string; hospitalName: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-1.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <HeartPulseIcon aria-hidden="true" />
      </div>
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <div className="truncate text-sm font-semibold">{appName}</div>
        <div className="truncate text-xs text-muted-foreground">{hospitalName}</div>
      </div>
    </div>
  )
}

function AppearanceControls({
  locale,
  messages,
  onLocaleChange,
  onThemeChange,
  theme,
}: PreferenceControlProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
      <div className="text-xs font-medium text-muted-foreground">{messages.appearanceLabel}</div>
      <div className="flex items-center justify-between gap-2">
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
  locale,
  messages,
  onLocaleChange,
  onRoleChange,
  onSignOut,
  onThemeChange,
  roleChangePending,
  signOutPending,
  theme,
  session,
}: PreferenceControlProps & {
  onRoleChange: (practitionerRoleId: string) => void
  onSignOut: () => void
  roleChangePending: boolean
  session: SessionContext
  signOutPending: boolean
}): React.JSX.Element {
  const activeRole = session.availableRoles.find(role => role.id === session.actor.practitionerRoleId)
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
        <span className="truncate text-xs font-medium">{activeRoleLabel}</span>
        <ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-foreground">{session.user.name}</span>
            <span className="block font-normal">{session.user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{messages.practitionerRole}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={onRoleChange}
            value={session.actor.practitionerRoleId}
          >
            {session.availableRoles.map(role => (
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
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{messages.languageLabel}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={value => onLocaleChange(value as WorkspaceLocale)}
            value={locale}
          >
            {localeOptions.map(option => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {messages[option.label]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
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
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={messages.notifications}
        render={<Button size="icon" variant="ghost" />}
      >
        <BellIcon aria-hidden="true" data-icon="inline-start" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{messages.notificationsTitle}</DropdownMenuLabel>
          <DropdownMenuItem disabled>{messages.noNotifications}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  const activeRoleSection = roleSections[session.actor.roleCode]
  const visibleRoutes = workspaceRoutes.filter(route => (
    route.key === 'overview' || route.key === activeRoleSection
  ))

  return (
    <TooltipProvider>
      <SidebarProvider
        style={{
          '--sidebar-width': '12.75rem',
          '--sidebar-width-icon': '4.25rem',
        } as React.CSSProperties}
      >
        <Sidebar
          collapsible="icon"
          mobileDescription={messages.mobileNavigationDescription}
          mobileTitle={messages.navigationLabel}
          variant="inset"
        >
          <SidebarHeader>
            <Brand appName={messages.appName} hospitalName={messages.hospitalName} />
          </SidebarHeader>
          <SidebarContent>
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
          </SidebarContent>
          <SidebarFooter>
            <AppearanceControls
              locale={locale}
              messages={messages}
              onLocaleChange={onLocaleChange}
              onThemeChange={onThemeChange}
              theme={theme}
            />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="sticky top-0 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
            <SidebarTrigger aria-label={messages.sidebarToggle} title={messages.sidebarToggle} />
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{messages[activeSection]}</div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <NotificationsMenu messages={messages} />
              <UserMenu
                locale={locale}
                messages={messages}
                onLocaleChange={onLocaleChange}
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
          <div className="flex flex-1 flex-col gap-5 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-xl font-semibold">{messages[activeSection]}</h1>
              <Badge variant="secondary">{messages.simulationBadge}</Badge>
            </div>
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
