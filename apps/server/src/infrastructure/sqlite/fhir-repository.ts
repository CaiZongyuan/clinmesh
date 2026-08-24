import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import {
  fhirResourceSchema,
  type FhirResource,
} from '@clinmesh/contracts/fhir'
import type { ClinMeshDatabase } from './database.ts'
import {
  type FhirResourceOwnerKind,
  getResourceOwnership,
  isSupportedSearchParameter,
} from '../../fhir/capabilities.ts'

export interface RepositoryContext {
  epoch: string
  workspaceId: string
}

interface FhirRepositoryOptions {
  cursorSecret?: string
  now?: () => Date
}

interface StoredResourceRow {
  content_json: string
  last_updated: string
  owner_kind: FhirResourceOwnerKind
  resource_id: string
  version_id: number
}

export interface FhirSearchPage {
  nextCursor?: string
  resources: FhirResource[]
  total?: number
}

interface SearchCursor {
  epoch: string
  expiresAt: number
  lastUpdated: string
  queryHash: string
  resourceId: string
  resourceType: string
  workspaceId: string
}

export class FhirRepositoryError extends Error {
  readonly code: 'CONFLICT' | 'INVALID' | 'NOT_FOUND' | 'NOT_SUPPORTED'

  constructor(code: 'CONFLICT' | 'INVALID' | 'NOT_FOUND' | 'NOT_SUPPORTED', message: string) {
    super(message)
    this.name = 'FhirRepositoryError'
    this.code = code
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseStoredResource(content: string): FhirResource {
  return fhirResourceSchema.parse(JSON.parse(content))
}

export class FhirRepository {
  readonly #cursorSecret: string | undefined
  readonly #database: ClinMeshDatabase
  readonly #now: () => Date

  constructor(database: ClinMeshDatabase, options: FhirRepositoryOptions = {}) {
    this.#database = database
    this.#cursorSecret = options.cursorSecret
    this.#now = options.now ?? (() => new Date())
  }

  create(context: RepositoryContext, input: FhirResource): FhirResource {
    return this.#create(context, input, 'fhir-native')
  }

  createProjection(context: RepositoryContext, input: FhirResource): FhirResource {
    return this.#create(context, input, 'domain-projection')
  }

  createImmutable(context: RepositoryContext, input: FhirResource): FhirResource {
    return this.#create(context, input, 'fhir-native-immutable')
  }

  #create(
    context: RepositoryContext,
    input: FhirResource,
    ownerKind: FhirResourceOwnerKind,
  ): FhirResource {
    const resource = fhirResourceSchema.parse(input)
    if (getResourceOwnership(resource.resourceType) !== ownerKind) {
      throw new FhirRepositoryError(
        'NOT_SUPPORTED',
        `${resource.resourceType} cannot be created through the ${ownerKind} write path`,
      )
    }
    const existing = this.#currentRow(context, resource.resourceType, resource.id)
    if (existing !== undefined) {
      throw new FhirRepositoryError('CONFLICT', `${resource.resourceType}/${resource.id} already exists`)
    }
    return this.#write(context, resource, 1, ownerKind)
  }

  update(
    context: RepositoryContext,
    input: FhirResource,
    expectedVersion: string,
  ): FhirResource {
    return this.#update(context, input, expectedVersion, 'fhir-native')
  }

  updateProjection(
    context: RepositoryContext,
    input: FhirResource,
    expectedVersion: string,
  ): FhirResource {
    return this.#update(context, input, expectedVersion, 'domain-projection')
  }

  #update(
    context: RepositoryContext,
    input: FhirResource,
    expectedVersion: string,
    ownerKind: FhirResourceOwnerKind,
  ): FhirResource {
    const resource = fhirResourceSchema.parse(input)
    const existing = this.#currentRow(context, resource.resourceType, resource.id)
    if (existing === undefined) {
      throw new FhirRepositoryError('NOT_FOUND', `${resource.resourceType}/${resource.id} was not found`)
    }
    if (existing.owner_kind !== ownerKind) {
      throw new FhirRepositoryError(
        'NOT_SUPPORTED',
        `${resource.resourceType}/${resource.id} is owned by ${existing.owner_kind}`,
      )
    }
    if (String(existing.version_id) !== expectedVersion) {
      throw new FhirRepositoryError('CONFLICT', `Expected version ${expectedVersion} but found ${existing.version_id}`)
    }
    return this.#write(context, resource, existing.version_id + 1, ownerKind)
  }

