import { describe, expect, it } from 'vitest'
import {
  auditBuiltInTheme,
  BUILT_IN_THEMES,
  checkThemePackage,
  exportThemeArchive,
  inspectThemeZipBytes,
  migrateLegacyPreferences,
  sanitizeThemeCss,
} from './index.ts'

describe('ClinMesh Appearance & Theme Engine', () => {
  it('verifies all 6 clean-room built-in themes are author ClinMesh and pass WCAG AA in both light and dark modes', () => {
    expect(BUILT_IN_THEMES).toHaveLength(6)
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.author).toBe('ClinMesh')
      const report = auditBuiltInTheme(theme)
      expect(report.issues, `${theme.id}: ${report.issues.map(i => i.message).join('; ')}`).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.contrast.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('keeps default theme empty-override so ClinMesh baseline stays unchanged', () => {
    const def = BUILT_IN_THEMES[0]
    expect(def?.id).toBe('default')
    expect(Object.keys(def?.tokens.light ?? {})).toHaveLength(0)
    expect(Object.keys(def?.tokens.dark ?? {})).toHaveLength(0)
  })

  it('blocks external @import, remote url(), locked specimen cap overrides, and data-agent-confirm tampering', () => {
    const hostileCss = `
      @import url("https://evil.example/a.css");
      :root {
        --specimen-cap-purple: #ffffff;
        background-image: url("https://evil.example/track.png");
      }
      [data-agent-confirm] { display: none !important; }
    `
    const result = sanitizeThemeCss(hostileCss)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const joined = result.errors.map(e => e.message).join('\n')
      expect(joined).toContain('@import')
      expect(joined).toContain('specimen-cap-purple')
      expect(joined).toContain('External or inline URL')
      expect(joined).toContain('data-agent-confirm')
    }
  })

  it('rejects low-contrast custom theme packages via @ui-sdk/core/color WCAG check', () => {
    const report = checkThemePackage({
      manifest: { apiVersion: 1, id: 'bad-contrast', name: 'Low Contrast' },
      css: ':root.theme-light { --card: #ffffff; --foreground: #dddddd; }',
    })
    expect(report.ok).toBe(false)
    expect(report.issues.some(i => i.code === 'CONTRAST_FAILURE')).toBe(true)
  })

  it('exports any built-in theme as a valid .zip template and round-trips through inspectThemeZipBytes', async () => {
    const scrub = BUILT_IN_THEMES.find(t => t.id === 'scrub-fresh')!
    const bytes = exportThemeArchive(scrub, { id: 'my-ward-theme', name: 'My Ward Theme' })
    const report = await inspectThemeZipBytes(bytes)
    expect(report.ok).toBe(true)
    expect(report.theme?.id).toBe('my-ward-theme')
    expect(report.theme?.name).toBe('My Ward Theme')
  })

  it('migrates legacy v1 preferences cleanly to v2 AppearancePreferences', () => {
    const migrated = migrateLegacyPreferences({
      fontSize: 'large',
      locale: 'zh-CN',
      theme: 'dark',
    })
    expect(migrated.version).toBe(2)
    expect(migrated.colorMode).toBe('dark')
    expect(migrated.fontSize).toBe(18)
    expect(migrated.theme).toBe('default')
  })
})
