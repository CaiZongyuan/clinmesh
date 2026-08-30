import {
  getHisOperation,
  type HisOperationDefinition,
  listHisOperations,
} from '@clinmesh/contracts/his-operations'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import {
  agentCapabilityContextSchema,
  agentCapabilityGrantSchema,
  agentCapabilityGrantListSchema,
  agentCapabilityGrantViewSchema,
  agentClientListSchema,
  agentClientSchema,
  createAgentCapabilityGrantInputSchema,
  createAgentClientInputSchema,
  revokedAgentCapabilityGrantSchema,
} from '@clinmesh/contracts/agent'
import { Command, CommanderError, Option } from 'commander'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { ProfileStore } from './profile-store.ts'
import { HttpOperationError } from './http-executor.ts'

interface WritableStream {
  write(chunk: string): unknown
}

export interface CliIO {
  stderr: WritableStream
  stdout: WritableStream
}

export interface CliDependencies {
  authMode?: 'agent' | 'human'
  cwd?: string
  execute?: (
    operationId: string,
    input: unknown,
    context?: {
      idempotencyKey?: string
      profile?: string
    },
  ) => Promise<unknown>
  fetch?: typeof globalThis.fetch
  profiles?: ProfileStore
  readContext?: () => Promise<unknown>
  readStdin?: () => Promise<string>
}

class CliProblem extends Error {
  readonly exitCode: number
  readonly problem: {
    code: string
    conflict?: unknown
    message: string
    outcome: 'ambiguous' | 'definitely_not_sent'
    retryable: boolean
    type: string
  }

  constructor(
    exitCode: number,
    problem: CliProblem['problem'],
  ) {
    super(problem.message)
    this.name = 'CliProblem'
    this.exitCode = exitCode
    this.problem = problem
  }
}

function configProblem(code: string, message: string): CliProblem {
  return new CliProblem(3, {
    code,
    message,
    outcome: 'definitely_not_sent',
    retryable: false,
    type: 'config',
  })
}

function inputSourceProblem(message: string): CliProblem {
  return new CliProblem(2, {
    code: 'invalid_input_source',
    message,
    outcome: 'definitely_not_sent',
    retryable: false,
    type: 'validation',
  })
}

function humanProfileForbiddenProblem(message = 'Agent execution context cannot use a human profile'): CliProblem {
  return new CliProblem(3, {
    code: 'human_profile_forbidden',
    message,
    outcome: 'definitely_not_sent',
    retryable: false,
    type: 'authentication',
  })
}

function assertHumanMode(dependencies: CliDependencies | undefined): void {
  if (dependencies?.authMode === 'agent') throw humanProfileForbiddenProblem()
}

function profileStore(dependencies: CliDependencies | undefined): ProfileStore {
  if (dependencies?.profiles === undefined) {
    throw configProblem('profile_store_unavailable', 'No human profile store is configured')
  }
  return dependencies.profiles
}

interface JsonSchemaProperty {
  default?: unknown
  description?: string
  type?: string
}

