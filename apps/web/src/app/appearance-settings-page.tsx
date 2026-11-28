import {
  auditBuiltInTheme,
  exportThemeArchive,
  findBuiltInTheme,
  FONT_SIZES,
  fontSizePxToLegacy,
  inspectThemeZipBytes,
  isBuiltInThemeId,
  resolveLocalizedText,
  type AppRailMode,
  type CjkFont,
  type ColorMode,
  type ContentLeading,
  type Density,
  type FontSize,
  type ThemeCheckReport,
  type ThemeOption,
  type UiFont,
} from '@clinmesh/ui/appearance'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clinmesh/ui/components/dialog'
import { HoldButton } from '@clinmesh/ui/components/hold-button'
import { Popover, PopoverContent, PopoverTrigger } from '@clinmesh/ui/components/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@clinmesh/ui/components/select'
import { Slider } from '@clinmesh/ui/components/slider'
import { Switch } from '@clinmesh/ui/components/switch'
import { ThemePreviewSvg, ThemeSwatch } from '@clinmesh/ui/components/theme-swatch'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  MonitorIcon,
  MoonIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppearance } from './appearance-context.tsx'
import type { FontSizePreference } from './preferences.ts'
import {
  SettingsCard,
  SettingsRow,
  SettingsScopeBadge,
  SettingsSection,
} from './settings-layout.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

