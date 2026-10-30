import { ComponentCatalog } from './component-catalog.tsx'
import { ModelUsageWorkspace } from './model-usage-workspace.tsx'
import { WorkspaceCard, WorkspaceCardLayout } from './workspace-card-layout.tsx'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Field, FieldTitle } from '@clinmesh/ui/components/field'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  AppearanceControls,
  type SettingsSection,
  type WorkspaceTheme,
} from './workspace-shell.tsx'
import type { FontSizePreference } from './preferences.ts'
import {
  getWorkspaceMessages,
  type WorkspaceLocale,
  type WorkspaceMessageKey,
} from './workspace-i18n.ts'

const fontSizeOptions = [
  { value: 'standard', label: 'fontSizeStandard' },
  { value: 'larger', label: 'fontSizeLarger' },
  { value: 'large', label: 'fontSizeLarge' },
] satisfies Array<{
  value: FontSizePreference
  label: WorkspaceMessageKey
}>

function FontSizeControl({
  fontSize,
  messages,
  onFontSizeChange,
}: {
  fontSize: FontSizePreference
  messages: ReturnType<typeof getWorkspaceMessages>
  onFontSizeChange: (fontSize: FontSizePreference) => void
}): React.JSX.Element {
  return (
    <Field orientation="responsive">
      <FieldTitle id="settings-font-size-label">{messages.fontSizeLabel}</FieldTitle>
      <ToggleGroup
        aria-labelledby="settings-font-size-label"
        onValueChange={values => {
          const value = (values as FontSizePreference[])[0]
          if (value !== undefined) onFontSizeChange(value)
        }}
        size="sm"
        spacing={0}
        value={[fontSize]}
        variant="outline"
      >
        {fontSizeOptions.map(option => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {messages[option.label]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  )
}

interface SettingsWorkspaceProps {
  activeSection: SettingsSection
  session: SessionContext
  fontSize: FontSizePreference
  locale: WorkspaceLocale
  onFontSizeChange: (fontSize: FontSizePreference) => void
  onLocaleChange: (locale: WorkspaceLocale) => void
  onThemeChange: (theme: WorkspaceTheme) => void
  theme: WorkspaceTheme
}

export function SettingsWorkspace({
  activeSection,
  session,
  fontSize,
  locale,
  onFontSizeChange,
  onLocaleChange,
  onThemeChange,
  theme,
}: SettingsWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)

  if (activeSection === 'modelUsage') {
    return <ModelUsageWorkspace key={`${session.actor.workspaceId}:${session.actor.epoch}:${session.actor.practitionerRoleId}`}
      locale={locale} session={session} />
  }

  if (activeSection === 'uiComponents') {
    return <ComponentCatalog embedded locale={locale} />
  }

  return (
    <WorkspaceCardLayout id="settings-appearance" locale={locale}><section
      aria-labelledby="settings-appearance-heading"
      className="max-w-2xl"
    >
      <WorkspaceCard title={<h2 id="settings-appearance-heading">
        {messages.appearanceLabel}
      </h2>}><div className="flex flex-col gap-4">
      <AppearanceControls
        locale={locale}
        messages={messages}
        onLocaleChange={onLocaleChange}
        onThemeChange={onThemeChange}
        showLabel={false}
        theme={theme}
      />
      <FontSizeControl
        fontSize={fontSize}
        messages={messages}
        onFontSizeChange={onFontSizeChange}
      />
      </div></WorkspaceCard>
    </section></WorkspaceCardLayout>
  )
}
