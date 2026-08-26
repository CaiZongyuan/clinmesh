import { createHash, randomUUID } from 'node:crypto'
import {
  scenarioDatasetContentSchema,
  scenarioDatasetSchema,
  type ScenarioDataset,
  type ScenarioGenerationRequest,
} from '@clinmesh/contracts/scenario'
import { scenarioStateSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import type { ScenarioDatasetRepository } from '../../infrastructure/sqlite/scenario-dataset-repository.ts'
import type { ActorContext, CommandExecutor, CommandResponse } from '../command-executor.ts'
import type { ScenarioGenerationProvider } from './provider.ts'
import { validateScenarioDataset } from './scenario-dataset-validator.ts'
import type { ScenarioService } from '../scenario-service.ts'

const scenarioDatasetInstallResultSchema = z.object({
  packageId: z.string().min(1),
  scenario: scenarioStateSchema,
}).strict()

const scenarioDatasetDeleteResultSchema = z.object({
  datasetId: z.string().min(1),
  deleted: z.literal(true),
}).strict()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]))
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export class ScenarioDataError extends Error {
  readonly code: 'DATASET_INVALID' | 'DATASET_NOT_FOUND' | 'DATASET_VERSION_CONFLICT' | 'PROVIDER_NOT_AVAILABLE' | 'ROLE_NOT_ALLOWED'
  readonly status: 403 | 404 | 409 | 503

  constructor(
    code: 'DATASET_INVALID' | 'DATASET_NOT_FOUND' | 'DATASET_VERSION_CONFLICT' | 'PROVIDER_NOT_AVAILABLE' | 'ROLE_NOT_ALLOWED',
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioDataError'
    this.code = code
    if (code === 'ROLE_NOT_ALLOWED') this.status = 403
    else if (code === 'DATASET_NOT_FOUND') this.status = 404
    else if (code === 'PROVIDER_NOT_AVAILABLE') this.status = 503
    else this.status = 409
  }
}

export class ScenarioDataService {
  readonly #commands: CommandExecutor
  readonly #providers: ReadonlyMap<string, ScenarioGenerationProvider>
  readonly #repository: ScenarioDatasetRepository
  readonly #scenario: ScenarioService

  constructor(input: {
    commands: CommandExecutor
    providers: ReadonlyMap<string, ScenarioGenerationProvider>
    repository: ScenarioDatasetRepository
    scenario: ScenarioService
  }) {
    this.#commands = input.commands
    this.#providers = input.providers
    this.#repository = input.repository
    this.#scenario = input.scenario
  }

  async capabilities(context: ActorContext) {
    this.#assertAdministrator(context)
    return {
      items: await Promise.all([...this.#providers.values()].map(provider => provider.capabilities())),
    }
  }

  async generate(input: {
    context: ActorContext
    idempotencyKey: string
    request: ScenarioGenerationRequest
  }): Promise<CommandResponse<ScenarioDataset>> {
    this.#assertAdministrator(input.context)
    const provider = this.#providers.get(input.request.providerId)
    if (provider === undefined) {
      throw new ScenarioDataError('PROVIDER_NOT_AVAILABLE', 'The requested Scenario Provider is not available')
    }
    const capabilities = await provider.capabilities()
    if (!capabilities.available) {
      throw new ScenarioDataError(
        'PROVIDER_NOT_AVAILABLE',
        capabilities.unavailableReason ?? 'The requested Scenario Provider is unavailable',
      )
    }
    const corpus = await provider.generate(input.request)
    const content = scenarioDatasetContentSchema.parse(corpus.content)
    const now = new Date().toISOString()
    const dataset: ScenarioDataset = {
      content,
      contentHash: contentHash(content),
      createdAt: now,
      datasetId: `scenario-dataset-${randomUUID()}`,
      diagnostics: [],
      name: input.request.name,
      providerId: input.request.providerId,
      updatedAt: now,
      version: 1,
      workspaceId: input.context.workspaceId,
    }
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: input.request,
      operation: 'scenario-dataset.generate',
    }, () => {
      this.#repository.create(dataset, input.context.actorId)
      return {
        data: dataset,
        effects: [{
          kind: 'created',
          reference: `ScenarioDataset/${dataset.datasetId}`,
          versionId: '1',
        }],
      }
    })
  }

  get(context: ActorContext, datasetId: string): ScenarioDataset {
    this.#assertAdministrator(context)
    return this.#getDataset(context.workspaceId, datasetId)
  }

