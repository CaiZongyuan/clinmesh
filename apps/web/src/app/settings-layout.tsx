import { Badge } from '@clinmesh/ui/components/badge'
import { Building2Icon, KeyRoundIcon, LaptopIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export type SettingsScope = 'device' | 'device-secret' | 'workspace'

export interface SettingsSearchItem {
  id: string
  path: string
  anchor?: string
  titleZh: string
  titleEn: string
  sectionZh: string
  sectionEn: string
  keywords: readonly string[]
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchItem[] = [
  {
    id: 'color-mode',
    path: '/settings',
    anchor: 'color-mode',
    titleZh: '色彩模式（亮色 / 暗色 / 跟随系统）',
    titleEn: 'Color Mode (Light / Dark / System)',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['mode', 'light', 'dark', 'system', '亮色', '暗色', '深色', '浅色', '色彩'],
  },
  {
    id: 'theme-picker',
    path: '/settings',
    anchor: 'theme',
    titleZh: '主题皮肤与主题库（6 套原创主题）',
    titleEn: 'Theme & Theme Library (6 Built-in Themes)',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['theme', 'skin', 'default', 'warm', 'scrub', 'ward', 'ink', '主题', '皮肤', '护眼', '查房'],
  },
  {
    id: 'custom-theme',
    path: '/settings',
    anchor: 'custom-theme',
    titleZh: '导入自定义主题包 (.zip) 与导出模板',
    titleEn: 'Import Custom Theme (.zip) & Export Template',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['zip', 'import', 'export', 'custom', 'safe mode', '导入', '导出', '自定义'],
  },
  {
    id: 'rail-mode',
    path: '/settings',
    anchor: 'rail-mode',
    titleZh: '左侧主导航轨形态（图标轨 / 展开 / 隐藏）',
    titleEn: 'Left Navigation Rail Mode (Rail / Expanded / Hidden)',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['rail', 'sidebar', 'layout', '导航轨', '侧边栏', '布局', '专注'],
  },
  {
    id: 'font-size',
    path: '/settings',
    anchor: 'font-size',
    titleZh: '界面字号与缩放（12–18px / 三档快捷）',
    titleEn: 'Interface Font Size (12–18px)',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['font', 'size', 'scale', '字号', '字体', '大', '较大', '标准'],
  },
  {
    id: 'density',
    path: '/settings',
    anchor: 'density',
    titleZh: '信息密度与无障碍（高对比度 / 减弱动效）',
    titleEn: 'Density & Accessibility (High Contrast / Reduce Motion)',
    sectionZh: '外观与主题',
    sectionEn: 'Appearance & Themes',
    keywords: ['density', 'compact', 'contrast', 'motion', '密度', '紧凑', '高对比度', '动效'],
  },
  {
    id: 'shortcuts',
    path: '/settings/shortcuts',
    titleZh: '快捷键与临床确认安全边界',
    titleEn: 'Keyboard Shortcuts & Safety Guardrails',
    sectionZh: '快捷键',
    sectionEn: 'Keyboard Shortcuts',
    keywords: ['shortcut', 'hotkey', 'ctrl', 'cmd', 'command', '快捷键', '命令面板'],
  },
  {
    id: 'models',
    path: '/settings/models',
    titleZh: '模型连接、BYOK 与本机 CLI 发现',
    titleEn: 'Models, BYOK & Local CLI Discovery',
    sectionZh: '模型与服务商',
    sectionEn: 'Models & Providers',
    keywords: ['model', 'provider', 'api', 'key', 'byok', 'mock', 'cli', '模型', '密钥'],
  },
  {
    id: 'usage',
    path: '/settings/model-usage',
    titleZh: '当前 Workspace 模型 Token 用量',
    titleEn: 'Workspace Model Token Usage',
    sectionZh: '模型用量',
    sectionEn: 'Model Usage',
    keywords: ['usage', 'token', 'cost', '用量', '消耗'],
  },
  {
    id: 'components',
    path: '/settings/developer/components',
    titleZh: '开发者 UI 组件目录',
    titleEn: 'Developer UI Component Catalog',
    sectionZh: '开发者',
    sectionEn: 'Developer',
    keywords: ['component', 'catalog', 'ui', '组件', '目录'],
  },
]

export function SettingsScopeBadge({
  scope,
  locale,
}: {
  scope: SettingsScope
  locale: WorkspaceLocale
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  if (scope === 'device-secret') {
    return (
      <Badge variant="secondary">
        <KeyRoundIcon aria-hidden="true" className="size-3" />
        <span>{zh ? '本设备私密 (BYOK)' : 'Device secret (BYOK)'}</span>
      </Badge>
    )
  }
  if (scope === 'workspace') {
    return (
      <Badge variant="secondary">
        <Building2Icon aria-hidden="true" className="size-3" />
        <span>{zh ? '当前 Workspace' : 'Current Workspace'}</span>
      </Badge>
    )
  }
  return (
    <Badge variant="secondary">
      <LaptopIcon aria-hidden="true" className="size-3" />
      <span>{zh ? '仅作用于本设备' : 'This device only'}</span>
    </Badge>
  )
}

export function SettingsSection({
  title,
  description,
  action,
  ariaLabelledBy,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  ariaLabelledBy?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-labelledby={ariaLabelledBy} className="flex flex-col gap-2.5" data-cm="settings-section">
      <div className="flex items-end justify-between gap-4 px-0.5">
        <div className="min-w-0">
          {title}
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function SettingsCard({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="divide-y divide-border rounded-lg border bg-card text-card-foreground"
      data-cm="settings-card"
    >
      {children}
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  anchor,
  flashing = false,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  anchor?: string
  flashing?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={flashing
        ? 'flex flex-col gap-3 px-4 py-3.5 transition-colors duration-500 sm:flex-row sm:items-center sm:justify-between bg-accent/60'
        : 'flex flex-col gap-3 px-4 py-3.5 transition-colors duration-500 sm:flex-row sm:items-center sm:justify-between'}
      data-cm="settings-row"
      data-flash={flashing ? 'true' : undefined}
      data-settings-anchor={anchor}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {label}
        </div>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
