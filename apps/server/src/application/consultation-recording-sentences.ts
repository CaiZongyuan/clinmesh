import { hasStatementBoundaries } from '@clinmesh/core/document-text'

export interface RecordingSentence {
  id: string
  sourceTurnId: string
  start: number
  end: number
  quote: string
}

// Use the same boundary predicate as persisted citations. In particular, a
// following question mark belongs to the preceding statement, even after spaces.
export function recordingSentences(sources: Array<{ id: string; messageText: string }>, snapshotId: string): RecordingSentence[] {
  const sentences: RecordingSentence[] = []
  for (const source of sources) {
    let cursor = 0
    for (const match of source.messageText.matchAll(/[。！？；!?;]+|\r\n|[\r\n]|$/gu)) {
      const end = match.index + (/^[\r\n]/u.test(match[0]) ? 0 : match[0].length)
      const raw = source.messageText.slice(cursor, end)
      const quote = raw.trim()
      if (quote.length === 0) { cursor = match.index + match[0].length; continue }
      const start = cursor + raw.indexOf(quote)
      if (!hasStatementBoundaries(source.messageText, start, start + quote.length)) continue
      sentences.push({ id: `s${snapshotId}_${sentences.length.toString(36)}`, sourceTurnId: source.id,
        start, end: start + quote.length, quote })
      cursor = match.index + match[0].length
    }
  }
  return sentences
}
