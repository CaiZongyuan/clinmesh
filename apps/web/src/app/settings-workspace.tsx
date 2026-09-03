import { ComponentCatalog } from './component-catalog.tsx'
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
  fontSize: FontSizePreference
  locale: WorkspaceLocale
  onFontSizeChange: (fontSize: FontSizePreference) => void
  onLocaleChange: (locale: WorkspaceLocale) => void
  onThemeChange: (theme: WorkspaceTheme) => void
  theme: WorkspaceTheme
}

export function SettingsWorkspace({
  activeSection,
  fontSize,
  locale,
  onFontSizeChange,
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
      <FontSizeControl
        fontSize={fontSize}
        messages={messages}
        onFontSizeChange={onFontSizeChange}
      />
    </section>
  )
}
