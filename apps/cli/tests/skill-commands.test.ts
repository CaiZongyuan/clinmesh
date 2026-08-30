import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listHisOperations } from '@clinmesh/contracts/his-operations'
import { runCli } from '../src/cli.ts'

const expectedSkills = [
  'clinmesh-billing',
  'clinmesh-doctor',
  'clinmesh-fhir',
  'clinmesh-pharmacy',
  'clinmesh-registration',
  'clinmesh-shared',
  'clinmesh-triage',
]

function commandLines(markdown: string): string[] {
  const lines = markdown.split('\n')
  const commands: string[] = []
  let bash = false
  for (const line of lines) {
    if (line.trim() === '```bash') {
      bash = true
      continue
    }
    if (line.trim() === '```') {
      bash = false
      continue
    }
    if (bash && line.trim().startsWith('clinmesh ')) commands.push(line.trim())
  }
  return commands
}

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('ClinMesh CLI Agent Skills', () => {
  it('keeps every documented clinical command on a real Catalog path', async () => {
    const skillsRoot = resolve(import.meta.dirname, '../../../.agents/skills')
    const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('clinmesh-'))
      .map(entry => entry.name)
      .toSorted()
    expect(skillNames).toEqual(expectedSkills)

    const catalog = listHisOperations()
    const sharedPaths = ['auth login', 'auth logout', 'auth role use', 'auth status', 'context show', 'operations list', 'operations schema']
    for (const skillName of skillNames) {
      const markdown = await readFile(resolve(skillsRoot, skillName, 'SKILL.md'), 'utf8')
      const commands = commandLines(markdown)
      expect(commands.length, `${skillName} has no executable examples`).toBeGreaterThan(0)
      expect(commands.some(command => command.includes('agent client') || command.includes('agent grant'))).toBe(false)
      for (const command of commands) {
        const words = command.split(/\s+/).slice(1)
        const operation = catalog.find(candidate => words.join(' ').startsWith(
          candidate.cliPath.join(' '),
        ))
        const matchesShared = sharedPaths.some(path => words.join(' ').startsWith(path))
        expect(operation !== undefined || matchesShared, `${skillName}: ${command}`).toBe(true)
        if (operation !== undefined && operation.id !== 'command.receipt.get') {
          expect(operation.skill, `${skillName}: ${operation.id}`).toBe(skillName)
        }

        const stdout = captureStream()
        const stderr = captureStream()
        const exitCode = await runCli(
          [...words, '--help'],
          { stderr: stderr.stream, stdout: stdout.stream },
        )
        expect(exitCode, `${skillName}: ${command}`).toBe(0)
        expect(stderr.value(), `${skillName}: ${command}`).toBe('')
        expect(stdout.value(), `${skillName}: ${command}`).toContain('Usage: clinmesh')
      }
    }
  })
})
