import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const ALLOWED_IMPLEMENTED = new Set([
  '## Problem',
  '## Decision',
  '## Alternatives considered',
  '## Consequences',
])

const REPO_DOC_BLOB_URL = /https?:\/\/github\.com\/(?:CaiZongyuan|inerdstack)\/clinmesh\/(?:blob|tree)\/[^)\s]+\/docs\//i

export function validateAgentNotes(rootDir = agentNoteRoot): { checked: number; errors: string[] } {
  const { notes, errors } = walkAgentNoteTree(rootDir)

  for (const note of notes) {
    const lines = readFileSync(resolve(rootDir, note.rel), 'utf8').split(/\r?\n/)
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
      for (const heading of headings.filter(item => !ALLOWED_IMPLEMENTED.has(item))) {
        fail(`${heading} is not an allowed implemented section`)
      }
    }
    for (const line of prose) {
      const match = line.match(REPO_DOC_BLOB_URL)
      if (match !== null) fail(`use repository-relative link instead of ${match[0]}`)
    }
  }

  return { checked: notes.length, errors }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, errors } = validateAgentNotes()
  if (errors.length === 0) {
    console.log(`verify-agent-note-format: ${checked} Agent Note(s) checked.`)
  } else {
    console.error('verify-agent-note-format: violations found:')
    for (const error of errors) console.error(`  ${error}`)
    process.exitCode = 1
  }
}
