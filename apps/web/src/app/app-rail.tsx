import type { AppSpaceId } from '@clinmesh/ui/appearance'
import { Button } from '@clinmesh/ui/components/button'
import { Kbd } from '@clinmesh/ui/components/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clinmesh/ui/components/tooltip'
import {
  BotIcon,
  MessageSquareIcon,
  MicroscopeIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  StethoscopeIcon,
  SunIcon,
} from 'lucide-react'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import { useAppearance } from './appearance-context.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

interface RailItemDef {
  id: AppSpaceId
  shortZh: string
  shortEn: string
  fullZh: string
  fullEn: string
  shortcut: string
  icon: typeof StethoscopeIcon
}

const MAIN_SPACE_ITEMS: readonly RailItemDef[] = [
  {
    id: 'clinical',
    shortZh: '工作台',
    shortEn: 'Clinic',
    fullZh: '临床工作台',
    fullEn: 'Clinical Workbench',
    shortcut: 'Alt+1',
    icon: StethoscopeIcon,
  },
  {
    id: 'chat',
    shortZh: '聊天',
    shortEn: 'Chat',
    fullZh: '全屏聊天',
    fullEn: 'Chat',
    shortcut: 'Alt+2',
    icon: MessageSquareIcon,
  },
  {
    id: 'agents',
    shortZh: '智能体',
    shortEn: 'Agents',
    fullZh: '个人智能体',
    fullEn: 'Personal Agents',
    shortcut: 'Alt+3',
    icon: BotIcon,
  },
  {
    id: 'research',
    shortZh: '科研',
    shortEn: 'Lab',
    fullZh: '临床科研',
    fullEn: 'Research',
    shortcut: 'Alt+4',
    icon: MicroscopeIcon,
  },
]

