import { ComponentCatalog } from './component-catalog.tsx'
import {
  AppearanceControls,
  type SettingsSection,
  type WorkspaceTheme,
} from './workspace-shell.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

interface SettingsWorkspaceProps {
  activeSection: SettingsSection
  locale: WorkspaceLocale
  onLocaleChange: (locale: WorkspaceLocale) => void
  onThemeChange: (theme: WorkspaceTheme) => void
  theme: WorkspaceTheme
}

export function SettingsWorkspace({
  activeSection,
  locale,
  onLocaleChange,
  onThemeChange,
  theme,
}: SettingsWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)

  if (activeSection === 'uiComponents') {
    return <ComponentCatalog embedded locale={locale} />
  }

  return (
    <section aria-labelledby="settings-appearance-heading" className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-sm font-semibold" id="settings-appearance-heading">
        {messages.appearanceLabel}
      </h2>
      <AppearanceControls
        locale={locale}
        messages={messages}
        onLocaleChange={onLocaleChange}
        onThemeChange={onThemeChange}
        showLabel={false}
        theme={theme}
      />
    </section>
  )
}
