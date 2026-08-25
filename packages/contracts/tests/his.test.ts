import { describe, expect, it } from 'vitest'
import { laboratoryRequestStateSchema } from '../src/his.ts'

describe('HIS contracts', () => {
  it('rejects unsupported catalog items in a laboratory request draft', () => {
    expect(laboratoryRequestStateSchema.safeParse({
      draft: {
        catalogItemId: 'lab-fever-panel',
        indicationCode: 'fever',
      },
      draftVersion: 1,
      requests: [],
    }).success).toBe(false)
  })
})
