import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
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

const REPO_DOC_BLOB_URL = /https?:\/\/github\.com\/(?:CaiZongyuan|inerdstack)\/clinmesh\/(?:blob|tree)\/[^)\s]+\/docs\//gi

function extractSectionHeading(raw: string, node: Extract<Nodes, { type: 'heading' }>): string {
  if (node.children.length === 0) return '##'
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  const rawHeading = start !== undefined && end !== undefined ? raw.slice(start, end) : ''
  const firstLine = (rawHeading.split(/\r?\n/, 1)[0] ?? '').trim()
  const atxMatch = firstLine.match(/^#{2}(?:\s+(.*?))?(?:\s+#+)?$/)
  const title = (atxMatch !== null ? (atxMatch[1] ?? '') : firstLine).trim()
  return title === '' ? '##' : `## ${title}`
}

export function validateAgentNotes(rootDir = agentNoteRoot): { checked: number; errors: string[] } {
  const { notes, errors } = walkAgentNoteTree(rootDir)

  for (const note of notes) {
    const raw = readFileSync(resolve(rootDir, note.rel), 'utf8')
    const lines = raw.split(/\r?\n/)
    const fail = (message: string): void => { errors.push(`format: ${note.rel} — ${message}`) }
    const tree = fromMarkdown(raw, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })

    if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be # Agent Note: <title>')
    if (lines[1] !== '') fail('line 2 must be blank')
    const status = STATUS[note.lifecycle]
    if (status !== undefined && !status.test(lines[2] ?? '')) fail(`line 3 does not match ${note.lifecycle} status`)
    if (lines[3] !== '') fail('line 4 must be blank')

    const headings = tree.children
      .filter((node): node is Extract<Nodes, { type: 'heading' }> => node.type === 'heading' && node.depth === 2)
      .map(node => extractSectionHeading(raw, node))
    if (headings[0] !== '## Problem') fail('the first section must be ## Problem')
    for (const required of REQUIRED[note.lifecycle] ?? []) {
      if (!headings.includes(required)) fail(`missing ${required}`)
    }
    if (note.lifecycle === 'implemented') {
      for (const heading of headings.filter(item => !ALLOWED_IMPLEMENTED.has(item))) {
        fail(`${heading} is not an allowed implemented section`)
      }
    }

    const reportMatches = (value: string): boolean => {
      let matched = false
      for (const match of value.matchAll(REPO_DOC_BLOB_URL)) {
        matched = true
        fail(`use repository-relative link instead of ${match[0]}`)
      }
      return matched
    }
    const visit = (node: Nodes): void => {
      if (node.type === 'code' || node.type === 'inlineCode') return
      if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && reportMatches(node.url)) {
        return
      }
      if (node.type === 'text') {
        reportMatches(node.value)
      } else if (node.type === 'html') {
        reportMatches(node.value.replace(/<!--[\s\S]*?-->/g, ''))
      }
      if ('children' in node) {
        for (const child of node.children) visit(child)
      }
    }
    visit(tree)
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
