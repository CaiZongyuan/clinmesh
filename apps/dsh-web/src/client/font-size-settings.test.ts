// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createFontSizePreference } from './font-size-settings.tsx'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

it('inherits the old font size once, preserves unrelated preferences and restores the DSH choice', () => {
  const original = JSON.stringify({ fontSize: 'larger', locale: 'en-US', theme: 'dark' })
  localStorage.setItem('clinmesh.preferences:v1', original)
  const preference = createFontSizePreference()
  expect(preference.getSnapshot()).toBe('larger')
  preference.set('large')
  expect(createFontSizePreference().getSnapshot()).toBe('large')
  expect(localStorage.getItem('clinmesh.preferences:v1')).toBe(original)
})

it('validates persisted values and synchronizes other tabs only while subscribed', () => {
  localStorage.setItem('clinmesh.dsh.font-size:v1', 'invalid')
  const preference = createFontSizePreference()
  expect(preference.getSnapshot()).toBe('standard')
  const changed = vi.fn()
  const unsubscribe = preference.subscribe(changed)
  localStorage.setItem('clinmesh.dsh.font-size:v1', 'large')
  window.dispatchEvent(new StorageEvent('storage', { key: 'clinmesh.dsh.font-size:v1', newValue: 'large', storageArea: localStorage }))
  expect(preference.getSnapshot()).toBe('large')
  expect(changed).toHaveBeenCalledOnce()
  unsubscribe()
  localStorage.setItem('clinmesh.dsh.font-size:v1', 'standard')
  window.dispatchEvent(new StorageEvent('storage', { key: 'clinmesh.dsh.font-size:v1', newValue: 'standard', storageArea: localStorage }))
  expect(changed).toHaveBeenCalledOnce()
  const resubscribe = preference.subscribe(changed)
  expect(preference.getSnapshot()).toBe('standard')
  resubscribe()
})

it('keeps the setting usable when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  const preference = createFontSizePreference()
  const changed = vi.fn()
  const unsubscribe = preference.subscribe(changed)
  preference.set('large')
  expect(preference.getSnapshot()).toBe('large')
  expect(changed).toHaveBeenCalledOnce()
  unsubscribe()
})
