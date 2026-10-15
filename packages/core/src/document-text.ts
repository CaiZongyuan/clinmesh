import { diffArrays, diffChars } from 'diff'

interface TextEdit { start: number; end: number; text: string }

export function hasStatementBoundaries(text: string, start: number, end: number): boolean {
  const quote = text.slice(start, end)
  const boundary = /[。！？；!?;\r\n]/u
  const before = text.slice(0, start).replace(/[^\S\r\n]+$/u, '')
  const after = text.slice(end).replace(/^[^\S\r\n]+/u, '')
  return !/^(?:[。！？；!?;]|[^\S\r\n])*[?？]/u.test(after)
    && (before.length === 0 || boundary.test(before.at(-1)!))
    && (after.length === 0 || boundary.test(after[0]!) || boundary.test(quote.at(-1)!))
}

/** Locate the first complete statement, skipping matches inside other statements. */
export function findCompleteStatementQuote(text: string, quote: string): { start: number; end: number } | undefined {
  if (quote.length === 0) return undefined
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) {
    const end = start + quote.length
    if (hasStatementBoundaries(text, start, end)) return { start, end }
  }
  return undefined
}

function edits(before: string, after: string): TextEdit[] {
  const result: TextEdit[] = []
  let offset = 0
  let edit: TextEdit | undefined
  for (const part of diffChars(before, after)) {
    if (!part.added && !part.removed) {
      if (edit !== undefined) result.push(edit)
      edit = undefined
      offset += part.value.length
    } else {
      edit ??= { start: offset, end: offset, text: '' }
      if (part.removed) { offset += part.value.length; edit.end = offset }
      else edit.text += part.value
    }
  }
  if (edit !== undefined) result.push(edit)
  return result
}

function overlaps(edit: TextEdit, start: number, end: number): boolean {
  return edit.start === edit.end
    ? edit.start > start && edit.start < end
    : edit.start < end && edit.end > start
}

function position(offset: number, changes: TextEdit[], end: boolean): number {
  let delta = 0
  for (const edit of changes) {
    if (edit.end <= offset && !(end && edit.start === offset)) delta += edit.text.length - (edit.end - edit.start)
    else if (edit.start < offset || (!end && edit.start === offset)) return edit.start + delta + (end ? edit.text.length : 0)
    else break
  }
  return offset + delta
}

/** Track an attributed fragment through a saved edit, retaining its manual ownership. */
export function trackDocumentFragment(before: string, after: string, start: number, end: number) {
  const changes = edits(before, after)
  const nextStart = position(start, changes, false)
  const nextEnd = Math.max(nextStart, position(end, changes, true))
  return { start: nextStart, end: nextEnd, text: after.slice(nextStart, nextEnd),
    modified: changes.some(edit => overlaps(edit, start, end)) }
}

function statementEdits(before: string, after: string): TextEdit[] {
  // Keep line breaks separate so appending a line does not rewrite the previous statement.
  const statements = (text: string) => text.match(/[^。！？!?；;\r\n]+[。！？!?；;]?|[。！？!?；;]|\r\n|[\r\n]/gu) ?? []
  const result: TextEdit[] = []
  let offset = 0
  let change: { start: number; removed: string[]; added: string[] } | undefined
  const flush = () => {
    if (change === undefined) return
    if (change.removed.length === change.added.length) {
      let start = change.start
      for (const [index, text] of change.removed.entries()) {
        result.push({ start, end: start + text.length, text: change.added[index]! })
        start += text.length
      }
    } else result.push({ start: change.start, end: offset, text: change.added.join('') })
    change = undefined
  }
  for (const part of diffArrays(statements(before), statements(after))) {
    if (!part.added && !part.removed) {
      flush()
      offset += part.value.join('').length
    } else {
      change ??= { start: offset, removed: [], added: [] }
      if (part.removed) { change.removed.push(...part.value); offset += part.value.join('').length }
      else change.added.push(...part.value)
    }
  }
  flush()
  return result
}

/** An explicit conflict label preserves complete remote statements beside unsaved edits. */
export function mergeDocumentText(base: string, local: string, remote: string, conflictLabel?: string): string {
  if (local === base) return remote
  if (remote === base || local === remote) return local
  const changes = conflictLabel === undefined ? edits : statementEdits
  const localEdits = changes(base, local)
  const conflicts: string[] = []
  const remoteEdits = changes(base, remote).filter(edit => {
    if (localEdits.some(other => other.start === edit.start && other.end === edit.end && other.text === edit.text)) return false
    const conflict = localEdits.some(other => overlaps(other, edit.start, edit.end) || overlaps(edit, other.start, other.end)
      || (other.start === edit.start && (conflictLabel === undefined
        ? other.start === other.end || edit.start === edit.end
        : other.start === other.end && edit.start === edit.end)))
    if (conflict && edit.text && conflictLabel !== undefined) conflicts.push([conflictLabel, edit.text].filter(Boolean).join('\n'))
    return !conflict
  })
  let result = local
  for (const edit of remoteEdits.reverse()) {
    const start = position(edit.start, localEdits, false)
    const end = position(edit.end, localEdits, true)
    result = result.slice(0, start) + edit.text + result.slice(Math.max(start, end))
  }
  return [result, ...conflicts].filter(Boolean).join('\n')
}
