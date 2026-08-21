import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree } from './agent-note-tree.ts'

const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

const REQUIRED: Record<string, string[]> = {
  proposed: ['## Proposal', '## Alternatives considered', '## Acceptance criteria', '## Risks'],
  implemented: ['## Decision', '## Alternatives considered', '## Consequences'],
  rejected: ['## Proposal', '## Alternatives considered'],
}

const BANNED_IMPLEMENTED = /^## (?:Proposal|Plan|Migration plan|Acceptance criteria)\b/i
const { notes, errors } = walkAgentNoteTree()

for (const note of notes) {
  const lines = readFileSync(resolve(agentNoteRoot, note.rel), 'utf8').split('\n')
  const fail = (message: string): void => { errors.push(`format: ${note.rel} — ${message}`) }
  let inFence = false
  const prose = lines.filter((line) => {
    if (line.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be # Agent Note: <title>')
  if (lines[1] !== '') fail('line 2 must be blank')
  const status = STATUS[note.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) fail(`line 3 does not match ${note.lifecycle} status`)
  if (lines[3] !== '') fail('line 4 must be blank')
  const headings = prose.filter(line => line.startsWith('## ')).map(line => line.trimEnd())
  if (headings[0] !== '## Problem') fail('the first section must be ## Problem')
  for (const required of REQUIRED[note.lifecycle] ?? []) {
    if (!headings.includes(required)) fail(`missing ${required}`)
  }
  if (note.lifecycle === 'implemented') {
    for (const heading of headings.filter(item => BANNED_IMPLEMENTED.test(item))) fail(`${heading} is proposal-stage prose`)
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-format: ${notes.length} Agent Note(s) checked.`)
} else {
  console.error('verify-agent-note-format: violations found:')
  for (const error of errors) console.error(`  ${error}`)
  process.exitCode = 1
}
