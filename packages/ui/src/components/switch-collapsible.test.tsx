// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './collapsible.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './popover.tsx'
import { Switch } from './switch.tsx'

afterEach(() => {
  cleanup()
})

describe('@clinmesh/ui Switch, Collapsible, and Popover wrappers', () => {
  it('toggles Switch state and fires onCheckedChange', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Mock mode" onCheckedChange={onCheckedChange} />)

    const toggle = screen.getByRole('switch', { name: 'Mock mode' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await user.click(toggle)
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('expands and collapses CollapsiblePanel when clicking CollapsibleTrigger', async () => {
    const user = userEvent.setup()
    render(
      <Collapsible>
        <CollapsibleTrigger>Thinking trace</CollapsibleTrigger>
        <CollapsiblePanel>Hidden reasoning step</CollapsiblePanel>
      </Collapsible>,
    )

    expect(screen.queryByText('Hidden reasoning step')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Thinking trace' })
    await user.click(trigger)
    expect(screen.getByText('Hidden reasoning step')).toBeTruthy()
    await user.click(trigger)
    expect(screen.queryByText('Hidden reasoning step')).toBeNull()
  })

  it('opens and closes PopoverContent when clicking PopoverTrigger', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>Open history</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Session History</PopoverTitle>
          <div>Recent thread</div>
        </PopoverContent>
      </Popover>,
    )

    expect(screen.queryByText('Recent thread')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open history' }))
    expect(await screen.findByText('Recent thread')).toBeTruthy()
  })
})