  delete(input: {
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    const dataset = this.#getDataset(input.context.workspaceId, input.datasetId)
    this.#assertExpectedVersion(dataset, input.expectedVersion)
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetDeleteResultSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { datasetId: input.datasetId, expectedVersion: input.expectedVersion },
      operation: 'scenario-dataset.delete',
    }, () => {
      if (!this.#repository.delete(
        input.context.workspaceId,
        input.datasetId,
        input.expectedVersion,
      )) {
        throw new ScenarioDataError('DATASET_VERSION_CONFLICT', 'The Scenario Dataset changed after it was loaded')
      }
      return {
        data: { datasetId: input.datasetId, deleted: true as const },
        effects: [{
          kind: 'updated',
          reference: `ScenarioDataset/${input.datasetId}`,
          versionId: String(input.expectedVersion),
        }],
      }
    })
  }

  list(context: ActorContext, input: { page: number; pageSize: number }) {
    this.#assertAdministrator(context)
    return this.#repository.list({ ...input, workspaceId: context.workspaceId })
  }

  install(input: {
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
  }) {
    this.#assertAdministrator(input.context)
    const dataset = this.#getDataset(input.context.workspaceId, input.datasetId)
    this.#assertExpectedVersion(dataset, input.expectedVersion)
    this.#assertInstallable(dataset)
    const packageId = `scenario-package-${randomUUID()}`
    const createdAt = new Date().toISOString()
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetInstallResultSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: { datasetId: input.datasetId, expectedVersion: input.expectedVersion },
      operation: 'scenario-dataset.install',
    }, () => {
      const current = this.#getDataset(input.context.workspaceId, input.datasetId)
      this.#assertExpectedVersion(current, input.expectedVersion)
      this.#assertInstallable(current)
      this.#repository.createPackage({
        actorId: input.context.actorId,
        createdAt,
        dataset: current,
        packageId,
      })
      const installed = this.#scenario.installPackage({
        content: current.content,
        context: input.context,
        packageId,
        version: current.version,
      })
      return {
        data: { packageId, scenario: installed.data },
        effects: [{
          kind: 'created',
          reference: `ScenarioPackage/${packageId}`,
          versionId: '1',
        }, ...installed.effects],
      }
    })
  }

  update(input: {
    content: ScenarioDataset['content']
    context: ActorContext
    datasetId: string
    expectedVersion: number
    idempotencyKey: string
    name: string
  }): CommandResponse<ScenarioDataset> {
    this.#assertAdministrator(input.context)
    const current = this.#getDataset(input.context.workspaceId, input.datasetId)
    const now = new Date().toISOString()
    const content = scenarioDatasetContentSchema.parse(input.content)
    const updated: ScenarioDataset = {
      ...current,
      content,
      contentHash: contentHash(content),
      diagnostics: validateScenarioDataset(content),
      name: input.name,
      updatedAt: now,
      version: input.expectedVersion + 1,
    }
    return this.#commands.execute({
      context: input.context,
      contextRequirement: 'current',
      dataSchema: scenarioDatasetSchema,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: 'workspace',
      input: {
        content: input.content,
        datasetId: input.datasetId,
        expectedVersion: input.expectedVersion,
        name: input.name,
      },
      operation: 'scenario-dataset.update',
    }, () => {
      if (!this.#repository.update(updated, input.expectedVersion)) {
        throw new ScenarioDataError(
          'DATASET_VERSION_CONFLICT',
          'The Scenario Dataset changed after it was loaded',
        )
      }
      return {
        data: updated,
        effects: [{
          kind: 'updated',
          reference: `ScenarioDataset/${input.datasetId}`,
          versionId: String(updated.version),
        }],
      }
    })
  }

  #assertAdministrator(context: ActorContext): void {
    if (context.roleCode !== 'administrator') {
      throw new ScenarioDataError('ROLE_NOT_ALLOWED', 'Only an administrator can manage Scenario Datasets')
    }
  }

  #assertExpectedVersion(dataset: ScenarioDataset, expectedVersion: number): void {
    if (dataset.version !== expectedVersion) {
      throw new ScenarioDataError('DATASET_VERSION_CONFLICT', 'The Scenario Dataset changed after it was loaded')
    }
  }

  #assertInstallable(dataset: ScenarioDataset): void {
    if (dataset.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new ScenarioDataError('DATASET_INVALID', 'The Scenario Dataset has errors and cannot be installed')
    }
  }

  #getDataset(workspaceId: string, datasetId: string): ScenarioDataset {
    const dataset = this.#repository.get(workspaceId, datasetId)
    if (dataset === undefined) {
      throw new ScenarioDataError('DATASET_NOT_FOUND', 'The Scenario Dataset was not found')
    }
    return dataset
  }
}
