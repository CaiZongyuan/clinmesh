// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ClinicalDocumentContent } from '@clinmesh/contracts/his'
import { afterEach, expect, it } from 'vitest'
import { useClinicalDocumentUpdates } from './clinical-document-updates.tsx'

afterEach(cleanup)
const initial: ClinicalDocumentContent = {
  chiefComplaint: '原主诉', historyOfPresentIllness: '原现病史', physicalExamination: '原体格检查',
  assessment: '原评估', disposition: '原处置', followUp: '原随访',
}

it('marks only changed displayed fields, preserves unseen changes across cases and does not mark manual input or saving it', () => {
  const { result, rerender } = renderHook(({ caseId, document }) => useClinicalDocumentUpdates(caseId, document, true),
    { initialProps: { caseId: 'first', document: initial } })
  expect(result.current.fields).toEqual({})
  const manual = { ...initial, chiefComplaint: '医生手工主诉' }
  act(() => result.current.onEdit('first', manual))
  rerender({ caseId: 'first', document: manual })
  rerender({ caseId: 'first', document: { ...manual } })
  expect(result.current.fields).toEqual({})
  const recorded = { ...manual, historyOfPresentIllness: '自动整理现病史', familyHistory: '父亲患高血压' }
  rerender({ caseId: 'first', document: recorded })
  expect(Object.keys(result.current.fields).sort()).toEqual(['familyHistory', 'historyOfPresentIllness'])
  const pending = result.current.fields
  rerender({ caseId: 'second', document: initial })
  expect(result.current.fields).toEqual({})
  rerender({ caseId: 'first', document: recorded })
  expect(result.current.fields).toEqual(pending)
  act(() => result.current.onEdit('first', { ...recorded, familyHistory: '医生修改家族史' }))
  expect(Object.keys(result.current.fields)).toEqual(['historyOfPresentIllness'])
})

it('keeps a newer update when an older display completes, ignores unchanged responses and clears reminders after signing', () => {
  const { result, rerender } = renderHook(({ document, editable }) => useClinicalDocumentUpdates('first', document, editable),
    { initialProps: { document: initial, editable: true } })
  const first = { ...initial, historyOfPresentIllness: '头晕五天' }
  rerender({ document: first, editable: true })
  const old = result.current.fields.historyOfPresentIllness!
  rerender({ document: { ...first }, editable: true })
  expect(result.current.fields.historyOfPresentIllness).toBe(old)
  rerender({ document: { ...first, historyOfPresentIllness: '更正为头晕六天' }, editable: true })
  const latest = result.current.fields.historyOfPresentIllness!
  act(() => result.current.onSeen('historyOfPresentIllness', old))
  expect(result.current.fields.historyOfPresentIllness).toBe(latest)
  act(() => result.current.onSeen('historyOfPresentIllness', latest))
  expect(result.current.fields).toEqual({})
  rerender({ document: first, editable: true })
  expect(result.current.fields.historyOfPresentIllness).toBeDefined()
  rerender({ document: first, editable: false })
  expect(result.current.fields).toEqual({})
})
