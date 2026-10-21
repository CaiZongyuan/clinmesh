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

it('keeps registration examples and numbering recovery aligned with the command catalog', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-registration/SKILL.md'), 'utf8')
  for (const [prefix, id] of [
    ['clinmesh registration create ', 'registration.create'],
    ['clinmesh registration synthetic-case start ', 'registration.synthetic-case.start'],
  ] as const) {
    const line = commandLines(skill).find(line => line.startsWith(prefix))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.version).toBe(2)
    for (const code of ['REGISTRATION_NUMBER_STATE_INVALID', 'REGISTRATION_NUMBER_EXHAUSTED', 'REGISTRATION_NUMBER_AUTHORITY_RETIRED']) {
      expect(operation.summary).toContain(code)
      expect(skill).toContain(code)
    }
    expect(operation.summary).toContain('administrator recovery')
  }
  expect(skill).toContain('original intent and key')
  expect(skill).toContain('`registrationNumber`')
})

it('keeps laboratory failure recovery instructions aligned with the command catalog', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  for (const path of ['cancel', 'retry-generation']) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh laboratory-request ${path} `))!
    expect(inspectExample(program, line).operation?.id).toBe(`laboratory-request.${path}`)
  }
  const retry = getHisOperation('laboratory-request.retry-generation')
  expect(retry.version).toBe(4)
  expect(retry.summary).toContain('INVESTIGATION_TRUTH_INCOMPATIBLE')
  expect(retry.summary).toContain('MODEL_OUTCOME_UNKNOWN')
  expect(skill).toContain('INVESTIGATION_TRUTH_INCOMPATIBLE')
  expect(getHisOperation('laboratory-request.cancel').summary).toContain('generation-failed')
})

it('keeps consultation recovery examples aligned with durable attempt semantics', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  const reference = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/references/clinical-workflows.md'), 'utf8')
  for (const [path, id] of [['ask', 'encounter.consultation.ask'], ['retry-reply', 'encounter.consultation.reply.retry']] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh encounter consultation ${path} `))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.version).toBe(5)
    expect(operation.summary).toContain('deadline')
    expect(operation.summary).toContain('failed or unknown')
    expect(operation.summary).toContain('without new inference')
    for (const code of ['MODEL_CONTROL_BLOCKED', 'CONSULTATION_CASE_NOT_FOUND', 'CONSULTATION_PERSONA_OUTDATED']) {
      expect(operation.summary).toContain(code)
      expect(skill).toContain(code)
    }
    expect(operation.input.safeParse({ encounterId: 'synthetic', arbitraryPayload: {} }).success).toBe(false)
  }
  expect(getHisOperation('doctor.case.get').version).toBe(15)
  expect(getHisOperation('doctor.case.get').summary).toContain('consultation.replyAttempt')
  expect(skill).toContain('consultation.replyAttempt')
  expect(skill).toContain('same ask/retry key')
  expect(skill).toContain('`blocked` reply can resume')
  expect(reference).toContain('MODEL_CONTROL_BLOCKED')
  expect(reference).toContain('never automatically resends an `unknown` request')
  expect(reference).toContain('original `deadlineAt` and model')
  expect(reference).toContain('restart does not automatically answer')
  expect(reference).toContain('Never resend the doctor message as a new intent')
  expect(reference).toContain('no published recommendation CLI command')
})

