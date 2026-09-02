// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readWebPreferences,
  WEB_PREFERENCES_KEY,
  writeWebPreferences,
  type FontSizePreference,
} from './preferences.ts'

describe('Web preferences', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('adds the standard font size to saved preferences from before font scaling', () => {
    localStorage.setItem(WEB_PREFERENCES_KEY, JSON.stringify({
      locale: 'en-US',
      theme: 'dark',
    }))

    expect(readWebPreferences()).toEqual({
      fontSize: 'standard',
      locale: 'en-US',
      theme: 'dark',
    })
  })

  it.each<FontSizePreference>(['standard', 'larger', 'large'])(
    'persists and restores the %s font size',
    fontSize => {
      writeWebPreferences({ fontSize, locale: 'zh-CN', theme: 'system' })

      expect(readWebPreferences()).toEqual({
        fontSize,
        locale: 'zh-CN',
        theme: 'system',
      })
    },
  )

  it('defaults an invalid font size without discarding valid locale and theme preferences', () => {
    localStorage.setItem(WEB_PREFERENCES_KEY, JSON.stringify({
      fontSize: 'tiny',
      locale: 'en-US',
      theme: 'light',
    }))

    expect(readWebPreferences()).toEqual({
      fontSize: 'standard',
      locale: 'en-US',
      theme: 'light',
    })
  })

  it.each([
    ['invalid JSON', () => localStorage.setItem(WEB_PREFERENCES_KEY, '{')],
    ['unavailable storage', () => vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })],
  ])('returns complete defaults for %s', (_case, arrange) => {
    arrange()

    expect(readWebPreferences()).toEqual({
      fontSize: 'standard',
      locale: 'zh-CN',
      theme: 'system',
    })
  })
})
