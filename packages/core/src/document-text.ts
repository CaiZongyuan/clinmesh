import { diffChars } from 'diff'

interface TextEdit { start: number; end: number; text: string }

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

/** Apply non-overlapping server changes while retaining all unsaved local edits. */
export function mergeDocumentText(base: string, local: string, remote: string): string {
  if (local === base) return remote
  if (remote === base || local === remote) return local
  const localEdits = edits(base, local)
  const remoteEdits = edits(base, remote).filter(edit => !localEdits.some(other =>
    overlaps(other, edit.start, edit.end) || overlaps(edit, other.start, other.end)
    || (other.start === edit.start && (other.start === other.end || edit.start === edit.end))))
  let result = local
  for (const edit of remoteEdits.reverse()) {
    const start = position(edit.start, localEdits, false)
    const end = position(edit.end, localEdits, true)
    result = result.slice(0, start) + edit.text + result.slice(Math.max(start, end))
  }
  return result
}