it('keeps signing review and cancellation examples aligned with the narrow operation contracts', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  const reference = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/references/clinical-workflows.md'), 'utf8')
  for (const [suffix, version] of [['preview', 5], ['commit', 4], ['cancel', 2]] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh encounter clinical-document sign ${suffix}`))!
    expect(inspectExample(program, line).operation?.version).toBe(version)
  }
  const cancel = getHisOperation('encounter.clinical-document.sign.cancel')
  expect(cancel.skill).toBe('clinmesh-doctor')
  expect(cancel.commandOperation).toBe('clinical-document.cancel-sign')
  expect(cancel.summary).toContain('a valid cancel-only Agent Grant')
  expect(skill).toContain('A valid cancel-only Agent Grant')
  expect(skill).toContain('Recovery remains bound to that exact Grant')
  expect(cancel.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview' }).success).toBe(true)
  expect(cancel.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview', document: {} }).success).toBe(false)
  const commit = getHisOperation('encounter.clinical-document.sign')
  expect(commit.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview', commitToken: 'synthetic-commit-token', }).success).toBe(true)
  expect(reference).not.toContain('consultationReviewed')
  expect(reference).toContain('consultationRecording.signingPreparation')
  expect(reference).toContain('even without automatic recording')
  expect(getHisOperation('encounter.clinical-document.sign.preview').summary).toContain('even without automatic recording')
})

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
  it('keeps document quality examples narrow and separate from clinical draft writes', async () => {
    const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    for (const action of ['get', 'check', 'retain']) {
      const operation = getHisOperation(`doctor.document-quality.${action}`)
      const line = commandLines(skill).find(line => line.startsWith(`clinmesh doctor document-quality ${action}`))!
      expect(line).toBeDefined()
      expect(inspectExample(program, line).operation?.id).toBe(operation.id)
      expect(operation.skill).toBe('clinmesh-doctor')
    }
    const check = getHisOperation('doctor.document-quality.check')
    const context = { caseId: 'synthetic-case', encounterId: 'synthetic-encounter', encounterVersion: '3' }
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0 }).success).toBe(true)
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0, clientId: 'editor-1' }).success).toBe(false)
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0, url: 'https://example.invalid' }).success).toBe(false)
    const retain = getHisOperation('doctor.document-quality.retain')
    expect(retain.input.safeParse({ ...context, issueId: 'synthetic-issue', expectedInputFingerprint: 'a'.repeat(64) }).success).toBe(true)
    expect(retain.input.safeParse({ ...context, issueId: 'synthetic-issue' }).success).toBe(false)
    expect(skill).toContain('does not save the clinical draft')
    expect(skill).toContain('explicit clinician decision')
    expect(skill).toContain('does not add a signing gate')
    const get = getHisOperation('doctor.document-quality.get')
    const failed = { caseId: 'synthetic-case', encounterId: 'synthetic-encounter', draftVersion: 1, generation: 1,
      inputFingerprint: 'a'.repeat(64), documentFingerprint: 'b'.repeat(64), status: 'failed', stale: false,
      issues: [], notices: [], errorCode: 'AI_RESPONSE_INVALID', failure: { stage: 'generation', reason: 'invalid-source' } }
    expect(get.output.safeParse(failed).success).toBe(true)
    expect(get.output.safeParse({ ...failed, failure: { ...failed.failure, rawContent: 'private model text' } }).success).toBe(false)
    expect(skill).toContain('failure.stage')
    expect(skill).toContain('refresh: true')
  })
  it('keeps document examples aligned with optional family and allergy history', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
    const document = { assessment: '继续评估。', chiefComplaint: '头晕一周。', disposition: '门诊随访。',
      followUp: '加重时就诊。', historyOfPresentIllness: '站立时头晕。', physicalExamination: '神志清楚。' }
    for (const [prefix, version, input] of [
      ['clinmesh encounter clinical-document draft set', 5, { encounterId: 'synthetic', encounterVersion: '1', expectedDraftVersion: 0 }],
      ['clinmesh clinical-document revise', 2, { compositionId: 'synthetic', compositionVersion: '1', encounterId: 'synthetic', encounterVersion: '1', reason: '补充病史。' }],
    ] as const) {
      const line = commandLines(skill).find(line => line.startsWith(prefix))!
      const operation = inspectExample(program, line).operation!
      expect(operation.version).toBe(version)
      expect(operation.input.safeParse({ ...input, document }).success).toBe(true)
      expect(operation.input.safeParse({ ...input, document: { ...document, familyHistory: '', allergyHistory: '' } }).success).toBe(true)
      expect(operation.input.safeParse({ ...input, document: { ...document, familyHistory: '史'.repeat(4001) } }).success).toBe(false)
      expect(operation.summary).toContain('familyHistory')
    }
    expect(skill).toContain('`familyHistory`')
    expect(skill).toContain('`allergyHistory`')
    expect(skill).toContain('不创建正式 AllergyIntolerance')
  })
  it('keeps recording controls narrow, versioned and bound to the doctor skill', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const operation = getHisOperation('encounter.consultation-recording.control')
    const line = commandLines(skill).find(line => line.startsWith('clinmesh encounter consultation-recording control'))!
    expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(operation.id)
    for (const action of ['activate', 'pause', 'resume', 'backfill', 'retry']) {
      expect(operation.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '3', expectedRecordingVersion: 1, action }).success).toBe(true)
    }
    expect(operation.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '3', action: 'resume', document: {} }).success).toBe(false)
    expect(skill).toContain('processedCount')
    expect(skill).toContain('explicitly starts it')
    expect(operation.version).toBe(6)
    expect(operation.summary).toContain('backfill requires an existing Consultation')
    expect(operation.summary).toContain('WORKFLOW_CONFLICT')
    expect(operation.summary).toContain('retired semantic checks cannot be retried')
    expect(operation.summary).toContain('MODEL_OUTCOME_UNKNOWN')
    expect(skill).toContain('`MODEL_OUTCOME_UNKNOWN` stops automatic resending')
    const read = getHisOperation('doctor.case.get')
    expect(read.version).toBe(15)
    expect(read.summary).toContain('sourceResults')
    expect(read.summary).toContain('legacy verification counts are zero and issues empty')
    expect(skill).toContain('Retry actual recording failures')
    expect(skill).toContain('existing `qualityControl`')
    expect(skill).toContain('Backfill requires an existing Consultation')
    expect(skill).toContain('WORKFLOW_CONFLICT')
  })
  it('does not expose removed history review commands or signing acknowledgement', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    expect(skill).not.toContain('clinmesh encounter consultation-history review')
    expect(skill).toContain('recorded directly')
    expect(() => getHisOperation('encounter.consultation-history.review')).toThrow()
    const sign = getHisOperation('encounter.clinical-document.sign')
    expect(sign.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '1', commitToken: 'synthetic-sign-commit-token', previewId: 'synthetic-preview', consultationReviewed: true }).success).toBe(false)
  })
  it('keeps the doctor draft example compatible with incomplete content and the versioned Catalog', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const operation = getHisOperation('encounter.clinical-document.draft.set')
    expect(operation.version).toBe(5)
    expect(skill).toContain('empty fields')
    expect(skill).toContain('including whitespace and punctuation')
    expect(operation.summary).toContain('whitespace is preserved exactly')
    expect(skill).toContain('consultationRecording')
    expect(skill).toContain('hasSavedDraft')
    expect(getHisOperation('doctor.case.get').summary).toContain('hasSavedDraft')
    expect(skill).toContain('consultationRecording.failures')
    expect(getHisOperation('doctor.case.get').summary).toContain('failures')
    const line = commandLines(skill).find(line => line.startsWith('clinmesh encounter clinical-document draft set'))!
    expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(operation.id)
    const parsed = operation.input.parse({ encounterId: 'synthetic-encounter', encounterVersion: '3', expectedDraftVersion: 0,
      document: { chiefComplaint: ' 头晕一周 ', historyOfPresentIllness: '', physicalExamination: '',
        assessment: '', disposition: '', followUp: '' },
    })
    expect(parsed).toMatchObject({ document: { chiefComplaint: ' 头晕一周 ' } })
  })
  it('documents missing visit numbers and triage in the versioned doctor read contracts', async () => {
    const doctorSkill = await readFile(resolve(
      import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md',
    ), 'utf8')
    for (const id of ['doctor.queue.list', 'doctor.case.get']) {
      const operation = getHisOperation(id)
      expect(operation.version).toBe(id === 'doctor.case.get' ? 15 : 3)
      expect(operation.summary).toContain('presentation')
      expect(operation.summary).toContain('registrationNumber')
      const line = commandLines(doctorSkill).find(line => line.startsWith(id === 'doctor.case.get' ? 'clinmesh doctor case get ' : 'clinmesh doctor queue list'))!
      expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(id)
      for (const registrationNumber of ['CM-OP-20261020-1234567', 'CM-OP-20260824-0042', null]) {
        const parsed = operation.output.safeParse(id === 'doctor.queue.list' ? { items: [{ registrationNumber }] } : { registrationNumber })
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path.includes('registrationNumber'))).toBe(false)
      }
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
    expect(doctorSkill).toContain('`registrationNumber`')
    expect(doctorSkill).toContain('`patient.identifier`')
  })

  it('keeps correlation recovery guidance aligned with the Catalog error schema', async () => {
    const sharedSkill = await readFile(resolve(
      import.meta.dirname,
      '../../../skills/clinmesh-shared/SKILL.md',
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
      import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md',
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
    const skillsRoot = resolve(import.meta.dirname, '../../../skills')
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