interface JsonObjectSchema {
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

type SuccessWriter = (data: unknown, metadata?: Record<string, unknown>) => void

function writeJson(stream: WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`)
}

function tableCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).replaceAll(/\s+/g, ' ')
  }
  if (Array.isArray(value) && value.every(item => (
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  ))) {
    return value.join(', ')
  }
  return JSON.stringify(value)
}

function tableRows(data: unknown): Array<Record<string, unknown>> {
  let values: unknown[]
  if (Array.isArray(data)) {
    values = data
  } else if (typeof data === 'object' && data !== null) {
    values = Object.values(data as Record<string, unknown>).find(Array.isArray) ?? [data]
  } else {
    values = [data]
  }
  return values.map(value => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value }
  ))
}

function writeTable(stream: WritableStream, data: unknown): void {
  const rows = tableRows(data)
  if (rows.length === 0) {
    stream.write('(no rows)\n')
    return
  }
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].toSorted()
  const renderedRows = rows.map(row => columns.map(column => tableCell(row[column])))
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...renderedRows.map(row => row[index]?.length ?? 0),
  ))
  const render = (cells: string[]) => cells
    .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
    .join(' | ')
  stream.write(`${render(columns)}\n`)
  stream.write(`${widths.map(width => '-'.repeat(width)).join('-+-')}\n`)
  for (const row of renderedRows) stream.write(`${render(row)}\n`)
}

function writeError(
  stream: WritableStream,
  error: {
    code: string
    idempotencyKey?: string
    message: string
    operationId?: string
    outcome: 'ambiguous' | 'definitely_not_sent'
    param?: string
    retryable: boolean
    type: string
  },
): void {
  writeJson(stream, {
    error,
    ok: false,
    schemaVersion: 1,
  })
}

function serializableOperation(operation: ReturnType<typeof listHisOperations>[number]) {
  return {
    cliPath: operation.cliPath,
    id: operation.id,
    mode: operation.mode,
    risk: operation.risk,
    roles: operation.roles,
    skill: operation.skill,
    summary: operation.summary,
    version: operation.version,
  }
}

function operationSchema(operation: ReturnType<typeof getHisOperation>) {
  return {
    ...serializableOperation(operation),
    inputSchema: z.toJSONSchema(operation.input),
    outputSchema: z.toJSONSchema(operation.output),
    requirements: operation.requirements,
  }
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

function parseNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new CommanderError(1, 'clinmesh.invalidNumber', `Invalid number: ${value}`)
  return parsed
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function actionCommand(args: unknown[], name: string): Command {
  const command = args.at(-1)
  if (!(command instanceof Command)) throw new Error(`Missing ${name} command context`)
  return command
}

function optionForProperty(name: string, property: JsonSchemaProperty): Option | undefined {
  const flag = `--${kebabCase(name)}`
  const description = property.description ?? name
  let option: Option
  if (property.type === 'boolean') {
    option = new Option(flag, description)
  } else if (property.type === 'integer' || property.type === 'number') {
    option = new Option(`${flag} <number>`, description).argParser(parseNumber)
  } else if (property.type === 'string') {
    option = new Option(`${flag} <value>`, description)
  } else {
    return undefined
  }
  return option
}

function commandForPath(program: Command, path: readonly string[]): Command {
  let parent = program
  for (const segment of path) {
    let child = parent.commands.find(command => command.name() === segment)
    if (child === undefined) {
      child = parent.command(segment)
    }
    parent = child
  }
  return parent
}

async function readStdin(): Promise<string> {
  let content = ''
  for await (const chunk of process.stdin) content += String(chunk)
  return content
}

async function readStructuredInput(source: string, dependencies: CliDependencies): Promise<unknown> {
  let content: string
  try {
    if (source === '-') {
      content = await (dependencies.readStdin ?? readStdin)()
    } else {
      if (!source.startsWith('@')) throw inputSourceProblem('--input must be @<workspace-path> or -')
      const cwd = dependencies.cwd ?? process.cwd()
      const path = resolve(cwd, source.slice(1))
      const fromWorkspace = relative(cwd, path)
      if (fromWorkspace === '' || fromWorkspace.startsWith('..') || isAbsolute(fromWorkspace)) {
        throw inputSourceProblem('--input path must resolve to a file inside the current workspace')
      }
      content = await readFile(path, 'utf8')
    }
  } catch (error) {
    if (error instanceof CliProblem) throw error
    throw inputSourceProblem('The structured input could not be read')
  }
  if (Buffer.byteLength(content, 'utf8') > 1_048_576) {
    throw inputSourceProblem('--input exceeds the 1 MiB limit')
  }
  try {
    return JSON.parse(content) as unknown
  } catch {
    throw inputSourceProblem('--input must contain valid JSON')
  }
}

async function showHumanContext(
  profileName: string,
  writeSuccess: SuccessWriter,
  dependencies: CliDependencies | undefined,
): Promise<void> {
  writeSuccess(await humanQuery(
    profileName,
    '/api/auth/context',
    sessionContextSchema,
    dependencies,
  ))
}

async function humanRequest<Schema extends z.ZodType>(
  profileName: string,
  path: string,
  schema: Schema,
  dependencies: CliDependencies | undefined,
  options: { body?: unknown; method: 'GET' | 'POST' },
): Promise<z.infer<Schema>> {
  assertHumanMode(dependencies)
  const profile = await profileStore(dependencies).load(profileName)
  if (profile === undefined) {
    throw configProblem('profile_not_found', `Human profile not found: ${profileName}`)
  }
  const request = dependencies?.fetch ?? globalThis.fetch
  const mutation = options.method === 'POST'
  const response = await request(new URL(path, profile.serverUrl), {
    ...(mutation ? { body: JSON.stringify(options.body) } : {}),
    headers: {
      accept: 'application/json',
      ...(mutation ? { 'content-type': 'application/json' } : {}),
      cookie: profile.cookie,
      ...(mutation ? { origin: new URL(profile.serverUrl).origin } : {}),
    },
    method: options.method,
  })
  if (!response.ok) throw new Error(`ClinMesh control request failed with HTTP ${response.status}`)
  return schema.parse(await response.json())
}

async function humanMutation<Schema extends z.ZodType>(
  profileName: string,
  path: string,
  body: unknown,
  schema: Schema,
  dependencies: CliDependencies | undefined,
): Promise<z.infer<Schema>> {
  return humanRequest(profileName, path, schema, dependencies, { body, method: 'POST' })
}

async function humanQuery<Schema extends z.ZodType>(
  profileName: string,
  path: string,
  schema: Schema,
  dependencies: CliDependencies | undefined,
): Promise<z.infer<Schema>> {
  return humanRequest(profileName, path, schema, dependencies, { method: 'GET' })
}

function registerOperation(
  program: Command,
  operation: HisOperationDefinition,
  writeSuccess: SuccessWriter,
  dependencies: CliDependencies | undefined,
): void {
  const command = commandForPath(program, operation.cliPath).description(operation.summary)
  const inputSchema = z.toJSONSchema(operation.input) as JsonObjectSchema
  for (const [name, property] of Object.entries(inputSchema.properties ?? {})) {
    const option = optionForProperty(name, property)
    if (option !== undefined) command.addOption(option)
  }
  command.addOption(new Option('--input <source>', 'Read strict JSON input from @file or stdin (-)'))
  command.addOption(new Option('--profile <name>', 'Human authentication profile'))
  if (operation.requirements.idempotency === 'required') {
    command.addOption(
      new Option('--idempotency-key <key>', 'Stable key for this business intent').makeOptionMandatory(),
    )
  }
  if (operation.risk === 'high-risk-write') {
    command.addOption(new Option('--yes', 'Confirm this high-risk human operation'))
  }
  command.action(async (...args: unknown[]) => {
    const invoked = actionCommand(args, operation.id)
    if (dependencies?.execute === undefined) throw new Error(`No operation executor configured for ${operation.id}`)
    const options = invoked.opts<Record<string, unknown>>()
    if (
      operation.risk === 'high-risk-write'
      && dependencies.authMode !== 'agent'
      && options.yes !== true
    ) {
      throw new CliProblem(10, {
        code: 'confirmation_required',
        message: `Pass --yes to confirm ${operation.cliPath.join(' ')}`,
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'confirmation',
      })
    }
    const inputSource = typeof options.input === 'string' ? options.input : undefined
    const inputKeys = Object.keys(inputSchema.properties ?? {})
    const typedInput = Object.fromEntries(inputKeys
      .filter(key => options[key] !== undefined)
      .map(key => [key, options[key]]))
    if (inputSource !== undefined && Object.keys(typedInput).length > 0) {
      throw new Error('--input cannot be combined with typed operation flags')
    }
    const input = operation.input.parse(inputSource === undefined
      ? typedInput
      : await readStructuredInput(inputSource, dependencies))
    const idempotencyKey = typeof options.idempotencyKey === 'string'
      ? options.idempotencyKey
      : undefined
    const profile = typeof options.profile === 'string' ? options.profile : undefined
    if (dependencies.authMode === 'agent' && profile !== undefined) {
      throw humanProfileForbiddenProblem()
    }
    const executionContext = {
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(profile === undefined ? {} : { profile }),
    }
    const rawResult = Object.keys(executionContext).length === 0
      ? await dependencies.execute(operation.id, input)
      : await dependencies.execute(operation.id, input, executionContext)
    const data = operation.output.parse(rawResult)
    writeSuccess(data, {
      operation: {
        id: operation.id,
        mode: operation.mode,
        version: operation.version,
      },
    })
  })
}

export async function runCli(
  argv: readonly string[],
  io: CliIO,
  dependencies?: CliDependencies,
): Promise<number> {
  const program = new Command()
    .name('clinmesh')
    .description('Agent-native command line interface for ClinMesh')
    .addOption(
      new Option('--output <format>', 'Success output format')
        .choices(['json', 'table'])
        .default('json'),
    )
    .exitOverride()
    .configureOutput({
      outputError: () => undefined,
      writeErr: value => io.stderr.write(value),
      writeOut: value => io.stdout.write(value),
    })

  const writeSuccess: SuccessWriter = (data, metadata = {}) => {
    if (program.opts().output === 'table') {
      writeTable(io.stdout, data)
      return
    }
    writeJson(io.stdout, {
      data,
      ok: true,
      ...metadata,
      schemaVersion: 1,
    })
  }

  program.hook('preAction', () => {
    if (dependencies?.authMode === 'agent' && program.opts().output === 'table') {
      throw new CliProblem(2, {
        code: 'invalid_output_mode',
        message: 'Agent execution context requires JSON output',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      })
    }
  })

  const operations = program.command('operations').description('Inspect the HIS operation catalog')
  operations
    .command('list')
    .description('List available HIS operations')
    .action(() => {
      writeSuccess({ operations: listHisOperations().map(serializableOperation) })
    })

  const auth = program.command('auth').description('Manage ClinMesh authentication')
  auth
    .command('login')
    .description('Sign a human profile in with Better Auth')
    .requiredOption('--profile <name>', 'Profile name')
    .requiredOption('--server-url <url>', 'ClinMesh Server URL')
    .requiredOption('--email <email>', 'Human account email')
    .option('--password-stdin', 'Read the password from stdin')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'auth login')
      if (dependencies?.authMode === 'agent') {
        throw humanProfileForbiddenProblem('Agent execution context cannot create a human profile')
      }
      const profiles = profileStore(dependencies)
      if (invoked.opts().passwordStdin !== true) {
        throw new CliProblem(2, {
          code: 'invalid_input',
          message: 'Use --password-stdin to provide the password',
          outcome: 'definitely_not_sent',
          retryable: false,
          type: 'validation',
        })
      }
      const options = z.object({
        email: z.email(),
        passwordStdin: z.literal(true),
        profile: z.string().min(1),
        serverUrl: z.url(),
      }).parse(invoked.opts())
      const baseUrl = new URL(options.serverUrl)
      if (!['http:', 'https:'].includes(baseUrl.protocol)) {
        throw new Error('ClinMesh Server URL must use HTTP or HTTPS')
      }
      const password = await (dependencies?.readStdin ?? readStdin)()
      const normalizedPassword = password.replace(/\r?\n$/, '')
      if (normalizedPassword.length === 0) {
        throw new CliProblem(2, {
          code: 'invalid_input',
          message: 'The stdin password is empty',
          outcome: 'definitely_not_sent',
          retryable: false,
          type: 'validation',
        })
      }
      const request = dependencies?.fetch ?? globalThis.fetch
      const response = await request(new URL('/api/auth/sign-in/email', baseUrl), {
        body: JSON.stringify({ email: options.email, password: normalizedPassword }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: baseUrl.origin,
        },
        method: 'POST',
      })
      if (!response.ok) throw new Error(`ClinMesh login failed with HTTP ${response.status}`)
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
      if (cookie === undefined || cookie === '') throw new Error('ClinMesh login returned no session cookie')
      await profiles.save(options.profile, {
        cookie,
        serverUrl: baseUrl.origin,
      })
      writeSuccess({
        authMode: 'human',
        profile: options.profile,
        serverUrl: baseUrl.origin,
      })
    })
  auth
    .command('status')
    .description('Read and validate the current human session context')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'auth status')
      await showHumanContext(String(invoked.opts().profile), writeSuccess, dependencies)
    })
  auth
    .command('logout')
    .description('End the Better Auth session and remove its human profile')
    .requiredOption('--profile <name>', 'Human profile')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'auth logout')
      const profile = z.string().min(1).parse(invoked.opts().profile)
      await humanMutation(
        profile,
        '/api/auth/sign-out',
        {},
        z.object({}).loose(),
        dependencies,
      )
      await profileStore(dependencies).remove(profile)
      writeSuccess({ profile, status: 'signed-out' })
    })
  const authRole = auth.command('role').description('Select the acting Practitioner Role')
  authRole
    .command('use')
    .description('Switch one human session to a granted Practitioner Role')
    .requiredOption('--profile <name>', 'Human profile')
    .requiredOption('--practitioner-role-id <id>', 'Practitioner Role ID')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'auth role use')
      const options = z.object({
        practitionerRoleId: z.string().min(1),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const data = await humanMutation(
        options.profile,
        '/api/auth/role',
        { practitionerRoleId: options.practitionerRoleId },
        sessionContextSchema,
        dependencies,
      )
      writeSuccess(data)
    })

  const context = program.command('context').description('Inspect the trusted ClinMesh context')
  context
    .command('show')
    .description('Show the current Actor, Workspace, Epoch, Scenario Run, and Practitioner Role')
    .option('--profile <name>', 'Human profile')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'context show')
      const profile = invoked.opts().profile
      if (dependencies?.authMode === 'agent') {
        if (profile !== undefined) {
          throw new CliProblem(2, {
            code: 'invalid_input',
            message: 'Agent context cannot use a human profile',
            outcome: 'definitely_not_sent',
            retryable: false,
            type: 'validation',
          })
        }
        if (dependencies.readContext === undefined) throw new Error('No Agent context reader configured')
        const data = agentCapabilityContextSchema.parse(await dependencies.readContext())
        writeSuccess(data)
        return
      }
      if (typeof profile !== 'string') {
        throw new CliProblem(2, {
          code: 'invalid_input',
          message: 'Human context requires --profile',
          outcome: 'definitely_not_sent',
          retryable: false,
          type: 'validation',
        })
      }
      await showHumanContext(profile, writeSuccess, dependencies)
    })

  const agent = program.command('agent').description('Manage Agent Clients and Capability Grants')
  const agentClient = agent.command('client').description('Manage Agent Clients')
  agentClient
    .command('list')
    .description('List Agent Clients as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Client list')
      const profile = z.string().min(1).parse(invoked.opts().profile)
      const data = await humanQuery(
        profile,
        '/api/agent/v1/clients',
        agentClientListSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentClient
    .command('get')
    .description('View one Agent Client as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--agent-client-id <id>', 'Agent Client ID')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Client get')
      const options = z.object({
        agentClientId: z.uuid(),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const data = await humanQuery(
        options.profile,
        `/api/agent/v1/clients/${encodeURIComponent(options.agentClientId)}`,
        agentClientSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentClient
    .command('create')
    .description('Create an Agent Client as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--name <name>', 'Agent Client name')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Client create')
      const options = z.object({
        name: z.string(),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const input = createAgentClientInputSchema.parse({ name: options.name })
      const data = await humanMutation(
        options.profile,
        '/api/agent/v1/clients',
        input,
        agentClientSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentClient
    .command('disable')
    .description('Disable an Agent Client as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--agent-client-id <id>', 'Agent Client ID')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Client disable')
      const options = z.object({
        agentClientId: z.uuid(),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const data = await humanMutation(
        options.profile,
        `/api/agent/v1/clients/${encodeURIComponent(options.agentClientId)}/actions/disable`,
        {},
        agentClientSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  const agentGrant = agent.command('grant').description('Manage Agent Capability Grants')
  agentGrant
    .command('list')
    .description('List Agent Capability Grants as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Grant list')
      const profile = z.string().min(1).parse(invoked.opts().profile)
      const data = await humanQuery(
        profile,
        '/api/agent/v1/grants',
        agentCapabilityGrantListSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentGrant
    .command('get')
    .description('View one Agent Capability Grant as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--grant-id <id>', 'Agent Capability Grant ID')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Grant get')
      const options = z.object({
        grantId: z.uuid(),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const data = await humanQuery(
        options.profile,
        `/api/agent/v1/grants/${encodeURIComponent(options.grantId)}`,
        agentCapabilityGrantViewSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentGrant
    .command('create')
    .description('Mint a role-bound task token as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--agent-client-id <id>', 'Agent Client ID')
    .requiredOption('--practitioner-role-id <id>', 'Practitioner Role ID')
    .addOption(
      new Option('--operation <id>', 'Allowed HIS operation (repeatable)')
        .argParser(collect)
        .default([])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option('--ttl-seconds <seconds>', 'Grant lifetime in seconds')
        .argParser(parseNumber)
        .makeOptionMandatory(),
    )
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Grant create')
      const options = z.object({
        agentClientId: z.string(),
        operation: z.array(z.string()),
        practitionerRoleId: z.string(),
        profile: z.string().min(1),
        ttlSeconds: z.number(),
      }).parse(invoked.opts())
      for (const operationId of options.operation) getHisOperation(operationId)
      const input = createAgentCapabilityGrantInputSchema.parse({
        agentClientId: options.agentClientId,
        operationIds: options.operation,
        practitionerRoleId: options.practitionerRoleId,
        ttlSeconds: options.ttlSeconds,
      })
      const data = await humanMutation(
        options.profile,
        '/api/agent/v1/grants',
        input,
        agentCapabilityGrantSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  agentGrant
    .command('revoke')
    .description('Revoke an Agent Capability Grant as a human administrator')
    .requiredOption('--profile <name>', 'Human administrator profile')
    .requiredOption('--grant-id <id>', 'Agent Capability Grant ID')
    .action(async (...args: unknown[]) => {
      const invoked = actionCommand(args, 'Agent Grant revoke')
      const options = z.object({
        grantId: z.uuid(),
        profile: z.string().min(1),
      }).parse(invoked.opts())
      const data = await humanMutation(
        options.profile,
        `/api/agent/v1/grants/${encodeURIComponent(options.grantId)}/actions/revoke`,
        {},
        revokedAgentCapabilityGrantSchema,
        dependencies,
      )
      writeSuccess(data)
    })
  operations
    .command('schema')
    .description('Show the machine-readable contract for one HIS operation')
    .argument('<operation-id>')
    .action((operationId: string) => {
      writeSuccess({ operation: operationSchema(getHisOperation(operationId)) })
    })

  for (const operation of listHisOperations()) {
    registerOperation(program, operation, writeSuccess, dependencies)
  }

  try {
    await program.parseAsync([...argv], { from: 'user' })
    return 0
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        return 0
      }
      writeError(io.stderr, {
        code: 'invalid_command',
        message: error.message,
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      })
      return 2
    }
    if (error instanceof CliProblem) {
      writeError(io.stderr, error.problem)
      return error.exitCode
    }
    if (error instanceof HttpOperationError) {
      writeError(io.stderr, error.problem)
      return error.exitCode
    }
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]
      writeError(io.stderr, {
        code: 'invalid_input',
        message: issue?.message ?? 'The operation input is invalid',
        outcome: 'definitely_not_sent',
        ...(issue === undefined || issue.path.length === 0
          ? {}
          : { param: issue.path.join('.') }),
        retryable: false,
        type: 'validation',
      })
      return 2
    }
    writeError(io.stderr, {
      code: 'cli_failure',
      message: 'ClinMesh CLI could not complete the request',
      outcome: 'definitely_not_sent',
      retryable: false,
      type: 'internal',
    })
    return 1
  }
}
