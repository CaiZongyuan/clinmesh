import { Badge } from '@clinmesh/ui/components/badge'
import { Kbd } from '@clinmesh/ui/components/kbd'
import { ShieldAlertIcon } from 'lucide-react'
import { SettingsCard, SettingsRow, SettingsScopeBadge, SettingsSection } from './settings-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function ShortcutsSettingsPage({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'

  const rows: Array<{ label: string; desc?: string; keys: string[] }> = [
    {
      label: zh ? '打开全局命令面板' : 'Open Command Palette',
      desc: zh ? '快速切换顶层空间、主题（支持方向键实时预览）、深浅色模式与设置锚点。' : 'Jump across spaces, preview themes live, toggle color mode, or search settings.',
      keys: ['Ctrl', 'K'],
    },
    {
      label: zh ? '切换顶层空间（工作台 / 聊天 / Agent / 科研）' : 'Switch Top-Level Space',
      desc: zh ? '按 Alt + 1–4 分别直达临床工作台、全屏聊天、个人 Agent 与临床科研。' : 'Jump directly to Clinical Workbench, Chat, Personal Agent, or Research.',
      keys: ['Alt', '1–4'],
    },
    {
      label: zh ? '展开 / 折叠左侧主导航轨' : 'Toggle Left Navigation Rail',
      desc: zh ? '在 56px 紧凑图标轨与 198px 完整文字侧栏之间平滑切换。' : 'Switch between 56px slim icon rail and 198px expanded sidebar.',
      keys: ['Ctrl', 'B'],
    },
    {
      label: zh ? '打开设置中心' : 'Open Settings Center',
      keys: ['Ctrl', ','],
    },
    {
      label: zh ? '收起 / 展开右侧临床助手' : 'Toggle Clinician Assistant Sidebar',
      keys: ['Ctrl', '.'],
    },
    {
      label: zh ? '快速切换亮色 / 暗色模式' : 'Toggle Light / Dark Mode',
      keys: ['Ctrl', 'Shift', 'L'],
    },
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-10">
        <div className="flex flex-wrap items-center gap-2.5 border-b pb-4">
          <h2 className="text-base font-semibold text-foreground">
            {zh ? '安全导航与视图快捷键' : 'Safe Navigation & View Shortcuts'}
          </h2>
          <SettingsScopeBadge locale={locale} scope="device" />
        </div>

        <SettingsSection
          description={zh ? '基于 @ui-sdk/react/shortcuts；在输入框编辑或中文输入法组合态下自动防误触。' : 'Powered by @ui-sdk/react/shortcuts with input and IME guards.'}
          title={<h3 className="text-sm font-semibold">{zh ? '全局导航快捷键' : 'Global Navigation'}</h3>}
        >
          <SettingsCard>
            {rows.map(row => (
              <SettingsRow description={row.desc} key={row.label} label={row.label}>
                <div className="inline-flex items-center gap-1">
                  {row.keys.map(k => <Kbd key={k}>{k}</Kbd>)}
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title={<h3 className="text-sm font-semibold">{zh ? '医疗安全边界' : 'Clinical Safety Boundary'}</h3>}
        >
          <SettingsCard>
            <SettingsRow
              description={zh
                ? '签署病历、确认诊断、签发处方/检验、完诊、收费退款与手术执行等带 data-agent-confirm 的正式临床提交动作，系统类型级禁止绑定为单键无确认快捷键。'
                : 'Formal clinical commits carrying data-agent-confirm (signing records, diagnoses, prescriptions, billing) are strictly barred from single-key shortcut bindings.'}
              label={(
                <>
                  <ShieldAlertIcon aria-hidden="true" className="size-4 text-warning" />
                  <span>{zh ? '高风险临床提交免误触保护' : 'Clinical Commit Guardrail'}</span>
                  <Badge variant="outline">{zh ? '强制锁定' : 'Locked'}</Badge>
                </>
              )}
            >
              <Badge variant="secondary">{zh ? '仅允许显式人工确认' : 'Explicit confirmation only'}</Badge>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </div>
    </div>
  )
}
