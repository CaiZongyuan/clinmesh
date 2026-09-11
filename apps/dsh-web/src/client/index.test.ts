// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createDefinition } from './index.tsx'

describe('ClinMesh React Surface definition', () => {
  it('preserves DSH appearance and keeps narrow workspaces side by side', () => {
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
      layout: { fallback: string; supported: string[] }
    }

    expect(definition.branding.shell).toBe('preserve')
    expect(definition.branding.tokens).toBeUndefined()
    expect(definition.layout.fallback).toBe('shrink')
    expect(definition.layout.supported).toEqual(['workspace', 'full-frame'])
  })
})
