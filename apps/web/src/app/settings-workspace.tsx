import type { SessionContext } from '@clinmesh/contracts/his'
import { AppearanceSettingsPage } from './appearance-settings-page.tsx'
import { ComponentCatalog } from './component-catalog.tsx'
import { ModelUsageWorkspace } from './model-usage-workspace.tsx'
import { ModelsSettingsPage } from './models-settings-page.tsx'
import type { FontSizePreference } from './preferences.ts'
import { ShortcutsSettingsPage } from './shortcuts-settings-page.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { SettingsSection, WorkspaceTheme } from './workspace-shell.tsx'

interface SettingsWorkspaceProps {
  activeSection: SettingsSection
  session: SessionContext
  fontSize: FontSizePreference
  locale: WorkspaceLocale
  highlightAnchor?: string | null
  onFontSizeChange: (fontSize: FontSizePreference) => void
  onLocaleChange: (locale: WorkspaceLocale) => void
  onThemeChange: (theme: WorkspaceTheme) => void
  theme: WorkspaceTheme
}

export function SettingsWorkspace({
  activeSection,
  session,
  locale,
  highlightAnchor,
  onLocaleChange,
}: SettingsWorkspaceProps): React.JSX.Element {
  if (activeSection === 'settingsShortcuts') {
    return <ShortcutsSettingsPage locale={locale} />
  }

  if (activeSection === 'modelsProvider') {
    return <ModelsSettingsPage locale={locale} />
  }

  if (activeSection === 'modelUsage') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ModelUsageWorkspace
          key={`${session.actor.workspaceId}:${session.actor.epoch}:${session.actor.practitionerRoleId}`}
          locale={locale}
          session={session}
        />
      </div>
    )
  }

  if (activeSection === 'uiComponents') {
    return <ComponentCatalog embedded locale={locale} />
  }

  return (
    <AppearanceSettingsPage
      highlightAnchor={highlightAnchor ?? null}
      locale={locale}
      onLocaleChange={onLocaleChange}
    />
  )
}