export function AppearanceSettingsPage({
  locale,
  onLocaleChange,
  highlightAnchor,
}: {
  locale: WorkspaceLocale
  onLocaleChange: (locale: WorkspaceLocale) => void
  highlightAnchor?: string | null
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const {
    appearance,
    resolvedColorMode,
    allThemes,
    activeTheme,
    previewThemeId,
    safeMode,
    setColorMode,
    setTheme,
    setThemeOption,
    resetThemeOptions,
    setFontSize,
    setLegacyFontSize,
    setUiFont,
    setUiCjkFont,
    setContentLeading,
    setDensity,
    setRailMode,
    setReduceMotion,
    setHighContrast,
    resetAllAppearance,
    startThemePreview,
    stopThemePreview,
    exitSafeMode,
    installTheme,
    uninstallTheme,
  } = useAppearance()

  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [importReport, setImportReport] = useState<ThemeCheckReport | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [flashingAnchor, setFlashingAnchor] = useState<string | null>(null)

  useEffect(() => {
    if (!highlightAnchor) return
    setFlashingAnchor(highlightAnchor)
    const target = document.querySelector(`[data-settings-anchor="${highlightAnchor}"]`)
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: appearance.reduceMotion ? 'auto' : 'smooth', block: 'center' })
    }
    const timer = window.setTimeout(() => setFlashingAnchor(null), 1600)
    return () => window.clearTimeout(timer)
  }, [appearance.reduceMotion, highlightAnchor])

  const legacyFontSize: FontSizePreference = fontSizePxToLegacy(appearance.fontSize)

  const contrastSummary = useMemo(() => {
    const builtIn = findBuiltInTheme(activeTheme.id)
    if (!builtIn) return null
    const report = auditBuiltInTheme(builtIn)
    const modeChecks = report.contrast.filter(c => c.mode === resolvedColorMode)
    const minRatio = modeChecks.reduce((acc, item) => Math.min(acc, item.ratio), 21)
    return { ok: report.ok, minRatio: Number.isFinite(minRatio) ? minRatio : null }
  }, [activeTheme.id, resolvedColorMode])

  const handleExportTemplate = () => {
    const copyId = `${activeTheme.id}-custom`
    const bytes = exportThemeArchive(activeTheme, {
      id: copyId,
      name: `${activeTheme.name} (Copy)`,
    })
    const copyBytes = new Uint8Array(bytes.byteLength)
    copyBytes.set(bytes)
    const blob = new Blob([copyBytes.buffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${copyId}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
    setFeedback(zh ? `已导出主题模板 ${copyId}.zip` : `Exported theme template ${copyId}.zip`)
  }

  const handleChooseZip = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setImportBusy(true)
      try {
        const buffer = await file.arrayBuffer()
        const report = await inspectThemeZipBytes(new Uint8Array(buffer))
        setImportReport(report)
      } finally {
        setImportBusy(false)
      }
    }
    input.click()
  }

  const handleConfirmInstall = async () => {
    if (!importReport?.ok || !importReport.theme) return
    await installTheme(importReport.theme)
    setFeedback(zh ? `已安装并启用主题「${importReport.theme.name}」` : `Installed and applied "${importReport.theme.name}"`)
    setImportReport(null)
  }

  const previewThemeObj = previewThemeId ? allThemes.find(t => t.id === previewThemeId) : null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 pb-10">
        {/* Page Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-base font-semibold text-foreground" id="settings-appearance-heading">
              {messages.appearanceLabel}
            </h2>
            <SettingsScopeBadge locale={locale} scope="device" />
            {contrastSummary?.ok ? (
              <Badge variant="outline">
                <ShieldCheckIcon aria-hidden="true" className="size-3 text-success" />
                <span>WCAG AA · ≥ {contrastSummary.minRatio}:1</span>
              </Badge>
            ) : null}
          </div>
          <HoldButton
            durationMs={650}
            holdingLabel={zh ? '继续按住…' : 'Keep holding…'}
            icon={<RotateCcwIcon aria-hidden="true" className="size-3.5" />}
            label={zh ? '长按恢复默认' : 'Hold to reset'}
            onConfirmed={() => {
              resetAllAppearance()
              setFeedback(zh ? '已恢复全部外观为 ClinMesh 默认配置' : 'Reset all appearance settings to ClinMesh defaults')
            }}
            size="sm"
            title={zh ? '长按 0.65 秒恢复全部外观设置（防误触）' : 'Press and hold 0.65s to reset appearance'}
            variant="outline"
          />
        </div>

        {safeMode ? (
          <Alert>
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{zh ? '主题安全模式（Theme Safe Mode）已启用' : 'Theme Safe Mode active'}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {zh
                  ? '当前标签页临时回退至临床默认主题，你的已安装主题和选项均未被删除。'
                  : 'Temporarily using Clinical Default for this tab; installed themes and preferences remain intact.'}
              </span>
              <Button onClick={exitSafeMode} size="xs" type="button" variant="outline">
                {zh ? '退出安全模式' : 'Exit Safe Mode'}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {feedback ? (
          <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-xs text-foreground" role="status">
            <span>{feedback}</span>
            <Button onClick={() => setFeedback(null)} size="xs" type="button" variant="ghost">
              {zh ? '关闭' : 'Dismiss'}
            </Button>
          </div>
        ) : null}

        {/* Section 1: Color Mode, Language & Theme (preserves region name "外观" for existing E2E!) */}
        <SettingsSection
          ariaLabelledBy="settings-appearance-heading"
          description={zh ? '色彩模式与主题皮肤彼此正交；悬停主题下拉项可全页实时试穿。' : 'Color mode and theme are orthogonal; hover theme options for live preview.'}
          title={<h3 className="text-sm font-semibold">{zh ? '色彩、语言与主题' : 'Color, Language & Theme'}</h3>}
        >
          <SettingsCard>
            <SettingsRow
              anchor="color-mode"
              description={zh ? '独立切换亮色、暗色或跟随操作系统。' : 'Switch between light, dark, or system color mode.'}
              flashing={flashingAnchor === 'color-mode'}
              label={zh ? '色彩模式' : 'Color Mode'}
            >
              <ToggleGroup
                aria-label={messages.themeLabel}
                onValueChange={values => {
                  const next = (values as ColorMode[])[0]
                  if (next !== undefined) setColorMode(next)
                }}
                size="sm"
                spacing={0}
                value={[appearance.colorMode]}
                variant="outline"
              >
                <ToggleGroupItem aria-label={messages.themeLight} value="light">
                  <SunIcon aria-hidden="true" className="size-3.5" />
                  <span>{messages.themeLight}</span>
                </ToggleGroupItem>
                <ToggleGroupItem aria-label={messages.themeDark} value="dark">
                  <MoonIcon aria-hidden="true" className="size-3.5" />
                  <span>{messages.themeDark}</span>
                </ToggleGroupItem>
                <ToggleGroupItem aria-label={messages.themeSystem} value="system">
                  <MonitorIcon aria-hidden="true" className="size-3.5" />
                  <span>{messages.themeSystem}</span>
                </ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>

            <SettingsRow
              anchor="language"
              description={zh ? '切换界面显示语言（中文 / English）。' : 'Switch workspace display language.'}
              flashing={flashingAnchor === 'language'}
              label={messages.languageLabel}
            >
              <ToggleGroup
                aria-label={messages.languageLabel}
                onValueChange={values => {
                  const next = (values as WorkspaceLocale[])[0]
                  if (next !== undefined) onLocaleChange(next)
                }}
                size="sm"
                spacing={0}
                value={[locale]}
                variant="outline"
              >
                <ToggleGroupItem value="zh-CN">{messages.chinese}</ToggleGroupItem>
                <ToggleGroupItem value="en-US">{messages.english}</ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>

            <SettingsRow
              anchor="theme"
              description={zh
                ? '默认严格保持原版 ClinMesh 样式不变；其余 5 套为原创临床主题，悬停实时预览。'
                : 'Default preserves original ClinMesh styling; 5 additional clean-room clinical presets included.'}
              flashing={flashingAnchor === 'theme'}
              label={(
                <>
                  <span>{zh ? '界面主题' : 'Interface Theme'}</span>
                  <Badge variant="secondary">{zh ? '悬停实时预览' : 'Live preview'}</Badge>
                </>
              )}
            >
              <Popover
                onOpenChange={open => {
                  setThemePickerOpen(open)
                  if (!open) stopThemePreview()
                }}
                open={themePickerOpen}
              >
                <PopoverTrigger
                  render={(
                    <Button
                      aria-label={zh ? '选择界面主题' : 'Select interface theme'}
                      className="min-w-48 justify-between"
                      size="sm"
                      type="button"
                      variant="outline"
                    />
                  )}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ThemeSwatch mode={resolvedColorMode} theme={activeTheme} />
                    <span className="truncate">{zh ? activeTheme.name : (activeTheme.enName ?? activeTheme.name)}</span>
                  </span>
                  <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-72 p-1.5"
                  onMouseLeave={stopThemePreview}
                >
                  <div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    <span>{zh ? '原创内置与本地主题' : 'Built-in & Installed Themes'}</span>
                    <span>{zh ? '悬停试穿' : 'Hover to preview'}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {allThemes.map(theme => {
                      const active = theme.id === activeTheme.id
                      return (
                        <Button
                          className="h-8 w-full justify-start gap-2 px-2 font-normal"
                          key={theme.id}
                          onClick={() => {
                            setTheme(theme.id)
                            setThemePickerOpen(false)
                            setFeedback(zh ? `已切换主题：${theme.name}` : `Switched theme: ${theme.enName ?? theme.name}`)
                          }}
                          onFocus={() => startThemePreview(theme.id)}
                          onMouseEnter={() => startThemePreview(theme.id)}
                          size="sm"
                          type="button"
                          variant={active ? 'secondary' : 'ghost'}
                        >
                          <ThemeSwatch mode={resolvedColorMode} theme={theme} />
                          <span className="truncate">{zh ? theme.name : (theme.enName ?? theme.name)}</span>
                          <span className="ml-auto text-[11px] text-muted-foreground">
                            {theme.id === 'default' ? (zh ? '原版' : 'Default') : (theme.author ?? 'Local')}
                          </span>
                          {active ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                        </Button>
                      )
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              <Button onClick={() => setManageOpen(true)} size="sm" type="button" variant="outline">
                {zh ? '主题库' : 'Manage'}
              </Button>
            </SettingsRow>

            <SettingsRow
              anchor="custom-theme"
              description={zh
                ? '零 JS 本地主题包（.zip）：导入前自动净化外部请求、锁定采血管色标并校验 WCAG AA；异常时访问 ?theme=default 进入安全模式。'
                : 'Zero-JS local .zip themes with CSS sanitization, clinical guardrails, and WCAG AA validation. Use ?theme=default for Safe Mode.'}
              flashing={flashingAnchor === 'custom-theme'}
              label={(
                <>
                  <span>{zh ? '自定义主题包' : 'Custom Theme Package'}</span>
                  <Badge variant="outline">{zh ? '零 JS · 本地' : 'Zero-JS · Local'}</Badge>
                </>
              )}
            >
              <Button
                onClick={handleExportTemplate}
                size="sm"
                title={zh ? '复制当前主题为可编辑模板 .zip' : 'Export current theme as editable .zip template'}
                type="button"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
                <span>{zh ? '导出模板' : 'Export .zip'}</span>
              </Button>
              <Button disabled={importBusy} onClick={handleChooseZip} size="sm" type="button" variant="outline">
                <UploadIcon aria-hidden="true" className="size-3.5" />
                <span>{importBusy ? (zh ? '校验中…' : 'Checking…') : (zh ? '导入 .zip' : 'Import .zip')}</span>
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        {/* Section 2: Dynamic Theme Options */}
        {activeTheme.options && activeTheme.options.length > 0 ? (
          <SettingsSection
            action={(
              <Button
                onClick={() => resetThemeOptions(activeTheme.id)}
                size="xs"
                type="button"
                variant="ghost"
              >
                {zh ? '重置本主题选项' : 'Reset options'}
              </Button>
            )}
            description={zh
              ? `由「${activeTheme.name}」清单声明的局部可调项，各主题独立记忆。`
              : `Options declared by "${activeTheme.enName ?? activeTheme.name}", saved per theme.`}
            title={<h3 className="text-sm font-semibold">{zh ? '主题选项' : 'Theme Options'}</h3>}
          >
            <SettingsCard>
              {activeTheme.options.map(option => (
                <ThemeOptionRow
                  key={option.id}
                  locale={locale}
                  onChange={val => setThemeOption(activeTheme.id, option.id, val)}
                  option={option}
                  value={appearance.themeOptions[activeTheme.id]?.[option.id]}
                />
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}

        {/* Section 3: Navigation Rail & Layout */}
        <SettingsSection
          description={zh ? '控制左侧顶层应用导航轨宽度与临床表格信息密度。' : 'Control Left Primary Navigation Rail form factor and clinical density.'}
          title={<h3 className="text-sm font-semibold">{zh ? '布局与导航轨' : 'Layout & Navigation Rail'}</h3>}
        >
          <SettingsCard>
            <SettingsRow
              anchor="rail-mode"
              description={zh ? '默认 56px 极窄图标轨最省临床三栏宽度；也可展开显示完整名称或专注隐藏（Ctrl+B）。' : '56px slim icon rail maximizes clinical viewport width; expand or hide anytime (Ctrl+B).'}
              flashing={flashingAnchor === 'rail-mode'}
              label={zh ? '左侧应用导航轨形态' : 'Primary Navigation Rail'}
            >
              <ToggleGroup
                aria-label={zh ? '左侧应用导航轨形态' : 'Primary Navigation Rail'}
                onValueChange={values => {
                  const next = (values as AppRailMode[])[0]
                  if (next !== undefined) setRailMode(next)
                }}
                size="sm"
                spacing={0}
                value={[appearance.railMode]}
                variant="outline"
              >
                <ToggleGroupItem value="rail">{zh ? '图标轨 56px' : 'Rail 56px'}</ToggleGroupItem>
                <ToggleGroupItem value="expanded">{zh ? '展开 198px' : 'Expanded'}</ToggleGroupItem>
                <ToggleGroupItem value="hidden">{zh ? '专注隐藏' : 'Hidden'}</ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>

            <SettingsRow
              anchor="density"
              description={zh ? '调整检验表格、列表行距与面板留白。' : 'Adjust table row padding and workspace spacing.'}
              flashing={flashingAnchor === 'density'}
              label={zh ? '信息密度' : 'Information Density'}
            >
              <ToggleGroup
                aria-label={zh ? '信息密度' : 'Information Density'}
                onValueChange={values => {
                  const next = (values as Density[])[0]
                  if (next !== undefined) setDensity(next)
                }}
                size="sm"
                spacing={0}
                value={[appearance.density]}
                variant="outline"
              >
                <ToggleGroupItem value="compact">{zh ? '紧凑' : 'Compact'}</ToggleGroupItem>
                <ToggleGroupItem value="default">{zh ? '默认' : 'Default'}</ToggleGroupItem>
                <ToggleGroupItem value="comfortable">{zh ? '舒适' : 'Comfortable'}</ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        {/* Section 4: Typography & Accessibility */}
        <SettingsSection
          description={zh ? '字号仅缩放语义字体 Token，不破坏控件高度与布局几何。' : 'Scales semantic typography tokens without breaking control heights.'}
          title={<h3 className="text-sm font-semibold">{zh ? '排版与无障碍' : 'Typography & Accessibility'}</h3>}
        >
          <SettingsCard>
            <SettingsRow
              anchor="font-size"
              description={zh ? '支持三档快捷切换（标准 / 较大 / 大）或 12–18px 连续微调。' : 'Use 3 quick presets or fine-tune between 12 and 18px.'}
              flashing={flashingAnchor === 'font-size'}
              label={messages.fontSizeLabel}
            >
              <div className="flex flex-wrap items-center gap-3">
                <ToggleGroup
                  aria-label={messages.fontSizeLabel}
                  onValueChange={values => {
                    const next = (values as FontSizePreference[])[0]
                    if (next !== undefined) setLegacyFontSize(next)
                  }}
                  size="sm"
                  spacing={0}
                  value={[legacyFontSize]}
                  variant="outline"
                >
                  <ToggleGroupItem value="standard">{messages.fontSizeStandard}</ToggleGroupItem>
                  <ToggleGroupItem value="larger">{messages.fontSizeLarger}</ToggleGroupItem>
                  <ToggleGroupItem value="large">{messages.fontSizeLarge}</ToggleGroupItem>
                </ToggleGroup>
                <div className="flex w-36 items-center gap-2">
                  <Slider
                    max={FONT_SIZES[FONT_SIZES.length - 1]}
                    min={FONT_SIZES[0]}
                    onValueChange={val => {
                      const num = Array.isArray(val) ? val[0] : val
                      if (typeof num === 'number' && (FONT_SIZES as readonly number[]).includes(num)) {
                        setFontSize(num as FontSize)
                      }
                    }}
                    step={1}
                    thumbLabel={zh ? '精细字号滑块' : 'Fine font size slider'}
                    value={appearance.fontSize}
                  />
                  <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {appearance.fontSize}px
                  </span>
                </div>
              </div>
            </SettingsRow>

            <SettingsRow
              anchor="ui-font"
              label={zh ? '拉丁与中文字体' : 'Latin & CJK Fonts'}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  onValueChange={val => { if (val) setUiFont(val as UiFont) }}
                  value={appearance.uiFont}
                >
                  <SelectTrigger aria-label={zh ? '拉丁字体' : 'Latin font'} className="w-36" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">{zh ? '系统默认' : 'System'}</SelectItem>
                    <SelectItem value="inter">Inter</SelectItem>
                    <SelectItem value="serif">Source Serif</SelectItem>
                    <SelectItem value="mono">{zh ? '等宽字体' : 'Monospace'}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={val => { if (val) setUiCjkFont(val as CjkFont) }}
                  value={appearance.uiCjkFont}
                >
                  <SelectTrigger aria-label={zh ? '中文字体' : 'CJK font'} className="w-36" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sans">{zh ? '无衬线黑体' : 'CJK Sans'}</SelectItem>
                    <SelectItem value="serif">{zh ? '衬线宋体' : 'CJK Serif'}</SelectItem>
                    <SelectItem value="kai">{zh ? '楷体' : 'CJK Kai'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </SettingsRow>

            <SettingsRow
              anchor="content-leading"
              description={zh ? '作用于病历正文、问诊对话与临床助手长文本。' : 'Applies to clinical prose, consultation history, and assistant markdown.'}
              label={zh ? '临床阅读行距' : 'Clinical Reading Line Height'}
            >
              <ToggleGroup
                aria-label={zh ? '临床阅读行距' : 'Clinical Reading Line Height'}
                onValueChange={values => {
                  const next = (values as ContentLeading[])[0]
                  if (next !== undefined) setContentLeading(next)
                }}
                size="sm"
                spacing={0}
                value={[appearance.contentLeading]}
                variant="outline"
              >
                <ToggleGroupItem value="compact">{zh ? '紧凑' : 'Compact'}</ToggleGroupItem>
                <ToggleGroupItem value="default">{zh ? '常规' : 'Regular'}</ToggleGroupItem>
                <ToggleGroupItem value="relaxed">{zh ? '宽松' : 'Relaxed'}</ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>

            <SettingsRow
              anchor="high-contrast"
              description={zh ? '在任意主题之上增强辅助文字与控件边框反差。' : 'Boosts text and border contrast above any active theme.'}
              label={zh ? '高对比度' : 'High Contrast'}
            >
              <Switch
                aria-label={zh ? '高对比度' : 'High Contrast'}
                checked={appearance.highContrast}
                onCheckedChange={setHighContrast}
              />
            </SettingsRow>

            <SettingsRow
              anchor="reduce-motion"
              description={zh ? '关闭界面过渡动画与位移动效。' : 'Disables interface transition and motion animations.'}
              label={zh ? '减弱动效' : 'Reduce Motion'}
            >
              <Switch
                aria-label={zh ? '减弱动效' : 'Reduce Motion'}
                checked={appearance.reduceMotion}
                onCheckedChange={setReduceMotion}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </div>

      {/* Live Preview Floating Pill */}
      {previewThemeObj ? (
        <div
          className="pointer-events-none fixed bottom-5 left-1/2 z-50 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background shadow-lg"
          role="status"
        >
          <EyeIcon aria-hidden="true" className="size-3.5" />
          <span>
            {zh
              ? `实时试穿预览：${previewThemeObj.name}（点击应用，移开还原）`
              : `Live preview: ${previewThemeObj.enName ?? previewThemeObj.name}`}
          </span>
        </div>
      ) : null}

      {/* Manage Themes Modal (3x2 SVG Gallery with Live Hover Preview) */}
      <Dialog
        onOpenChange={open => {
          setManageOpen(open)
          if (!open) stopThemePreview()
        }}
        open={manageOpen}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{zh ? '主题库与本地管理' : 'Theme Library & Local Themes'}</DialogTitle>
            <DialogDescription>
              {zh
                ? '全部内置主题均为面向临床场景独立调色的原创方案（author: ClinMesh，零第三方商标）；悬停卡片可全页实时试穿。'
                : 'All built-in themes are original clinical palettes (author: ClinMesh). Hover any card for live preview.'}
            </DialogDescription>
          </DialogHeader>
          <div
            className="grid max-h-[62vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 md:grid-cols-3"
            onMouseLeave={stopThemePreview}
          >
            {allThemes.map(theme => {
              const active = theme.id === activeTheme.id
              const custom = !isBuiltInThemeId(theme.id)
              return (
                <article
                  className="flex flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-info"
                  key={theme.id}
                  onMouseEnter={() => startThemePreview(theme.id)}
                >
                  <ThemePreviewSvg mode={resolvedColorMode} theme={theme} />
                  <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <strong className="truncate text-xs font-semibold">
                        {zh ? theme.name : (theme.enName ?? theme.name)}
                      </strong>
                      {active ? (
                        <Badge variant="secondary">{zh ? '使用中' : 'Active'}</Badge>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {theme.author ?? 'Local'}
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {resolveLocalizedText(theme.description, locale)}
                    </p>
                    <div className="mt-auto flex items-center justify-end gap-1.5 pt-2">
                      {custom ? (
                        <Button
                          aria-label={zh ? `卸载主题 ${theme.name}` : `Uninstall ${theme.name}`}
                          onClick={() => void uninstallTheme(theme.id)}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" className="size-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        onClick={() => {
                          setTheme(theme.id)
                          setFeedback(zh ? `已应用主题：${theme.name}` : `Applied theme: ${theme.enName ?? theme.name}`)
                        }}
                        size="xs"
                        type="button"
                        variant={active ? 'outline' : 'default'}
                      >
                        {active ? (zh ? '当前使用' : 'Active') : (zh ? '应用主题' : 'Apply')}
                      </Button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Import Theme Confirmation / Validation Report Dialog */}
      <Dialog onOpenChange={open => { if (!open) setImportReport(null) }} open={importReport !== null}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {importReport?.ok && importReport.theme
                ? (zh ? `安装自定义主题「${importReport.theme.name}」` : `Install "${importReport.theme.name}"`)
                : (zh ? '主题包校验未通过' : 'Theme Validation Failed')}
            </DialogTitle>
            <DialogDescription>
              {zh
                ? '自定义主题仅保存于本机浏览器 IndexedDB，无法执行脚本或覆盖临床安全护栏。'
                : 'Custom themes are stored locally in IndexedDB and cannot run scripts or override clinical guardrails.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-xs">
            {importReport?.ok && importReport.theme ? (
              <div className="rounded-md border bg-muted/50 p-3">
                <div className="font-medium text-foreground">
                  {importReport.theme.name} ({importReport.theme.id})
                </div>
                <div className="mt-1 text-muted-foreground">
                  {zh ? '作者' : 'Author'}: {importReport.theme.author ?? 'Local'} · v{importReport.theme.version ?? '1.0.0'}
                </div>
                <div className="mt-2 font-medium text-success">
                  {zh ? '✓ CSS 净化通过 · ✓ 采血管与确认门禁未越权 · ✓ WCAG AA 对比度达标' : '✓ CSS sanitized · ✓ Clinical guardrails intact · ✓ WCAG AA passed'}
                </div>
              </div>
            ) : (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>{zh ? '发现以下安全或可读性问题' : 'Validation errors'}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {(importReport?.issues ?? []).map((issue, idx) => (
                      <li key={idx}>{issue.message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setImportReport(null)} size="sm" type="button" variant="outline">
              {zh ? '关闭' : 'Close'}
            </Button>
            {importReport?.ok ? (
              <Button onClick={() => void handleConfirmInstall()} size="sm" type="button">
                {zh ? '安装并启用' : 'Install & Apply'}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ThemeOptionRow({
  option,
  value,
  locale,
  onChange,
}: {
  option: ThemeOption
  value: unknown
  locale: WorkspaceLocale
  onChange: (next: string | boolean) => void
}): React.JSX.Element | null {
  const label = resolveLocalizedText(option.label, locale)
  const desc = resolveLocalizedText(option.description, locale)

  if (option.type === 'toggle') {
    const checked = typeof value === 'boolean' ? value : option.default
    return (
      <SettingsRow description={desc || undefined} label={label}>
        <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
      </SettingsRow>
    )
  }

  if (option.type === 'select') {
    const selected = typeof value === 'string' ? value : option.default
    const allSwatches = option.choices.every(c => typeof c.swatch === 'string')
    return (
      <SettingsRow description={desc || undefined} label={label}>
        {allSwatches ? (
          <div className="flex items-center gap-2" role="radiogroup" aria-label={label}>
            {option.choices.map(choice => {
              const choiceLabel = resolveLocalizedText(choice.label, locale)
              const active = selected === choice.value
              return (
                <Button
                  aria-checked={active}
                  aria-label={choiceLabel}
                  className={active ? 'size-6 rounded-full p-0 ring-2 ring-foreground ring-offset-2' : 'size-6 rounded-full p-0'}
                  key={choice.value}
                  onClick={() => onChange(choice.value)}
                  role="radio"
                  size="icon-xs"
                  style={{ backgroundColor: choice.swatch }}
                  title={choiceLabel}
                  type="button"
                  variant="outline"
                />
              )
            })}
          </div>
        ) : (
          <ToggleGroup
            aria-label={label}
            onValueChange={values => {
              const next = values[0]
              if (next !== undefined) onChange(next)
            }}
            size="sm"
            spacing={0}
            value={[selected]}
            variant="outline"
          >
            {option.choices.map(choice => (
              <ToggleGroupItem key={choice.value} value={choice.value}>
                {resolveLocalizedText(choice.label, locale)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </SettingsRow>
    )
  }

  return null
}
