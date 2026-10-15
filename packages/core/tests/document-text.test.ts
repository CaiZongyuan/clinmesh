import { expect, it } from 'vitest'
import { findCompleteStatementQuote, mergeDocumentText } from '../src/document-text.ts'

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

it.each(['头晕三天', '患者自述头晕三天'])('keeps a complete remote rewrite beside unsaved edits to %j', base => {
  const local = '医生核对：头晕四天。'
  const remote = '三天前出现头晕，伴昨夜恶心'
  expect(mergeDocumentText(base, local, remote, '')).toBe(`${local}\n${remote}`)
})

it('updates untouched statements while retaining both versions of an edited statement', () => {
  expect(mergeDocumentText('头晕三天。无胸痛。', '医生核对：头晕四天。无胸痛。', '三天前出现头晕，伴昨夜恶心。否认胸痛、气促。', ''))
    .toBe('医生核对：头晕四天。否认胸痛、气促。\n三天前出现头晕，伴昨夜恶心。')
})

it('replaces a previously retained remote statement on the next update without altering the manual text', () => {
  expect(mergeDocumentText('三天前出现头晕，伴昨夜恶心。',
    '医生核对：头晕四天。\n三天前出现头晕，伴昨夜恶心。', '三天前出现头晕，伴昨夜恶心、呕吐。', ''))
    .toBe('医生核对：头晕四天。\n三天前出现头晕，伴昨夜恶心、呕吐。')
})

it('keeps simultaneous additions intact and does not repeat matching changes', () => {
  expect(mergeDocumentText('头晕三天。', '头晕三天。医生补充。', '头晕三天。患者补充恶心。', ''))
    .toBe('头晕三天。医生补充。\n患者补充恶心。')
  expect(mergeDocumentText('头晕三天。无胸痛。', '头晕四天。无胸痛。', '头晕四天。否认胸痛、气促。', ''))
    .toBe('头晕四天。否认胸痛、气促。')
})

it.each(['医生记录：药物待核实。', '反复头晕一周'])('appends new statements without restoring a locally replaced baseline %j', base => {
  const local = '医生核对：头晕五天。\n医生补充：站立时加重。'
  const addition = '患者自述：夜间也会头晕。'
  expect(mergeDocumentText(base, local, `${base}\n${addition}`, '待核实补充：'))
    .toBe(`${local}\n${addition}`)
})

it('retains the conflict label and manual text while a later remote summary changes', () => {
  const local = '医生核对：头晕四天。'
  const remote = '三天前出现头晕，伴昨夜恶心'
  const combined = `${local}\n待核实补充：\n${remote}`
  expect(mergeDocumentText('头晕三天', local, remote, '待核实补充：')).toBe(combined)
  expect(mergeDocumentText(remote, combined, `${remote}、呕吐`, '待核实补充：'))
    .toBe(`${combined}、呕吐`)
})

it('preserves edited statements on remote deletion and keeps newline and Unicode boundaries intact', () => {
  expect(mergeDocumentText('头晕三天。无胸痛。', '医生核对：头晕四天。无胸痛。', '无胸痛。', ''))
    .toBe('医生核对：头晕四天。无胸痛。')
  expect(mergeDocumentText('头晕三天。\r\n无胸痛。', '医生补充🙂\r\n头晕三天。\r\n无胸痛。', '头晕三天。\r\n否认胸痛、气促。', ''))
    .toBe('医生补充🙂\r\n头晕三天。\r\n否认胸痛、气促。')
})

it('keeps the local assessment when another workstation saves an overlapping change', () => {
  expect(mergeDocumentText('原评估。', '本工作站准备保存的评估。', '另一工作站已经补充了最新评估。'))
    .toBe('本工作站准备保存的评估。')
})