export function AppRail({
  activeSpace,
  locale,
  assistantRunning = false,
  onSelectSpace,
  onOpenCommandPalette,
}: {
  activeSpace: AppSpaceId
  locale: WorkspaceLocale
  assistantRunning?: boolean
  onSelectSpace: (space: AppSpaceId) => void
  onOpenCommandPalette: () => void
}): React.JSX.Element | null {
  const zh = locale === 'zh-CN'
  const {
    appearance,
    resolvedColorMode,
    safeMode,
    setColorMode,
    setRailMode,
    exitSafeMode,
  } = useAppearance()

  if (appearance.railMode === 'hidden') return null

  const expanded = appearance.railMode === 'expanded'

  return (
    <nav
      aria-label={zh ? '应用顶层空间导航' : 'Primary space navigation'}
      className={expanded
        ? 'hidden h-svh w-52 shrink-0 flex-col border-r bg-app-shell px-2.5 py-2 select-none md:flex'
        : 'hidden h-svh w-[60px] shrink-0 flex-col items-center border-r bg-app-shell px-1.5 py-2 select-none md:flex'}
      data-cm="app-rail"
      data-rail-mode={appearance.railMode}
    >
      {/* Brand mark */}
      <div className={expanded ? 'mb-2 flex h-9 items-center gap-2.5 px-1.5' : 'mb-2 flex h-9 w-full items-center justify-center'}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card p-1">
          <img alt="ClinMesh" className="size-6 object-contain" src={clinmeshMarkUrl} />
        </div>
        {expanded ? (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold text-foreground">ClinMesh</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {zh ? '医疗智能体平台' : 'Clinical Agent HIS'}
            </div>
          </div>
        ) : null}
      </div>

      {/* Command Palette Trigger (Ctrl+K) */}
      <div className={expanded ? 'mb-2.5 w-full' : 'mb-2.5 flex w-full justify-center'}>
        <Button
          aria-label={zh ? '打开命令面板 (Ctrl+K)' : 'Open Command Palette (Ctrl+K)'}
          className={expanded ? 'h-8 w-full justify-start gap-2 bg-card px-2.5 text-muted-foreground transition-colors' : 'size-10 bg-card text-muted-foreground transition-colors'}
          onClick={onOpenCommandPalette}
          size={expanded ? 'sm' : 'icon'}
          title={zh ? '命令面板 (Ctrl+K)' : 'Command Palette (Ctrl+K)'}
          type="button"
          variant="outline"
        >
          <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
          {expanded ? (
            <>
              <span className="truncate text-xs">{zh ? '搜索或跳转…' : 'Search or jump…'}</span>
              <Kbd className="ml-auto">Ctrl K</Kbd>
            </>
          ) : null}
        </Button>
      </div>

      {expanded ? (
        <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
          {zh ? '工作空间' : 'Spaces'}
        </div>
      ) : null}

      {/* Main 4 Top-Level Spaces */}
      <div className={expanded ? 'flex w-full flex-col gap-1' : 'flex w-full flex-col items-center gap-1'}>
        {MAIN_SPACE_ITEMS.map(item => {
          const active = activeSpace === item.id
          const fullLabel = zh ? item.fullZh : item.fullEn
          const shortLabel = zh ? item.shortZh : item.shortEn
          const Icon = item.icon

          const showDot = assistantRunning && item.id === 'clinical' && activeSpace !== 'clinical'

          const button = (
            <Button
              aria-current={active ? 'page' : undefined}
              aria-label={fullLabel}
              className={expanded
                ? (active
                    ? 'relative h-9 w-full justify-start gap-2.5 bg-card px-2.5 font-medium text-foreground shadow-2xs ring-1 ring-border transition-colors'
                    : 'relative h-9 w-full justify-start gap-2.5 px-2.5 font-normal text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground')
                : (active
                    ? 'relative h-12 w-12 flex-col gap-0.5 rounded-lg bg-card p-1 text-info shadow-2xs ring-1 ring-border transition-colors'
                    : 'relative h-12 w-12 flex-col gap-0.5 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground')}
              data-space={item.id}
              key={item.id}
              onClick={() => onSelectSpace(item.id)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Icon aria-hidden="true" className={expanded ? 'size-4 shrink-0' : 'size-[18px] shrink-0'} />
              {showDot ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-info ring-2 ring-app-shell"
                />
              ) : null}
              {expanded ? (
                <>
                  <span className="truncate text-xs">{fullLabel}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/80">
                    {item.shortcut}
                  </span>
                </>
              ) : (
                <span className="max-w-full truncate text-[10px] leading-3">{shortLabel}</span>
              )}
            </Button>
          )

          if (expanded) return button
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger render={button} />
              <TooltipContent side="right">
                <span>{fullLabel}</span>
                <span className="ml-2 font-mono text-[10px] opacity-75">{item.shortcut}</span>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <div className="flex-1" />

      {/* Footer: Settings + Color Mode + Expand/Collapse */}
      <div className={expanded ? 'flex w-full flex-col gap-1 border-t pt-2' : 'flex w-full flex-col items-center gap-1 border-t pt-2'}>
        {safeMode ? (
          <Button
            aria-label={zh ? '退出主题安全模式' : 'Exit Theme Safe Mode'}
            className={expanded ? 'h-8 w-full justify-start gap-2 px-2.5 text-warning' : 'size-9 text-warning'}
            onClick={exitSafeMode}
            size="sm"
            title={zh ? '当前处于主题安全模式，点击退出' : 'Theme Safe Mode active — click to exit'}
            type="button"
            variant="ghost"
          >
            <ShieldAlertIcon aria-hidden="true" className="size-4 shrink-0" />
            {expanded ? <span className="truncate text-xs">{zh ? '退出安全模式' : 'Exit Safe Mode'}</span> : null}
          </Button>
        ) : null}

        <Button
          aria-current={activeSpace === 'settings' ? 'page' : undefined}
          aria-label={zh ? '设置中心' : 'Settings'}
          className={expanded
            ? (activeSpace === 'settings'
                ? 'h-9 w-full justify-start gap-2.5 bg-card px-2.5 font-medium text-foreground shadow-2xs ring-1 ring-border transition-colors'
                : 'h-9 w-full justify-start gap-2.5 px-2.5 font-normal text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground')
            : (activeSpace === 'settings'
                ? 'h-12 w-12 flex-col gap-0.5 rounded-lg bg-card p-1 text-info shadow-2xs ring-1 ring-border transition-colors'
                : 'h-12 w-12 flex-col gap-0.5 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground')}
          data-space="settings"
          onClick={() => onSelectSpace('settings')}
          size="sm"
          title={zh ? '设置中心 (Ctrl+,)' : 'Settings (Ctrl+,)'}
          type="button"
          variant="ghost"
        >
          <SettingsIcon aria-hidden="true" className={expanded ? 'size-4 shrink-0' : 'size-[18px] shrink-0'} />
          {expanded ? (
            <span className="truncate text-xs">{zh ? '设置中心' : 'Settings'}</span>
          ) : (
            <span className="max-w-full truncate text-[10px] leading-3">{zh ? '设置' : 'Settings'}</span>
          )}
        </Button>

        <div className={expanded ? 'flex items-center justify-between pt-1' : 'flex flex-col items-center gap-1 pt-1'}>
          <Button
            aria-label={resolvedColorMode === 'dark' ? (zh ? '切换为亮色' : 'Switch to light mode') : (zh ? '切换为暗色' : 'Switch to dark mode')}
            onClick={() => setColorMode(resolvedColorMode === 'dark' ? 'light' : 'dark')}
            size="icon-sm"
            title={resolvedColorMode === 'dark' ? (zh ? '切换为亮色' : 'Light mode') : (zh ? '切换为暗色' : 'Dark mode')}
            type="button"
            variant="ghost"
          >
            {resolvedColorMode === 'dark'
              ? <MoonIcon aria-hidden="true" className="size-4" />
              : <SunIcon aria-hidden="true" className="size-4" />}
          </Button>
          <Button
            aria-label={expanded ? (zh ? '折叠为极窄图标轨' : 'Collapse to slim rail') : (zh ? '展开左侧主导航栏' : 'Expand left sidebar')}
            onClick={() => setRailMode(expanded ? 'rail' : 'expanded')}
            size="icon-sm"
            title={expanded ? (zh ? '折叠为 56px 图标轨 (Ctrl+B)' : 'Collapse rail (Ctrl+B)') : (zh ? '展开左侧边栏 (Ctrl+B)' : 'Expand sidebar (Ctrl+B)')}
            type="button"
            variant="ghost"
          >
            {expanded
              ? <PanelLeftCloseIcon aria-hidden="true" className="size-4" />
              : <PanelLeftOpenIcon aria-hidden="true" className="size-4" />}
          </Button>
        </div>
      </div>
    </nav>
  )
}
