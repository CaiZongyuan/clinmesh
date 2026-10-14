import { expect, it } from 'vitest'
import { visibleSourceClinicalSchema } from '../src/doctor-history.ts'

it.each(['Device', 'https://untrusted.example/type', 42, null, ['Device'], { coding: 'Device' }, { text: { reference: 'Device/1' } }])(
  'rejects a history type outside the CodeableConcept contract: %j', type => {
    expect(visibleSourceClinicalSchema.safeParse({ type }).success).toBe(false)
  },
)
