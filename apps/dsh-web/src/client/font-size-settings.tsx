import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { readWebPreferences, type FontSizePreference } from '../../../web/src/app/preferences.ts'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'

const storageKey = 'clinmesh.dsh.font-size:v1'

function decodeFontSize(value: unknown): FontSizePreference | undefined {
  return value === 'standard' || value === 'larger' || value === 'large' ? value : undefined
}

/** DSH-origin preference, independent of conversation and standalone Web settings. */
export function createFontSizePreference() {
  let current: FontSizePreference = readWebPreferences().fontSize
  let storage: Storage | undefined
  try {
    storage = window.localStorage
    const saved = storage.getItem(storageKey)
    if (saved !== null) current = decodeFontSize(saved) ?? 'standard'
    else storage.setItem(storageKey, current)
  } catch {
    storage = undefined
    // A blocked store still permits adjustments for this plugin session.
  }
  const listeners = new Set<() => void>()
  const publish = (value: FontSizePreference) => {
    if (current === value) return
    current = value
    for (const listener of listeners) listener()
  }
  const refresh = () => {
    if (!storage) return
    try {
      publish(decodeFontSize(storage.getItem(storageKey)) ?? 'standard')
    } catch {
      storage = undefined
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (!storage || event.storageArea !== storage || (event.key !== null && event.key !== storageKey)) return
    refresh()
  }
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        window.addEventListener('storage', onStorage)
        refresh()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) window.removeEventListener('storage', onStorage)
      }
    },
    set(value: FontSizePreference) {
      try {
        storage?.setItem(storageKey, value)
      } catch {
        storage = undefined
      }
      publish(value)
    },
  }
}

export type FontSizePreferenceStore = ReturnType<typeof createFontSizePreference>

export function registerFontSizeSettings(ctx: Context, preference: FontSizePreferenceStore): () => void {
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  function FontSizeSetting() {
    const language = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const fontSize = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getSnapshot)
    const messages = getWorkspaceMessages(language)
    const label = language === 'zh-CN' ? 'ClinMesh 字号' : 'ClinMesh font size'
    return (
      <label style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
        minHeight: 60, fontSize: 14, color: 'var(--dsw-alias-label-primary)',
        borderBottom: '1px solid var(--dsw-alias-border-standard)',
      }}>
        <span>{label}</span>
        <select
          aria-label={label}
          value={fontSize}
          onChange={event => {
            const value = decodeFontSize(event.target.value)
            if (value !== undefined) preference.set(value)
          }}
          style={{
            font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-base)',
            border: '1px solid var(--dsw-alias-border-standard)', borderRadius: 8, padding: '6px 10px',
          }}
        >
          <option value="standard">{messages.fontSizeStandard}</option>
          <option value="larger">{messages.fontSizeLarger}</option>
          <option value="large">{messages.fontSizeLarge}</option>
        </select>
      </label>
    )
  }
  return ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'clinmesh.font-size', order: 80 },
    FontSizeSetting,
  ))
}
