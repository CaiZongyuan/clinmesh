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
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@clinmesh/ui/components/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@clinmesh/ui/components/input-group'
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
import {
  BellIcon,
  ClipboardPlusIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  PillIcon,
  ReceiptTextIcon,
  SearchIcon,
  StethoscopeIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react'
import { useState } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale, type WorkspaceMessageKey } from './workspace-i18n.ts'

export interface WorkspaceShellProps {
  activeSection: WorkspaceSection
  locale: WorkspaceLocale
  onLocaleChange: (locale: WorkspaceLocale) => void
  onThemeChange: (theme: WorkspaceTheme) => void
  theme: WorkspaceTheme
}

export type WorkspaceTheme = 'system' | 'light' | 'dark'
export type WorkspaceSection = 'overview' | 'registration' | 'triage' | 'consultation' | 'billing' | 'pharmacy'

type PreferenceControlProps = Pick<
  WorkspaceShellProps,
  'locale' | 'onLocaleChange' | 'onThemeChange' | 'theme'
> & { messages: ReturnType<typeof getWorkspaceMessages> }

const roleNavigation = [
  { key: 'overview', href: '/', icon: LayoutDashboardIcon },
  { key: 'registration', href: '/registration', icon: ClipboardPlusIcon },
  { key: 'triage', href: '/triage', icon: HeartPulseIcon },
  { key: 'consultation', href: '/consultation', icon: StethoscopeIcon },
  { key: 'billing', href: '/billing', icon: ReceiptTextIcon },
  { key: 'pharmacy', href: '/pharmacy', icon: PillIcon },
] satisfies Array<{
  key: WorkspaceMessageKey
  href: string
  icon: typeof LayoutDashboardIcon
}>

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
  onThemeChange,
  theme,
}: PreferenceControlProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={messages.userMenu}
        render={<Button size="icon" variant="ghost" />}
      >
        <Avatar className="size-7 rounded-md">
          <AvatarFallback className="rounded-md">
            <UserRoundIcon aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-foreground">{messages.demoUser}</span>
            <span className="block font-normal">{messages.localWorkspace}</span>
          </DropdownMenuLabel>
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
        <BellIcon aria-hidden="true" />
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

function WorkspaceEntries({
  messages,
  query,
}: {
  messages: ReturnType<typeof getWorkspaceMessages>
  query: string
}): React.JSX.Element {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = roleNavigation.filter(item => (
    messages[item.key].toLocaleLowerCase().includes(normalizedQuery)
  ))

  if (entries.length === 0) {
    return (
      <Empty className="min-h-48 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><SearchIcon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{messages.noSearchResults}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(item => (
        <Button
          className="h-12 justify-start"
          key={item.key}
          nativeButton={false}
          render={<a href={item.href} />}
          variant="outline"
        >
          <item.icon data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate text-left">{messages[item.key]}</span>
          <span className="text-xs text-muted-foreground">{messages.openWorkspace}</span>
        </Button>
      ))}
    </div>
  )
}

export function WorkspaceShell({
  activeSection,
  locale,
  onLocaleChange,
  onThemeChange,
  theme,
}: WorkspaceShellProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const [query, setQuery] = useState('')

  return (
    <TooltipProvider>
      <SidebarProvider
        style={{
          '--sidebar-width': '12.75rem',
          '--sidebar-width-icon': '4.25rem',
        } as React.CSSProperties}
      >
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <Brand appName={messages.appName} hospitalName={messages.hospitalName} />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>{messages.navigationGroup}</SidebarGroupLabel>
              <SidebarGroupContent>
                <nav aria-label={messages.navigationLabel}>
                  <SidebarMenu>
                    {roleNavigation.map(item => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          aria-current={item.key === activeSection ? 'page' : undefined}
                          isActive={item.key === activeSection}
                          render={<a href={item.href} />}
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
            <InputGroup className="max-w-md flex-1">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={messages.searchLabel}
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder={messages.searchPlaceholder}
                type="search"
                value={query}
              />
            </InputGroup>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <NotificationsMenu messages={messages} />
              <UserMenu
                locale={locale}
                messages={messages}
                onLocaleChange={onLocaleChange}
                onThemeChange={onThemeChange}
                theme={theme}
              />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-5 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-xl font-semibold">{messages[activeSection]}</h1>
              <Badge variant="secondary">{messages.simulationBadge}</Badge>
            </div>
            <section aria-labelledby="workspace-entries-heading" className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold" id="workspace-entries-heading">
                {messages.workspaceEntries}
              </h2>
              <WorkspaceEntries messages={messages} query={query} />
            </section>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
