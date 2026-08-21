import { globSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const agentNoteRoot = resolve(import.meta.dirname, '../.agents/notes')

const AGENT_NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const
export const AGENT_NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] as const
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

export interface AgentNote {
  lifecycle: string
  rel: string
  date: string
}

export function walkAgentNoteTree(): { notes: AgentNote[]; errors: string[] } {
  const notes: AgentNote[] = []
  const errors: string[] = []

  for (const entry of readdirSync(agentNoteRoot, { withFileTypes: true })) {
    if (entry.name === 'INDEX.md') errors.push('structure: INDEX.md is not allowed; browse or search the lifecycle tree')
    if (entry.isDirectory() && !(AGENT_NOTE_LIFECYCLES as readonly string[]).includes(entry.name)) {
      errors.push(`structure: ${entry.name}/ is not an Agent Note lifecycle`)
    }
  }

  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    const matches = globSync(`${lifecycle}/**/*.md`, { cwd: agentNoteRoot })
      .map(path => path.split(sep).join('/'))
      .sort()
    for (const match of matches) {
      const segments = match.split('/')
      if (segments.length === 2 && ROOT_ALLOWLIST.has(segments[1] ?? '')) continue
      const noteClass = segments[1]
      const base = segments[2]
      if (segments.length !== 3 || noteClass === undefined || base === undefined) {
        errors.push(`structure: ${match} must be {lifecycle}/{class}/file.md`)
        continue
      }
      if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(noteClass)) {
        errors.push(`structure: ${match} uses unknown class ${JSON.stringify(noteClass)}`)
        continue
      }
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base)) {
        errors.push(`structure: ${match} filename must be yyyy-mm-dd-topic.md`)
        continue
      }
      notes.push({ lifecycle, rel: match, date: base.slice(0, 10) })
    }
  }

  return { notes, errors }
}
