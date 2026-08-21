import { describe, expect, it } from 'vitest'
import { platformLabel } from '../src/platform.ts'

describe('platformLabel', () => {
  it('returns stable product-facing labels', () => {
    expect(platformLabel('web')).toBe('Web')
    expect(platformLabel('desktop')).toBe('Desktop')
    expect(platformLabel('mobile')).toBe('Mobile')
  })
})
