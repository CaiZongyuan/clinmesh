// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createDefinition } from './index.tsx'

vi.mock('dsh-react-surface/client', () => ({
  defineReactSurface: (definition: unknown) => definition,
}))

describe('ClinMesh React Surface definition', () => {
  it('preserves DSH appearance and falls back before ClinMesh content is compressed', () => {
    const sessions = {
      list: {
        getSnapshot: () => ({ current: undefined }),
        subscribe: () => () => undefined,
      },
    }
    const definition = createDefinition({
      get: () => sessions,
    } as unknown as ClientContext) as unknown as {
      branding: { shell: string; tokens?: Record<string, string> }
      layout: { minSurfaceWidth: number }
    }

    expect(definition.branding.shell).toBe('preserve')
    expect(definition.branding.tokens).toBeUndefined()
    expect(definition.layout.minSurfaceWidth).toBeGreaterThanOrEqual(1024)
  })
})