  read(context: RepositoryContext, resourceType: string, resourceId: string): FhirResource {
    const row = this.#currentRow(context, resourceType, resourceId)
    if (row === undefined) {
      throw new FhirRepositoryError('NOT_FOUND', `${resourceType}/${resourceId} was not found`)
    }
    return parseStoredResource(row.content_json)
  }

  vread(
    context: RepositoryContext,
    resourceType: string,
    resourceId: string,
    versionId: string,
  ): FhirResource {
    const row = this.#database.driver.prepare(`
      SELECT content_json
      FROM fhir_history
      WHERE workspace_id = ?
        AND epoch = ?
        AND resource_type = ?
        AND resource_id = ?
        AND version_id = ?
        AND deleted = 0
    `).get(context.workspaceId, context.epoch, resourceType, resourceId, Number(versionId)) as {
      content_json: string
    } | undefined
    if (row === undefined) {
      throw new FhirRepositoryError('NOT_FOUND', `${resourceType}/${resourceId}/_history/${versionId} was not found`)
    }
    return parseStoredResource(row.content_json)
  }

  history(context: RepositoryContext, resourceType: string, resourceId: string): FhirResource[] {
    const rows = this.#database.driver.prepare(`
      SELECT content_json
      FROM fhir_history
      WHERE workspace_id = ?
        AND epoch = ?
        AND resource_type = ?
        AND resource_id = ?
        AND deleted = 0
      ORDER BY version_id DESC
    `).all(context.workspaceId, context.epoch, resourceType, resourceId) as Array<{
      content_json: string
    }>
    return rows.map(row => parseStoredResource(row.content_json))
  }

  search(
    context: RepositoryContext,
    resourceType: string,
    parameters: URLSearchParams,
  ): FhirSearchPage {
    const allowedControlParameters = new Set(['_count', '_cursor', '_total'])
    for (const parameter of parameters.keys()) {
      if (!allowedControlParameters.has(parameter) && !isSupportedSearchParameter(resourceType, parameter)) {
        throw new FhirRepositoryError('NOT_SUPPORTED', `Search parameter ${parameter} is not supported for ${resourceType}`)
      }
    }

    const countValue = parameters.get('_count') ?? '20'
    if (!/^\d+$/.test(countValue)) {
      throw new FhirRepositoryError('INVALID', '_count must be an integer')
    }
    const count = Number(countValue)
    if (count < 1 || count > 100) {
      throw new FhirRepositoryError('INVALID', '_count must be between 1 and 100')
    }
    const totalMode = parameters.get('_total') ?? 'none'
    if (totalMode !== 'none' && totalMode !== 'accurate') {
      throw new FhirRepositoryError('INVALID', '_total must be none or accurate')
    }

    const normalizedQuery = [...parameters.entries()]
      .filter(([key]) => key !== '_cursor')
      .toSorted(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ))
    const queryHash = contentHash(JSON.stringify(normalizedQuery))
    const cursorValue = parameters.get('_cursor')
    const cursor = cursorValue === null
      ? undefined
      : this.#parseCursor(cursorValue, context, resourceType, queryHash)
    const conditions = [
      'resource.workspace_id = ?',
      'resource.epoch = ?',
      'resource.resource_type = ?',
      'resource.deleted = 0',
    ]
    const bindings: Array<number | string> = [context.workspaceId, context.epoch, resourceType]

    for (const [parameter, value] of parameters.entries()) {
      if (allowedControlParameters.has(parameter)) continue
      const normalized = value.normalize('NFKC').toLocaleLowerCase()
      conditions.push(`EXISTS (
        SELECT 1
        FROM fhir_sp_string AS search_string
        WHERE search_string.workspace_id = resource.workspace_id
          AND search_string.epoch = resource.epoch
          AND search_string.resource_type = resource.resource_type
          AND search_string.resource_id = resource.resource_id
          AND search_string.param = ?
          AND search_string.normalized ${parameter === 'name' ? "LIKE ? ESCAPE '\\'" : '= ?'}
      )`)
      bindings.push(parameter)
      bindings.push(parameter === 'name'
        ? `${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
        : normalized)
    }
    if (cursor !== undefined) {
      conditions.push('(resource.last_updated < ? OR (resource.last_updated = ? AND resource.resource_id > ?))')
      bindings.push(cursor.lastUpdated, cursor.lastUpdated, cursor.resourceId)
    }

