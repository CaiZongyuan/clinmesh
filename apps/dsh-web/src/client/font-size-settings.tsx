import { useId, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
    const [open, setOpen] = useState(false)
    const valueId = useId()
    const language = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
    const fontSize = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getSnapshot)
    const messages = getWorkspaceMessages(language)
    const label = language === 'zh-CN' ? 'ClinMesh 字号' : 'ClinMesh font size'
    const items = [
      { id: 'standard', label: messages.fontSizeStandard },
      { id: 'larger', label: messages.fontSizeLarger },
      { id: 'large', label: messages.fontSizeLarge },
    ]
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '16px 0', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
      }}>
        <style>{`.clinmesh-dsh-font-selector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;display:inline-flex;align-items:center;gap:12px;padding:0 14px}.clinmesh-dsh-font-selector:hover{background:var(--dsw-alias-interactive-bg-hover)}`}</style>
        <span>{label}</span>
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          items={items}
          selectedId={fontSize}
          onSelect={id => {
            const value = decodeFontSize(id)
            if (value !== undefined) preference.set(value)
            setOpen(false)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className="clinmesh-dsh-font-selector"
              aria-label={label}
              aria-describedby={valueId}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen(value => !value)}
            >
              <span id={valueId}>{items.find(item => item.id === fontSize)?.label}</span>
              <IconChevronDownOutline14 />
            </button>
          )}
        />
      </div>
    )
  }
  return ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'clinmesh.font-size', order: 10.5 },
    FontSizeSetting,
  ))
}
