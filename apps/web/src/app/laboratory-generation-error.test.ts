import { describe, expect, it } from 'vitest'
import {
  goldenCaseUnprepopulatedErrorMessage,
  laboratoryGenerationErrorMessage,
} from './laboratory-generation-error.ts'

describe('laboratoryGenerationErrorMessage & goldenCaseUnprepopulatedErrorMessage', () => {
  it('displays exact golden-case unprepopulated message when server returns 本病例未预置该检查', () => {
    expect(
      laboratoryGenerationErrorMessage('INVESTIGATION_UNSUPPORTED', 'zh-CN', '本病例未预置该检查'),
    ).toBe('本病例未预置该检查')
    expect(
      laboratoryGenerationErrorMessage('INVESTIGATION_UNSUPPORTED', 'en-US', '本病例未预置该检查'),
    ).toBe('This investigation is not pre-populated for this golden case.')

    expect(
      goldenCaseUnprepopulatedErrorMessage('INVESTIGATION_UNSUPPORTED', 'zh-CN', '本病例未预置该检查'),
    ).toBe('本病例未预置该检查')
    expect(
      goldenCaseUnprepopulatedErrorMessage('INVESTIGATION_UNSUPPORTED', 'en-US', '本病例未预置该检查'),
    ).toBe('This investigation is not pre-populated for this golden case.')
  })

  it('preserves default messages when serverMessage is absent or unrelated', () => {
    expect(laboratoryGenerationErrorMessage('INVESTIGATION_UNSUPPORTED', 'zh-CN')).toBe(
      '该病例缺少此检验的合成结果底账，无法生成结果。',
    )
    expect(laboratoryGenerationErrorMessage('INVESTIGATION_UNSUPPORTED', 'en-US')).toBe(
      'This case has no synthetic result evidence for this laboratory item.',
    )
    expect(
      laboratoryGenerationErrorMessage('INVESTIGATION_UNSUPPORTED', 'zh-CN', 'Other reason'),
    ).toBe('该病例缺少此检验的合成结果底账，无法生成结果。')
    expect(
      goldenCaseUnprepopulatedErrorMessage('INVESTIGATION_TRUTH_INCOMPATIBLE', 'zh-CN', '本病例未预置该检查'),
    ).toBeUndefined()
  })
})
