import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemText,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@clinmesh/ui/components/command'
import { HighlightText } from '@clinmesh/ui/components/highlight-text'
import { ThemeSwatch } from '@clinmesh/ui/components/theme-swatch'
import { useShortcut } from '@clinmesh/ui/hooks/use-shortcuts'
import {
  BotIcon,
  CheckIcon,
  ClockIcon,
  MessageSquareIcon,
  MicroscopeIcon,
  MoonIcon,
  PaletteIcon,
  PanelLeftIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  StethoscopeIcon,
  SunIcon,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useAppearance } from './appearance-context.tsx'
import { SETTINGS_SEARCH_INDEX } from './settings-layout.tsx'
import { useSpaceNavigationStore } from './space-navigation-store.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function GlobalCommandPalette({
  open,
  onOpenChange,
  locale,
  clinicalHomePath,
  onNavigate,
  onToggleAssistant,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locale: WorkspaceLocale
  clinicalHomePath: string
  onNavigate: (path: string, anchor?: string) => void
  onToggleAssistant?: (() => void) | undefined
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [subpage, setSubpage] = useState<'root' | 'themes'>('root')
  const recentVisits = useSpaceNavigationStore(s => s.recentVisits)
  const {
    appearance,
    resolvedColorMode,
    allThemes,
    activeTheme,
    setTheme,
    setColorMode,
    setDensity,
    setRailMode,
    startThemePreview,
    stopThemePreview,
  } = useAppearance()

  const closePalette = useCallback(() => {
    stopThemePreview()
    setQuery('')
    setSubpage('root')
    onOpenChange(false)
  }, [onOpenChange, stopThemePreview])

  // Global safe navigation shortcuts (NEVER bound to clinical data-agent-confirm commits)
  useShortcut('mod+k', event => {
    event.preventDefault()
    if (open) closePalette()
    else onOpenChange(true)
  }, { allowInInput: true })

  useShortcut('mod+b', event => {
    event.preventDefault()
    setRailMode(appearance.railMode === 'expanded' ? 'rail' : 'expanded')
  })

  useShortcut('mod+,', event => {
    event.preventDefault()
    onNavigate('/settings')
  })

  useShortcut('mod+shift+l', event => {
    event.preventDefault()
    setColorMode(resolvedColorMode === 'dark' ? 'light' : 'dark')
  })

  useShortcut('mod+.', event => {
    if (!onToggleAssistant) return
    event.preventDefault()
    onToggleAssistant()
  })

  useShortcut('alt+1', event => {
    event.preventDefault()
    onNavigate(clinicalHomePath)
  })
  useShortcut('alt+2', event => {
    event.preventDefault()
    onNavigate('/chat')
  })
  useShortcut('alt+3', event => {
    event.preventDefault()
    onNavigate('/agents')
  })
  useShortcut('alt+4', event => {
    event.preventDefault()
    onNavigate('/research')
  })

  return (
    <CommandDialog
      onOpenChange={next => {
        if (!next) closePalette()
        else onOpenChange(true)
      }}
      open={open}
      title={zh ? '全局命令面板' : 'Command Palette'}
    >
      <Command
        onQueryChange={setQuery}
        onValueChange={val => {
          if (subpage === 'themes' && typeof val === 'string' && val.startsWith('theme:')) {
            startThemePreview(val.slice('theme:'.length))
          } else {
            stopThemePreview()
          }
        }}
        query={query}
      >
        <div className="flex items-center border-b">
          {subpage === 'themes' ? (
            <span className="ml-3 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-foreground">
              {zh ? '切换主题' : 'Themes'}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <CommandInput
              aria-label={zh ? '搜索命令、空间、主题或设置项' : 'Search commands, spaces, themes, or settings'}
              onKeyDown={event => {
                if (event.key === 'Backspace' && query === '' && subpage === 'themes') {
                  stopThemePreview()
                  setSubpage('root')
                }
              }}
              placeholder={subpage === 'themes'
                ? (zh ? '方向键或悬停可实时预览主题，回车应用…' : 'Use arrows or hover to preview theme live…')
                : (zh ? '输入命令：工作台、聊天、智能体、科研、主题、设置…' : 'Jump to space, preview theme, toggle mode, or search settings…')}
            />
          </div>
        </div>

        <CommandList onMouseLeave={stopThemePreview}>
          <CommandEmpty>{zh ? '无匹配命令' : 'No matching commands'}</CommandEmpty>

          {subpage === 'themes' ? (
            <CommandGroup>
              <CommandGroupLabel>{zh ? '选择主题（悬停或方向键实时试穿）' : 'Themes (Live preview on hover/arrow)'}</CommandGroupLabel>
              {allThemes.map(theme => {
                const isCurrent = theme.id === activeTheme.id
                return (
                  <CommandItem
                    key={theme.id}
                    keywords={[theme.id, theme.name, theme.enName ?? '', theme.author ?? '']}
                    label={zh ? theme.name : (theme.enName ?? theme.name)}
                    onMouseEnter={() => startThemePreview(theme.id)}
                    onSelect={() => {
                      setTheme(theme.id)
                      closePalette()
                    }}
                    value={`theme:${theme.id}`}
                  >
                    <ThemeSwatch mode={resolvedColorMode} theme={theme} />
                    <CommandItemText>{zh ? theme.name : (theme.enName ?? theme.name)}</CommandItemText>
                    <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{theme.id === 'default' ? (zh ? '原版默认' : 'Default') : (theme.enName ?? theme.author)}</span>
                      {isCurrent ? <CheckIcon aria-hidden="true" className="size-3.5 text-foreground" /> : null}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ) : (
            <>
              {recentVisits.length > 1 && query.trim().length === 0 ? (
                <>
                  <CommandGroup>
                    <CommandGroupLabel>{zh ? '最近访问' : 'Recent'}</CommandGroupLabel>
                    {recentVisits.slice(1, 4).map(visit => (
                      <CommandItem
                        key={`recent:${visit.path}`}
                        keywords={[visit.path, visit.labelZh, visit.labelEn]}
                        label={zh ? visit.labelZh : visit.labelEn}
                        onSelect={() => { onNavigate(visit.path); closePalette() }}
                        value={`recent:${visit.path}`}
                      >
                        <ClockIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                        <CommandItemText>{zh ? visit.labelZh : visit.labelEn}</CommandItemText>
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{visit.path}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              ) : null}

              <CommandGroup>
                <CommandGroupLabel>{zh ? '顶层应用空间' : 'App Spaces'}</CommandGroupLabel>
                <CommandItem
                  keywords={['clinical', 'his', 'outpatient', 'inpatient', '工作台', '门诊', '住院']}
                  label={zh ? '前往临床工作台' : 'Go to Clinical Workbench'}
                  onSelect={() => { onNavigate(clinicalHomePath); closePalette() }}
                  value="space:clinical"
                >
                  <StethoscopeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>{zh ? '前往临床工作台' : 'Go to Clinical Workbench'}</CommandItemText>
                  <CommandShortcut shortcut="alt+1" />
                </CommandItem>
                <CommandItem
                  keywords={['chat', 'conversation', 'pi-durable', '聊天', '对话']}
                  label={zh ? '前往全屏聊天页' : 'Go to Chat Space'}
                  onSelect={() => { onNavigate('/chat'); closePalette() }}
                  value="space:chat"
                >
                  <MessageSquareIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>{zh ? '前往全屏聊天页' : 'Go to Chat Space'}</CommandItemText>
                  <CommandShortcut shortcut="alt+2" />
                </CommandItem>
                <CommandItem
                  keywords={['agent', 'memory', 'skills', '个人', '智能体', '记忆']}
                  label={zh ? '前往个人智能体工作台' : 'Go to Personal Agent Workbench'}
                  onSelect={() => { onNavigate('/agents'); closePalette() }}
                  value="space:agents"
                >
                  <BotIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>{zh ? '前往个人智能体工作台' : 'Go to Personal Agent Workbench'}</CommandItemText>
                  <CommandShortcut shortcut="alt+3" />
                </CommandItem>
                <CommandItem
                  keywords={['research', 'cohort', 'evaluation', '科研', '队列', '病例']}
                  label={zh ? '前往临床科研空间' : 'Go to Clinical Research'}
                  onSelect={() => { onNavigate('/research'); closePalette() }}
                  value="space:research"
                >
                  <MicroscopeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>{zh ? '前往临床科研空间' : 'Go to Clinical Research'}</CommandItemText>
                  <CommandShortcut shortcut="alt+4" />
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup>
                <CommandGroupLabel>{zh ? '外观与布局' : 'Appearance & Layout'}</CommandGroupLabel>
                <CommandItem
                  keywords={['theme', 'skin', 'preview', '主题', '皮肤']}
                  label={zh ? '切换主题（支持实时预览）…' : 'Switch Theme (Live Preview)…'}
                  onSelect={() => {
                    setQuery('')
                    setSubpage('themes')
                  }}
                  value="appearance:themes"
                >
                  <PaletteIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>{zh ? '切换主题（支持实时预览）…' : 'Switch Theme (Live Preview)…'}</CommandItemText>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {zh ? activeTheme.name : (activeTheme.enName ?? activeTheme.name)} ›
                  </span>
                </CommandItem>
                <CommandItem
                  keywords={['light', 'dark', 'mode', '亮色', '暗色', '深色', '浅色']}
                  label={resolvedColorMode === 'dark' ? (zh ? '切换为亮色模式' : 'Switch to Light Mode') : (zh ? '切换为暗色模式' : 'Switch to Dark Mode')}
                  onSelect={() => {
                    setColorMode(resolvedColorMode === 'dark' ? 'light' : 'dark')
                    closePalette()
                  }}
                  value="appearance:toggle-mode"
                >
                  {resolvedColorMode === 'dark'
                    ? <SunIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    : <MoonIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
                  <CommandItemText>
                    {resolvedColorMode === 'dark' ? (zh ? '切换为亮色模式' : 'Switch to Light Mode') : (zh ? '切换为暗色模式' : 'Switch to Dark Mode')}
                  </CommandItemText>
                  <CommandShortcut shortcut="mod+shift+l" />
                </CommandItem>
                <CommandItem
                  keywords={['rail', 'sidebar', 'expand', '导航轨', '侧边栏']}
                  label={appearance.railMode === 'expanded' ? (zh ? '收起左侧导航轨为 56px 图标轨' : 'Collapse Left Rail to 56px') : (zh ? '展开左侧主导航轨' : 'Expand Left Navigation Rail')}
                  onSelect={() => {
                    setRailMode(appearance.railMode === 'expanded' ? 'rail' : 'expanded')
                    closePalette()
                  }}
                  value="appearance:toggle-rail"
                >
                  <PanelLeftIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>
                    {appearance.railMode === 'expanded' ? (zh ? '收起左侧导航轨为 56px 图标轨' : 'Collapse Left Rail to 56px') : (zh ? '展开左侧主导航轨' : 'Expand Left Navigation Rail')}
                  </CommandItemText>
                  <CommandShortcut shortcut="mod+b" />
                </CommandItem>
                <CommandItem
                  keywords={['density', 'compact', '密度', '紧凑']}
                  label={appearance.density === 'compact' ? (zh ? '恢复标准信息密度' : 'Use Default Density') : (zh ? '切换紧凑信息密度' : 'Use Compact Density')}
                  onSelect={() => {
                    setDensity(appearance.density === 'compact' ? 'default' : 'compact')
                    closePalette()
                  }}
                  value="appearance:toggle-density"
                >
                  <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  <CommandItemText>
                    {appearance.density === 'compact' ? (zh ? '恢复标准信息密度' : 'Use Default Density') : (zh ? '切换紧凑信息密度' : 'Use Compact Density')}
                  </CommandItemText>
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup>
                <CommandGroupLabel>{zh ? '设置直达' : 'Settings'}</CommandGroupLabel>
                {SETTINGS_SEARCH_INDEX.map(entry => (
                  <CommandItem
                    key={entry.id}
                    keywords={[...entry.keywords, entry.titleZh, entry.titleEn]}
                    label={zh ? entry.titleZh : entry.titleEn}
                    onSelect={() => {
                      onNavigate(entry.path, entry.anchor)
                      closePalette()
                    }}
                    value={`settings:${entry.id}`}
                  >
                    <SettingsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <CommandItemText>
                      <HighlightText query={query} text={zh ? entry.titleZh : entry.titleEn} />
                    </CommandItemText>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {zh ? entry.sectionZh : entry.sectionEn}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>

        <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{zh ? '↑↓ 移动 · Enter 执行 · Backspace 返回 · Esc 关闭' : 'Arrows move · Enter run · Backspace back · Esc close'}</span>
          <span>@ui-sdk/react/command</span>
        </div>
      </Command>
    </CommandDialog>
  )
}
