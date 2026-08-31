// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutosave } from './use-autosave.ts'

function AutosaveHarness({ enabled, onSave, revision }: {
  enabled: boolean
  onSave: () => void
  revision: string
}): null {
  useAutosave({ delayMs: 800, enabled, onSave, revision })
  return null
}

describe('useAutosave', () => {
  afterEach(() => vi.useRealTimers())

  it('attempts each content revision once and waits for a new revision after failure', () => {
    vi.useFakeTimers()
    const onSave = vi.fn()
    const view = render(<AutosaveHarness enabled onSave={onSave} revision="draft-1:a" />)

    act(() => vi.advanceTimersByTime(800))
    expect(onSave).toHaveBeenCalledTimes(1)

    view.rerender(<AutosaveHarness enabled={false} onSave={onSave} revision="draft-1:a" />)
    view.rerender(<AutosaveHarness enabled onSave={onSave} revision="draft-1:a" />)
    act(() => vi.advanceTimersByTime(1_600))
    expect(onSave).toHaveBeenCalledTimes(1)

    view.rerender(<AutosaveHarness enabled onSave={onSave} revision="draft-1:b" />)
    act(() => vi.advanceTimersByTime(800))
    expect(onSave).toHaveBeenCalledTimes(2)
  })
})
