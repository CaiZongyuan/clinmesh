import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const compactStyles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  .replace(/[\s"']/g, '')

function declarations(selector: string): string {
  const start = compactStyles.indexOf(`${selector}{`)
  if (start === -1) {
    throw new Error(`Missing stylesheet selector: ${selector}; length=${compactStyles.length}`)
  }
  const declarationsStart = start + selector.length + 1
  const end = compactStyles.indexOf('}', declarationsStart)
  return compactStyles.slice(declarationsStart, end)
}

describe('Web font scale styles', () => {
  it('does not apply the application base font size to the standalone document root', () => {
    expect(declarations('[data-clinmesh-app=web]')).not.toMatch(/(?:^|;)font-size:/)
    expect(declarations(
      ':root[data-clinmesh-app=web]body,.clinmesh-web-root[data-clinmesh-app=web]',
    )).toMatch(/font-size:calc\((?:0)?\.8125rem\*var\(--clinmesh-font-scale\)\)/)
  })

  it.each([
    ['standard', '1'],
    ['larger', '1.125'],
    ['large', '1.25'],
  ])('publishes the %s scale through typography tokens', (fontSize, scale) => {
    const applicationTokens = declarations('[data-clinmesh-app=web]')
    const scaleTokens = fontSize === 'standard'
      ? applicationTokens
      : declarations(`[data-clinmesh-app=web][data-font-size=${fontSize}]`)

    expect(applicationTokens).toMatch(
      /--text-sm:calc\((?:0)?\.8125rem\*var\(--clinmesh-font-scale\)\)/,
    )
    expect(applicationTokens).toMatch(
      /--text-xs:calc\((?:0)?\.75rem\*var\(--clinmesh-font-scale\)\)/,
    )
    expect(scaleTokens).toContain(`--clinmesh-font-scale:${scale}`)
  })
})
