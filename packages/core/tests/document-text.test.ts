import { expect, it } from 'vitest'
import { findCompleteStatementQuote } from '../src/document-text.ts'

it('locates the affirmative statement after the same quote occurs inside a preceding negation', () => {
  expect(findCompleteStatementQuote('我之前没有发热。发热。', '发热。')).toEqual({ start: 8, end: 11 })
})

it.each([
  ['发热三天\n最高量到38.5度', 5],
  ['发热三天\r\n最高量到38.5度', 6],
])('preserves newline boundaries in %j', (text, start) => {
  expect(findCompleteStatementQuote(text, '最高量到38.5度')).toEqual({ start, end: text.length })
})

it.each([
  ['我之前没有发热。', '发热。'],
  ['体温38.5℃', '5℃'],
  ['发热。？', '发热。'],
  ['发热。', '头晕。'],
  ['发热。', ''],
])('leaves invalid or absent citations unlocated in %j', (text, quote) => {
  expect(findCompleteStatementQuote(text, quote)).toBeUndefined()
})
