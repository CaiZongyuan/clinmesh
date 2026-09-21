import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getHisOperation, listHisOperations } from '@clinmesh/contracts/his-operations'
import { type Command, type Option } from 'commander'
import { createCliProgram } from '../src/cli.ts'

const expectedSkills = [
  'clinmesh-administrator',
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

function inspectExample(program: Command, line: string) {
  const words = line.split(/\s+/).slice(1)
  const path: string[] = []
  let command = program
  let index = 0
  while (index < words.length) {
    const child = command.commands.find(candidate => candidate.name() === words[index])
    if (child === undefined) break
    command = child
    path.push(words[index]!)
    index += 1
  }
  if (path.length === 0 || command.commands.length > 0 && index === words.length) {
    throw new Error(`Unknown or incomplete command: ${line}`)
  }

  const options: Option[] = []
  for (let current: Command | null = command; current !== null; current = current.parent) {
    options.push(...current.options)
  }
  const seen = new Set<Option>()
  const positionals: string[] = []
  for (; index < words.length; index += 1) {
    const token = words[index]!
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const flag = token.split('=', 1)[0]!
    const option = options.find(candidate => candidate.long === flag || candidate.short === flag)
    if (option === undefined) throw new Error(`Unknown flag ${flag}: ${line}`)
    seen.add(option)
    if (!token.includes('=') && (option.required || option.optional)) {
      index += 1
      if (words[index] === undefined) throw new Error(`Missing value for ${flag}: ${line}`)
    }
  }

  const requiredArguments = command.registeredArguments.filter(argument => argument.required)
  if (positionals.length < requiredArguments.length || positionals.length > command.registeredArguments.length) {
    throw new Error(`Invalid positional arguments: ${line}`)
  }
  const missingOption = command.options.find(option => option.mandatory && !seen.has(option))
  if (missingOption !== undefined) throw new Error(`Missing ${missingOption.long}: ${line}`)

  if (path.join(' ') === 'operations schema' && !positionals[0]?.startsWith('<')) {
    getHisOperation(positionals[0] ?? '')
  }
  const operationIdIndex = words.indexOf('--operation-id')
  const operationId = operationIdIndex === -1 ? undefined : words[operationIdIndex + 1]
  if (operationId !== undefined && !operationId.startsWith('<')) {
    const receiptTarget = getHisOperation(operationId)
    if (receiptTarget.requirements.idempotency !== 'required') {
      throw new Error(`Operation does not create a Command receipt: ${operationId}`)
    }
  }
  return {
    commandPath: path.join(' '),
    operation: listHisOperations().find(operation => operation.cliPath.join(' ') === path.join(' ')),
  }
}

describe('ClinMesh CLI Agent Skills', () => {
  it('documents absent triage in the versioned doctor read contracts', async () => {
    const doctorSkill = await readFile(resolve(
      import.meta.dirname, '../../../.agents/skills/clinmesh-doctor/SKILL.md',
    ), 'utf8')
    for (const id of ['doctor.queue.list', 'doctor.case.get']) {
      const operation = getHisOperation(id)
      expect(operation.version).toBe(2)
      expect(operation.summary).toContain('presentation')
      const result = operation.output.safeParse(id === 'doctor.queue.list'
        ? { items: [{ presentation: null }] }
        : { presentation: null })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => issue.path.includes('presentation'))).toBe(false)
      }
      const invalid = operation.output.safeParse(id === 'doctor.queue.list'
        ? { items: [{ presentation: 'unknown' }] }
        : { presentation: 'unknown' })
      expect(invalid.success).toBe(false)
      if (!invalid.success) {
        expect(invalid.error.issues.some(issue => issue.path.includes('presentation'))).toBe(true)
      }
    }
    expect(doctorSkill).toContain('presentation: null')
  })

  it('keeps correlation recovery guidance aligned with the Catalog error schema', async () => {
    const sharedSkill = await readFile(resolve(
      import.meta.dirname,
      '../../../.agents/skills/clinmesh-shared/SKILL.md',
    ), 'utf8')
    const error = getHisOperation('patient.create').error.parse({
      code: 'ambiguous_outcome',
      correlationId: '01991234-7abc-7def-8abc-0123456789ab',
      message: 'Inspect the Command receipt before retrying',
      operationId: 'patient.create',
      outcome: 'ambiguous',
      retryable: false,
      type: 'api',
    })

    expect(sharedSkill).toContain('error.correlationId')
    expect(error.correlationId).toBe('01991234-7abc-7def-8abc-0123456789ab')
  })

  it('documents non-retryable laboratory evidence errors on both order operations', async () => {
    const doctorSkill = await readFile(resolve(
      import.meta.dirname, '../../../.agents/skills/clinmesh-doctor/SKILL.md',
    ), 'utf8')
    for (const id of ['encounter.laboratory-request.draft.set', 'encounter.laboratory-request.issue']) {
      const operation = getHisOperation(id)
      expect(operation.summary).toContain('LABORATORY_GENERATION_UNSUPPORTED')
      expect(operation.error.parse({
        code: 'LABORATORY_GENERATION_UNSUPPORTED', message: '缺少结果底账',
        operationId: id, outcome: 'definitely_not_sent', retryable: false, type: 'conflict',
      }).retryable).toBe(false)
    }
    expect(doctorSkill).toContain('LABORATORY_GENERATION_UNSUPPORTED')
    expect(doctorSkill).toContain('INVESTIGATION_UNSUPPORTED')
    expect(doctorSkill).toContain('AI_REQUEST_FAILED')
  })

  it('keeps every documented clinical command on a real Catalog path', async () => {
    const skillsRoot = resolve(import.meta.dirname, '../../../.agents/skills')
    const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('clinmesh-'))
      .map(entry => entry.name)
      .toSorted()
    expect(skillNames).toEqual(expectedSkills)

    const sharedPaths = ['auth login', 'auth logout', 'auth role use', 'auth status', 'context show', 'operations list', 'operations schema']
    const program = createCliProgram({
      stderr: { write: () => undefined },
      stdout: { write: () => undefined },
    })
    for (const skillName of skillNames) {
      const markdown = await readFile(resolve(skillsRoot, skillName, 'SKILL.md'), 'utf8')
      const commands = commandLines(markdown)
      if (skillName === 'clinmesh-doctor') {
        expect(commands).toContain('clinmesh doctor queue list --view waiting')
        expect(commands).toContain('clinmesh doctor queue list --view active')
      }
      expect(commands.length, `${skillName} has no executable examples`).toBeGreaterThan(0)
      if (skillName === 'clinmesh-registration') {
        expect(commands).toContain(
          'clinmesh registration synthetic-case list --search <name-or-mrn>',
        )
      }
      expect(commands.some(command => command.includes('agent client') || command.includes('agent grant'))).toBe(false)
      for (const line of commands) {
        const { commandPath, operation } = inspectExample(program, line)
        const matchesShared = sharedPaths.includes(commandPath)
        expect(operation !== undefined || matchesShared, `${skillName}: ${line}`).toBe(true)
        if (operation !== undefined && operation.id !== 'command.receipt.get') {
          expect(operation.skill, `${skillName}: ${operation.id}`).toBe(skillName)
        }
      }
    }
    expect(() => inspectExample(program, 'clinmesh patient search --bogus value'))
      .toThrow('Unknown flag --bogus')
    expect(() => inspectExample(
      program,
      'clinmesh command receipt get --operation-id missing.operation --idempotency-key example-key',
    )).toThrow('Unknown HIS operation: missing.operation')
    expect(() => inspectExample(
      program,
      'clinmesh command receipt get --operation-id patient.search --idempotency-key example-key',
    )).toThrow('Operation does not create a Command receipt: patient.search')
  })
})
