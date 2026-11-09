import { describe, expect, it } from 'vitest'
import { resolveClinicalHistoryRequirements } from '@clinmesh/core/clinical-document'

const adult = { gender: 'female', birthDate: '1990-01-01', visitDate: '2026-11-09', departmentCode: 'GM', visitKind: 'unknown' as const }

describe('clinical history requirements', () => {
  it('allows ordinary outpatient women to leave both histories unrecorded', () => {
    expect(resolveClinicalHistoryRequirements(adult)).toMatchObject({ requiredFields: [], reason: 'general-outpatient', showByDefault: true })
  })
  it('treats an impossible calendar date as unknown context', () => {
    expect(resolveClinicalHistoryRequirements({ ...adult, birthDate: '2014-02-30', departmentCode: 'GYN', visitKind: 'initial' }))
      .toMatchObject({ requiredFields: [], reason: 'context-incomplete', showByDefault: true })
  })
  it.each([
    ['2016-11-10', 'under-ten', false, []],
    ['2016-11-09', 'under-twelve', true, []],
    ['2014-11-10', 'under-twelve', true, []],
    ['2014-11-09', 'specialty-initial', true, ['menstrualHistory', 'obstetricHistory']],
  ])('uses the visit date at the 10/12 year boundaries for %s', (birthDate, reason, showByDefault, requiredFields) => {
    expect(resolveClinicalHistoryRequirements({ ...adult, birthDate, departmentCode: 'GYN', visitKind: 'initial' }))
      .toMatchObject({ reason, showByDefault, requiredFields })
  })
  it.each(['GYN', 'OB', 'OBGYN', 'REPRO', 'BREAST'])('requires both histories only for a confirmed %s initial visit', departmentCode => {
    expect(resolveClinicalHistoryRequirements({ ...adult, departmentCode, visitKind: 'initial' }).requiredFields)
      .toEqual(['menstrualHistory', 'obstetricHistory'])
    expect(resolveClinicalHistoryRequirements({ ...adult, departmentCode, visitKind: 'follow-up' }))
      .toMatchObject({ requiredFields: [], reason: 'specialty-follow-up' })
    expect(resolveClinicalHistoryRequirements({ ...adult, departmentCode }))
      .toMatchObject({ requiredFields: [], reason: 'context-incomplete', showByDefault: true })
  })
  it.each([
    { gender: 'unknown' }, { gender: 'other' }, { birthDate: undefined }, { visitDate: undefined },
    { departmentCode: undefined }, { birthDate: '2027-01-01' }, { visitDate: '2026-02-30' },
  ])('keeps uncertain context visible without forcing histories: %j', overrides => {
    expect(resolveClinicalHistoryRequirements({ ...adult, ...overrides }))
      .toMatchObject({ requiredFields: [], reason: 'context-incomplete', showByDefault: true })
  })
  it('collapses male histories and keeps ordinary older women optional', () => {
    expect(resolveClinicalHistoryRequirements({ ...adult, gender: 'male' })).toMatchObject({ requiredFields: [], showByDefault: false })
    expect(resolveClinicalHistoryRequirements({ ...adult, birthDate: '1940-01-01', visitKind: 'initial' }))
      .toMatchObject({ requiredFields: [], reason: 'general-outpatient' })
  })
})