    const where = conditions.join('\n AND ')
    const rows = this.#database.driver.prepare(`
      SELECT resource.content_json, resource.last_updated, resource.resource_id, resource.version_id
      FROM fhir_resource AS resource
      WHERE ${where}
      ORDER BY resource.last_updated DESC, resource.resource_id ASC
      LIMIT ?
    `).all(...bindings, count + 1) as StoredResourceRow[]
    const hasNextPage = rows.length > count
    const pageRows = hasNextPage ? rows.slice(0, count) : rows
    const result: FhirSearchPage = {
      resources: pageRows.map(row => parseStoredResource(row.content_json)),
    }

    if (totalMode === 'accurate') {
      const totalConditions = conditions.filter(condition => !condition.startsWith('(resource.last_updated <'))
      const totalBindings = cursor === undefined ? bindings : bindings.slice(0, -3)
      const totalRow = this.#database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM fhir_resource AS resource
        WHERE ${totalConditions.join('\n AND ')}
      `).get(...totalBindings) as { count: number }
      result.total = totalRow.count
    }

    const lastRow = pageRows.at(-1)
    if (hasNextPage && lastRow !== undefined) {
      result.nextCursor = this.#createCursor({
        epoch: context.epoch,
        expiresAt: Date.now() + 5 * 60_000,
        lastUpdated: lastRow.last_updated,
        queryHash,
        resourceId: lastRow.resource_id,
        resourceType,
        workspaceId: context.workspaceId,
      })
    }
    return result
  }

  #currentRow(
    context: RepositoryContext,
    resourceType: string,
    resourceId: string,
  ): StoredResourceRow | undefined {
    return this.#database.driver.prepare(`
      SELECT content_json, last_updated, owner_kind, resource_id, version_id
      FROM fhir_resource
      WHERE workspace_id = ?
        AND epoch = ?
        AND resource_type = ?
        AND resource_id = ?
        AND deleted = 0
    `).get(context.workspaceId, context.epoch, resourceType, resourceId) as StoredResourceRow | undefined
  }

  #write(
    context: RepositoryContext,
    resource: FhirResource,
    versionId: number,
    ownerKind: FhirResourceOwnerKind,
  ): FhirResource {
    const committed = fhirResourceSchema.parse({
      ...resource,
      meta: {
        ...resource.meta,
        lastUpdated: this.#now().toISOString(),
        versionId: String(versionId),
      },
    })
    const content = JSON.stringify(committed)
    const parameters = [
      context.workspaceId,
      context.epoch,
      committed.resourceType,
      committed.id,
      versionId,
      committed.meta?.lastUpdated,
      ownerKind,
      content,
      contentHash(content),
    ] as const

    const ownsTransaction = !this.#database.driver.inTransaction
    if (ownsTransaction) this.#database.driver.exec('BEGIN IMMEDIATE')
    try {
      this.#database.driver.prepare(`
        INSERT INTO fhir_history (
          workspace_id, epoch, resource_type, resource_id, version_id,
          last_updated, owner_kind, content_json, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...parameters)
      this.#database.driver.prepare(`
        INSERT INTO fhir_resource (
          workspace_id, epoch, resource_type, resource_id, version_id,
          last_updated, owner_kind, content_json, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, resource_type, resource_id)
        DO UPDATE SET
          version_id = excluded.version_id,
          last_updated = excluded.last_updated,
          owner_kind = excluded.owner_kind,
          deleted = 0,
          content_json = excluded.content_json,
          content_hash = excluded.content_hash
      `).run(...parameters)
      this.#replaceSearchIndexes(context, committed)
      if (ownsTransaction) this.#database.driver.exec('COMMIT')
      return committed
    } catch (error) {
      if (ownsTransaction && this.#database.driver.inTransaction) {
        this.#database.driver.exec('ROLLBACK')
      }
      throw error
    }
  }

  #replaceSearchIndexes(context: RepositoryContext, resource: FhirResource): void {
    this.#database.driver.prepare(`
      DELETE FROM fhir_sp_string
      WHERE workspace_id = ? AND epoch = ? AND resource_type = ? AND resource_id = ?
    `).run(context.workspaceId, context.epoch, resource.resourceType, resource.id)
    const insert = this.#database.driver.prepare(`
      INSERT OR IGNORE INTO fhir_sp_string (
        workspace_id, epoch, resource_type, resource_id, param, normalized, exact_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    if (resource.resourceType === 'AllergyIntolerance') {
      const patient = typeof resource.patient === 'object' && resource.patient !== null
        ? (resource.patient as Record<string, unknown>).reference
        : undefined
      if (typeof patient === 'string') {
        insert.run(
          context.workspaceId,
          context.epoch,
          resource.resourceType,
          resource.id,
          'patient',
          patient.normalize('NFKC').toLocaleLowerCase(),
          patient,
        )
      }
      return
    }
    if (resource.resourceType !== 'Patient') return

    const names: unknown[] = Array.isArray(resource.name) ? resource.name : []
    for (const candidate of names) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const name = candidate as Record<string, unknown>
      const values = [
        typeof name.text === 'string' ? name.text : undefined,
        typeof name.family === 'string' ? name.family : undefined,
        ...(Array.isArray(name.given)
          ? name.given.filter((value: unknown): value is string => typeof value === 'string')
          : []),
      ].filter((value): value is string => value !== undefined && value.length > 0)
      for (const value of values) {
        insert.run(
          context.workspaceId,
          context.epoch,
          resource.resourceType,
          resource.id,
          'name',
          value.normalize('NFKC').toLocaleLowerCase(),
          value,
        )
      }
    }
    const identifiers: unknown[] = Array.isArray(resource.identifier) ? resource.identifier : []
    for (const candidate of identifiers) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const value = (candidate as Record<string, unknown>).value
      if (typeof value !== 'string' || value.length === 0) continue
      insert.run(
        context.workspaceId,
        context.epoch,
        resource.resourceType,
        resource.id,
        'identifier',
        value.normalize('NFKC').toLocaleLowerCase(),
        value,
      )
    }
  }

  #createCursor(cursor: SearchCursor): string {
    if (this.#cursorSecret === undefined) {
      throw new FhirRepositoryError('INVALID', 'Search cursor secret is not configured')
    }
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    const signature = createHmac('sha256', this.#cursorSecret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  #parseCursor(
    value: string,
    context: RepositoryContext,
    resourceType: string,
    queryHash: string,
  ): SearchCursor {
    if (this.#cursorSecret === undefined) {
      throw new FhirRepositoryError('INVALID', 'Search cursor secret is not configured')
    }
    const [payload, signature, extra] = value.split('.')
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new FhirRepositoryError('INVALID', 'Search cursor is malformed')
    }
    const expected = createHmac('sha256', this.#cursorSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new FhirRepositoryError('INVALID', 'Search cursor signature is invalid')
    }

    let cursor: SearchCursor
    try {
      cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SearchCursor
    } catch {
      throw new FhirRepositoryError('INVALID', 'Search cursor payload is invalid')
    }
    if (
      cursor.workspaceId !== context.workspaceId
      || cursor.epoch !== context.epoch
      || cursor.resourceType !== resourceType
      || cursor.queryHash !== queryHash
      || cursor.expiresAt < Date.now()
    ) {
      throw new FhirRepositoryError('INVALID', 'Search cursor does not match the active context')
    }
    return cursor
  }
}
