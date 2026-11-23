import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'
import { z } from 'zod'
import { pathologyReadingConfigSchema, pathologyReadingSessionSchema, pathologyReadingSessionStateSchema,
  pathologyReadingStatusSchema, readingAuthorizationInputSchema, readingBindingSchema, readingContextSchema, readingSessionCreatedSchema,
  type PathologyReadingConfig, type PathologyReadingMessage, type PathologyReadingSessionInput } from '@clinmesh/contracts/pathology-reading'
import type { PathologyReport, PathologyRequest } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { PathJxAdapter, PathologyReadingError, type PathologyReadingDeployment } from '../infrastructure/pathology-reading/pathjx-adapter.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { IdentityService } from './identity-service.ts'
import { externalPathologyAssetOutputSchema } from '@clinmesh/contracts/pathology'
import type { ExternalPathologyAsset } from './pathology-external-catalog.ts'

interface ReadingAccess {
  caseId: string
  encounterId: string
  request: PathologyRequest
  report: PathologyReport
  assetId: string
  assetOutput: unknown
  writable: boolean
}

const externalOutput = externalPathologyAssetOutputSchema
const sessionRowSchema = z.object({ id: z.uuid(), workspace_id: z.string(), epoch: z.string(), actor_id: z.string(),
  auth_session_id: z.string(), idempotency_key: z.string(), request_hash: z.string(), binding_id: z.string(),
  head_report_id: z.string(), head_report_version: z.string(),
  context_json: z.string(), actor_json: z.string(), generation: z.uuid(), config_version: z.number(), callback_token_hash: z.string(),
  expires_at: z.string(), displayed: z.number(), closed: z.number(), remote_json: z.string().nullable() })
type SessionRow = z.infer<typeof sessionRowSchema>
const actorSchema = z.object({ actorId: z.string(), workspaceId: z.string(), epoch: z.string(), roleCode: z.string(),
  scenarioRunId: z.string(), practitionerId: z.string().optional(), practitionerRoleId: z.string().optional(),
  organizationId: z.string().optional(), locationId: z.string().optional() }).strict()

export class PathologyReadingService {
  private readonly now: () => Date
  private readonly sealKey: Buffer
  constructor(private readonly options: { database: ClinMeshDatabase; commands: CommandExecutor; identity: IdentityService;
    access: (context: ActorContext, requestId: string, reportId?: string) => ReadingAccess | undefined;
    deployment?: PathologyReadingDeployment; secret: string; now?: () => Date }) {
    this.now = options.now ?? (() => new Date())
    this.sealKey = createHash('sha256').update(options.secret).digest()
  }

  private administrator(context: ActorContext) {
    if (context.roleCode !== 'administrator' || context.agentGrantId !== undefined) {
      throw new PathologyReadingError('ROLE_NOT_ALLOWED', 'An administrator human session is required', 403)
    }
  }

  config(workspaceId: string): PathologyReadingConfig | null {
    const row = z.object({ config_json: z.string() }).optional().parse(this.options.database.driver.prepare(
      'SELECT config_json FROM pathology_reading_config WHERE workspace_id = ?').get(workspaceId))
    return row === undefined ? null : pathologyReadingConfigSchema.parse(JSON.parse(row.config_json))
  }

  async status(context: ActorContext) {
    this.administrator(context)
    const config = this.config(context.workspaceId)
    if (config === null) return pathologyReadingStatusSchema.parse({ state: 'not-configured', config, capabilities: [] })
    if (!config.enabled) return pathologyReadingStatusSchema.parse({ state: 'disabled', config, capabilities: [] })
    if (!this.options.deployment?.serviceToken) return pathologyReadingStatusSchema.parse({ state: 'credentials-unavailable', config, capabilities: [] })
    try {
      const response = await this.adapter(config).capabilities()
      const repair = this.options.database.driver.prepare("SELECT 1 FROM pathology_reading_binding WHERE workspace_id=? AND state='repair-required' LIMIT 1").get(context.workspaceId)
      return pathologyReadingStatusSchema.parse({ state: repair ? 'repair-required' : 'ready', config, capabilities: response.capabilities })
    } catch (error) {
      if (!(error instanceof PathologyReadingError)) throw error
      return pathologyReadingStatusSchema.parse({ state: error.code.includes('PROTOCOL') || error.code.includes('INSTANCE') ? 'incompatible' : 'offline', config, capabilities: [] })
    }
  }

  configure(context: ActorContext, input: Omit<PathologyReadingConfig, 'version'> & { expectedVersion: number }, idempotencyKey: string) {
    this.administrator(context)
    if (input.enabled && !this.options.deployment?.serviceToken) {
      throw new PathologyReadingError('PATHOLOGY_READING_CREDENTIALS_UNAVAILABLE', 'Reading service deployment credentials are not configured')
    }
    const { expectedVersion, ...settings } = input
    const next = pathologyReadingConfigSchema.parse({ ...settings, version: expectedVersion + 1 })
    if (input.enabled) this.adapter(next)
    return this.options.commands.execute({ context, contextRequirement: 'current', idempotencyScope: 'workspace',
      dataSchema: pathologyReadingConfigSchema, expectedVersions: {}, idempotencyKey, input, operation: 'pathology-reading.configure' }, () => {
      if ((this.config(context.workspaceId)?.version ?? 0) !== input.expectedVersion) {
        throw new PathologyReadingError('EXPECTED_VERSION_CONFLICT', 'The reading service configuration changed')
      }
      this.options.database.driver.prepare(`INSERT INTO pathology_reading_config (workspace_id, version, config_json) VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version, config_json=excluded.config_json`)
        .run(context.workspaceId, next.version, JSON.stringify(next))
      this.options.database.driver.prepare('UPDATE pathology_reading_session SET closed=1, displayed=0 WHERE workspace_id=?').run(context.workspaceId)
      return { data: next, effects: [] }
    }).data
  }

  private adapter(config: PathologyReadingConfig) {
    if (!this.options.deployment?.serviceToken) throw new PathologyReadingError('PATHOLOGY_READING_CREDENTIALS_UNAVAILABLE', 'Reading deployment credentials are unavailable')
    return new PathJxAdapter(config, this.options.deployment)
  }

  private enabled(workspaceId: string) {
    const config = this.config(workspaceId)
    if (!config?.enabled) throw new PathologyReadingError('PATHOLOGY_READING_DISABLED', 'The reading service is not enabled', 503)
    return config
  }

  private requiredAccess(context: ActorContext, requestId: string, reportId?: string) {
    if (context.roleCode !== 'outpatient-doctor' || context.agentGrantId !== undefined) {
      throw new PathologyReadingError('ROLE_NOT_ALLOWED', 'Only a currently authorized human doctor can open this slide', 403)
    }
    const access = this.options.access(context, requestId, reportId)
    if (access === undefined) throw new PathologyReadingError('PATHOLOGY_READING_NOT_FOUND', 'The pathology report was not found', 404)
    return access
  }

  async assetAvailable(workspaceId: string, asset: ExternalPathologyAsset): Promise<boolean> {
    try {
      const config = this.enabled(workspaceId)
      if (config.instanceId !== asset.output.instanceId) return false
      const response = await this.adapter(config).asset(asset.output.assetKey)
      return response.available && response.contentHash === asset.output.contentHash && response.organ === asset.output.organ
        && response.specimenType === asset.output.specimenType && response.stain === asset.output.stain
    } catch { return false }
  }

  private requireCheckpoint(bindingId: string, revision: number) {
    const row = z.object({ state: z.string(), remote_revision: z.number().nullable() }).parse(this.options.database.driver.prepare(
      'SELECT state,remote_revision FROM pathology_reading_binding WHERE binding_id=?').get(bindingId))
    if (row.state === 'repair-required' || row.remote_revision !== revision) {
      this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='repair-required' WHERE binding_id=?").run(bindingId)
      throw new PathologyReadingError('PATHOLOGY_READING_REPAIR_REQUIRED', 'The reading service history does not match the confirmed checkpoint')
    }
  }

  private async readable(bindingId: string, config: PathologyReadingConfig) {
    const remote = await this.adapter(config).binding(bindingId).catch(error => {
      if (error instanceof PathologyReadingError && error.code === 'PATHOLOGY_READING_OBJECT_MISSING') {
        this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='repair-required' WHERE binding_id=?").run(bindingId)
        throw new PathologyReadingError('PATHOLOGY_READING_REPAIR_REQUIRED', 'The original reading object is missing')
      }
      throw error
    })
    const local = z.object({ content_hash: z.string(), instance_id: z.string() }).parse(this.options.database.driver.prepare(
      'SELECT content_hash,instance_id FROM pathology_reading_binding WHERE binding_id=?').get(bindingId))
    if (remote.bindingId !== bindingId || remote.contentHash !== local.content_hash || remote.instanceId !== local.instance_id) {
      this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='repair-required' WHERE binding_id=?").run(bindingId)
      throw new PathologyReadingError('PATHOLOGY_READING_REPAIR_REQUIRED', 'The original reading object cannot be verified')
    }
    this.requireCheckpoint(bindingId, remote.revision)
    if (!remote.available) throw new PathologyReadingError('IMAGING_STUDY_UNAVAILABLE', 'The bound slide is currently unreadable', 503)
    return remote
  }


  private row(id: string) {
    const row = sessionRowSchema.optional().parse(this.options.database.driver.prepare('SELECT * FROM pathology_reading_session WHERE id=?').get(id))
    if (row === undefined) throw new PathologyReadingError('PATHOLOGY_READING_NOT_FOUND', 'The reading session was not found', 404)
    return row
  }

  private scopedRow(context: ActorContext, id: string) {
    const row = this.row(id)
    if (row.workspace_id !== context.workspaceId || row.epoch !== context.epoch || row.actor_id !== context.actorId) {
      throw new PathologyReadingError('PATHOLOGY_READING_NOT_FOUND', 'The reading session was not found', 404)
    }
    return row
  }

  private callbackToken(id: string) { return createHmac('sha256', this.sealKey).update(`reading-authorization:${id}`).digest('base64url') }
  private seal(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.sealKey, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return JSON.stringify({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), body: encrypted.toString('base64url') })
  }
  private unseal(value: string) {
    const sealed = z.object({ iv: z.string(), tag: z.string(), body: z.string() }).strict().parse(JSON.parse(value))
    const decipher = createDecipheriv('aes-256-gcm', this.sealKey, Buffer.from(sealed.iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.body, 'base64url')), decipher.final()]).toString('utf8')) as unknown
  }

  async open(context: ActorContext, authSessionId: string, requestId: string, input: PathologyReadingSessionInput, idempotencyKey: string) {
    const access = this.requiredAccess(context, requestId, input.reportId), report = access.report
    if (access.request.version !== input.requestVersion || report.diagnosticReportId !== input.reportId || report.diagnosticReportVersion !== input.reportVersion) {
      throw new PathologyReadingError('PATHOLOGY_READING_VERSION_CONFLICT', 'The pathology report or request changed')
    }
    const output = externalOutput.safeParse(access.assetOutput)
    if (!output.success) throw new PathologyReadingError('PATHOLOGY_READING_LOCAL_SLIDE', 'This report uses the local slide viewer')
    const config = this.enabled(context.workspaceId), adapter = this.adapter(config)
    if (input.parentOrigin === config.viewerOrigin) throw new PathologyReadingError('PATHOLOGY_READING_ORIGIN_UNTRUSTED', 'The embedded viewer must use an origin isolated from ClinMesh', 403)
    if (output.data.instanceId !== config.instanceId) throw new PathologyReadingError('PATHOLOGY_READING_ORIGINAL_SERVICE_UNAVAILABLE', 'The original reading service is not enabled', 503)
    await adapter.capabilities()
    const bindingId = uuidv5(`${context.workspaceId}:${context.epoch}:${requestId}:${config.instanceId}`, uuidv5.URL)
    const boundContext = readingContextSchema.parse({ workspaceId: context.workspaceId, epochId: context.epoch,
      encounterId: access.encounterId, requestId, reportId: input.reportId, reportVersion: input.reportVersion })
    const hash = createHash('sha256').update(JSON.stringify({ input, requestId, authSessionId, configVersion: config.version })).digest('hex')
    const sameIntent = sessionRowSchema.optional().parse(this.options.database.driver.prepare(
      'SELECT * FROM pathology_reading_session WHERE workspace_id=? AND epoch=? AND actor_id=? AND idempotency_key=?')
      .get(context.workspaceId, context.epoch, context.actorId, idempotencyKey))
    if (sameIntent && sameIntent.request_hash !== hash) throw new PathologyReadingError('IDEMPOTENCY_KEY_REUSED', 'The reading intent was already used with a different input')
    const existing = sameIntent ?? sessionRowSchema.optional().parse(this.options.database.driver.prepare(`SELECT * FROM pathology_reading_session
      WHERE workspace_id=? AND epoch=? AND actor_id=? AND auth_session_id=? AND binding_id=? AND config_version=?
        AND closed=0 AND remote_json IS NULL AND expires_at>?
        AND json_extract(context_json,'$.reportId')=? AND json_extract(context_json,'$.reportVersion')=?
      ORDER BY expires_at LIMIT 1`).get(context.workspaceId, context.epoch, context.actorId, authSessionId, bindingId,
      config.version, this.now().toISOString(), input.reportId, input.reportVersion))
    if (existing?.remote_json !== null && existing?.remote_json !== undefined) {
      if (!(await this.authorize(this.callbackToken(existing.id))).active) throw new PathologyReadingError('PATHOLOGY_READING_CONTEXT_CHANGED', 'The reading context has changed', 403)
      await this.readable(existing.binding_id, config)
      return this.response(existing, config, access.writable)
    }
    const sessionId = existing?.id ?? randomUUID(), expiresAt = existing?.expires_at ?? new Date(this.now().getTime() + 5 * 60_000).toISOString()
    if (!existing) this.options.commands.execute({ context, dataSchema: z.object({ id: z.uuid() }).strict(), expectedVersions: {}, idempotencyKey,
      input: { ...input, authSessionId, requestId }, operation: 'pathology-reading.open' }, () => {
      this.options.database.driver.prepare(`INSERT INTO pathology_reading_session (id,workspace_id,epoch,actor_id,auth_session_id,idempotency_key,
        request_hash,binding_id,head_report_id,head_report_version,context_json,actor_json,generation,config_version,callback_token_hash,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sessionId, context.workspaceId, context.epoch, context.actorId, authSessionId, idempotencyKey, hash, bindingId,
          access.request.report!.diagnosticReportId, access.request.report!.diagnosticReportVersion,
          JSON.stringify(boundContext), JSON.stringify(context), input.generation, config.version,
          createHash('sha256').update(this.callbackToken(sessionId)).digest('hex'), expiresAt)
      return { data: { id: sessionId }, effects: [] }
    })
    const bindInput = { bindingId, intentId: bindingId, contentHash: output.data.contentHash, assetKey: output.data.assetKey,
      context: boundContext, organ: output.data.organ, specimenType: output.data.specimenType, stain: output.data.stain }
    const bindingRow = z.object({ remote_json: z.string().nullable(), state: z.string() }).optional().parse(this.options.database.driver.prepare(
      'SELECT remote_json,state FROM pathology_reading_binding WHERE binding_id=?').get(bindingId))
    if (!bindingRow) this.options.database.driver.prepare(`INSERT INTO pathology_reading_binding
      (workspace_id,epoch,request_id,binding_id,instance_id,content_hash,input_json,state) VALUES (?,?,?,?,?,?,?,'prepared')`)
      .run(context.workspaceId, context.epoch, requestId, bindingId, config.instanceId, output.data.contentHash, JSON.stringify(bindInput))
    if (bindingRow?.state === 'repair-required') throw new PathologyReadingError('PATHOLOGY_READING_REPAIR_REQUIRED', 'The original binding requires recovery')
    if (!bindingRow?.remote_json) {
      try {
        if (bindingRow?.state === 'unknown') {
          const original = await adapter.operation(bindingId, bindingId)
          if (original.status === 'unknown') throw new PathologyReadingError('PATHOLOGY_READING_RESULT_UNKNOWN', 'The original binding outcome is unknown', 503, 'unknown')
          if (original.status === 'applied') {
            const result = readingBindingSchema.parse(original.result)
            if (result.bindingId !== bindingId || result.instanceId !== config.instanceId || result.contentHash !== output.data.contentHash) {
              throw new PathologyReadingError('PATHOLOGY_READING_BINDING_MISMATCH', 'The original reading binding does not match')
            }
            this.options.database.driver.prepare("UPDATE pathology_reading_binding SET remote_json=?,state='ready' WHERE binding_id=?").run(JSON.stringify(result), bindingId)
          } else await this.bind(adapter, bindInput)
        } else await this.bind(adapter, bindInput)
      } catch (error) {
        this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='unknown' WHERE binding_id=?").run(bindingId)
        throw error
      }
    }
    const checkpoint = z.object({ remote_revision: z.number().nullable() }).parse(this.options.database.driver.prepare(
      'SELECT remote_revision FROM pathology_reading_binding WHERE binding_id=?').get(bindingId))
    if (checkpoint.remote_revision === null) {
      const initial = await adapter.binding(bindingId)
      if (initial.bindingId !== bindingId || initial.revision !== 0 || initial.contentHash !== output.data.contentHash || initial.instanceId !== config.instanceId) {
        this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='repair-required' WHERE binding_id=?").run(bindingId)
        throw new PathologyReadingError('PATHOLOGY_READING_REPAIR_REQUIRED', 'The initial reading checkpoint cannot be verified')
      }
      if (!initial.available) {
        throw new PathologyReadingError('IMAGING_STUDY_UNAVAILABLE', 'The original slide cannot be verified', 503)
      }
      this.options.database.driver.prepare('UPDATE pathology_reading_binding SET remote_revision=? WHERE binding_id=? AND remote_revision IS NULL').run(initial.revision, bindingId)
    } else await this.readable(bindingId, config)
    let remote: z.infer<typeof readingSessionCreatedSchema>
    if (existing) {
      const original = await adapter.operation(sessionId, bindingId)
      if (original.status === 'unknown') throw new PathologyReadingError('PATHOLOGY_READING_RESULT_UNKNOWN', 'The original reading intent is unresolved', 503, 'unknown')
      remote = original.status === 'applied' ? readingSessionCreatedSchema.parse(original.result)
        : await adapter.createSession({ intentId: sessionId, bindingId, actor: { id: context.actorId, displayName: context.practitionerId ?? context.actorId },
          context: boundContext, writable: access.writable, parentOrigin: input.parentOrigin, expiresAt, authorizationToken: this.callbackToken(sessionId) })
    } else remote = await adapter.createSession({ intentId: sessionId, bindingId, actor: { id: context.actorId, displayName: context.practitionerId ?? context.actorId },
      context: boundContext, writable: access.writable, parentOrigin: input.parentOrigin, expiresAt, authorizationToken: this.callbackToken(sessionId) })
    if (Date.parse(remote.expiresAt) > Date.parse(expiresAt)) throw new PathologyReadingError('PATHOLOGY_READING_PROTOCOL_INVALID', 'The external session exceeds the authorized lifetime', 502)
    const active = await this.authorize(this.callbackToken(sessionId))
    if (!active.active) throw new PathologyReadingError('PATHOLOGY_READING_CONTEXT_CHANGED', 'The reading context has changed', 403)
    this.options.database.driver.prepare('UPDATE pathology_reading_session SET remote_json=? WHERE id=?').run(this.seal(remote), sessionId)
    return this.response(this.row(sessionId), config, access.writable)
  }

  private async bind(adapter: PathJxAdapter, input: Parameters<PathJxAdapter['bind']>[0]) {
    const remote = await adapter.bind(input)
    this.options.database.driver.prepare("UPDATE pathology_reading_binding SET remote_json=?,state='ready' WHERE binding_id=?").run(JSON.stringify(remote), input.bindingId)
  }

  private response(row: SessionRow, config: PathologyReadingConfig, writable: boolean) {
    if (row.closed || row.expires_at <= this.now().toISOString()) throw new PathologyReadingError('PATHOLOGY_READING_SESSION_EXPIRED', 'Reopen the current reading session', 403)
    const remote = readingSessionCreatedSchema.parse(this.unseal(row.remote_json!)), context = readingContextSchema.parse(JSON.parse(row.context_json))
    return pathologyReadingSessionSchema.parse({ id: row.id, sessionId: remote.sessionId, requestId: context.requestId, reportId: context.reportId,
      reportVersion: context.reportVersion, generation: row.generation, viewerUrl: `${config.viewerOrigin}${remote.viewerPath}`, viewerOrigin: config.viewerOrigin,
      launchToken: remote.launchToken, expiresAt: remote.expiresAt, writable })
  }

  async authorize(token: string, event?: z.infer<typeof readingAuthorizationInputSchema>) {
    const row = sessionRowSchema.optional().parse(this.options.database.driver.prepare('SELECT * FROM pathology_reading_session WHERE callback_token_hash=?')
      .get(createHash('sha256').update(token).digest('hex')))
    if (!row || row.closed || row.expires_at <= this.now().toISOString()) return { active: false, writable: false }
    const stored = actorSchema.parse(JSON.parse(row.actor_json)), bound = readingContextSchema.parse(JSON.parse(row.context_json))
    const context: ActorContext = { actorId: stored.actorId, workspaceId: stored.workspaceId, epoch: stored.epoch,
      roleCode: stored.roleCode, scenarioRunId: stored.scenarioRunId,
      ...(stored.practitionerId === undefined ? {} : { practitionerId: stored.practitionerId }),
      ...(stored.practitionerRoleId === undefined ? {} : { practitionerRoleId: stored.practitionerRoleId }),
      ...(stored.organizationId === undefined ? {} : { organizationId: stored.organizationId }),
      ...(stored.locationId === undefined ? {} : { locationId: stored.locationId }) }
    const config = this.config(row.workspace_id)
    if (!config?.enabled || config.version !== row.config_version || !this.options.identity.humanSessionCurrent(row.auth_session_id, context)) return { active: false, writable: false }
    const binding = z.object({ state: z.string() }).optional().parse(this.options.database.driver.prepare(
      'SELECT state FROM pathology_reading_binding WHERE binding_id=?').get(row.binding_id))
    if (!binding || binding.state === 'repair-required') return { active: false, writable: false }
    try {
      const access = this.requiredAccess(context, bound.requestId, bound.reportId), report = access.report
      const active = report.diagnosticReportId === bound.reportId && report.diagnosticReportVersion === bound.reportVersion
        && access.request.report?.diagnosticReportId === row.head_report_id && access.request.report.diagnosticReportVersion === row.head_report_version
      if (!active) return { active: false, writable: false }
      if (event) {
        if (event.bindingId !== row.binding_id) return { active: false, writable: false }
        if (event.event === 'authorize') {
          this.requireCheckpoint(row.binding_id, event.revision)
          if (event.intentId !== undefined && active && access.writable) {
            this.options.database.driver.prepare(`INSERT INTO pathology_reading_checkpoint_intent
              (binding_id,intent_id,previous_revision) VALUES (?,?,?) ON CONFLICT(binding_id,intent_id) DO NOTHING`)
              .run(row.binding_id, event.intentId, event.revision)
          }
        } else {
          const original = z.object({ previous_revision: z.number(), confirmed_revision: z.number().nullable() }).optional().parse(
            this.options.database.driver.prepare('SELECT previous_revision,confirmed_revision FROM pathology_reading_checkpoint_intent WHERE binding_id=? AND intent_id=?')
              .get(row.binding_id, event.intentId))
          if (!original || original.previous_revision !== event.previousRevision || event.revision < event.previousRevision
            || (original.confirmed_revision !== null && original.confirmed_revision !== event.revision)) {
            this.options.database.driver.prepare("UPDATE pathology_reading_binding SET state='repair-required' WHERE binding_id=?").run(row.binding_id)
            return { active: false, writable: false }
          }
          if (original.confirmed_revision === null) {
            this.requireCheckpoint(row.binding_id, event.previousRevision)
            this.options.database.driver.transaction(() => {
              this.options.database.driver.prepare('UPDATE pathology_reading_checkpoint_intent SET confirmed_revision=? WHERE binding_id=? AND intent_id=?')
                .run(event.revision, row.binding_id, event.intentId)
              this.options.database.driver.prepare('UPDATE pathology_reading_binding SET remote_revision=? WHERE binding_id=?').run(event.revision, row.binding_id)
            })()
          }
        }
      }
      return { active, writable: active && access.writable }
    } catch { return { active: false, writable: false } }
  }

  async state(context: ActorContext, id: string) {
    const row = this.scopedRow(context, id), active = await this.authorize(this.callbackToken(row.id))
    return pathologyReadingSessionStateSchema.parse({ id, ...active, displayed: active.active && row.displayed === 1, expiresAt: row.expires_at })
  }

  async displayed(context: ActorContext, id: string, message: PathologyReadingMessage) {
    const row = this.scopedRow(context, id), config = this.enabled(context.workspaceId)
    const original = this.response(row, config, false)
    for (const key of ['sessionId', 'requestId', 'reportId', 'reportVersion', 'generation'] as const) {
      if (message[key] !== original[key]) throw new PathologyReadingError('PATHOLOGY_READING_EVENT_INVALID', 'The reading event belongs to another context', 403)
    }
    const active = await this.authorize(this.callbackToken(id))
    if (!active.active || message.type !== 'displayed') throw new PathologyReadingError('PATHOLOGY_READING_CONTEXT_CHANGED', 'The reading context is no longer active', 403)
    await this.readable(row.binding_id, config)
    this.options.database.driver.prepare('UPDATE pathology_reading_session SET displayed=1 WHERE id=? AND closed=0').run(id)
    return this.state(context, id)
  }

  async acknowledgementAvailable(context: ActorContext, requestId: string, reportId: string) {
    const access = this.options.access(context, requestId, reportId)
    if (!access) return undefined
    const rows = z.array(sessionRowSchema).parse(this.options.database.driver.prepare(`SELECT * FROM pathology_reading_session
      WHERE workspace_id=? AND epoch=? AND actor_id=? AND displayed=1 AND closed=0`)
      .all(context.workspaceId, context.epoch, context.actorId))
    for (const row of rows) {
      const bound = readingContextSchema.parse(JSON.parse(row.context_json))
      if (bound.requestId !== requestId || bound.reportId !== reportId) continue
      if (!(await this.authorize(this.callbackToken(row.id))).active) continue
      try { await this.readable(row.binding_id, this.enabled(context.workspaceId)); return true } catch { return false }
    }
    return false
  }

  async close(context: ActorContext, id: string, idempotencyKey: string) {
    const row = this.scopedRow(context, id)
    this.options.commands.execute({ context, contextRequirement: 'current', dataSchema: z.object({ id: z.uuid() }).strict(), expectedVersions: {},
      idempotencyKey, input: { id }, operation: 'pathology-reading.close' }, () => {
      this.options.database.driver.prepare('UPDATE pathology_reading_session SET closed=1,displayed=0 WHERE id=?').run(id)
      return { data: { id }, effects: [] }
    })
    const config = this.config(context.workspaceId)
    if (row.remote_json && config?.enabled) {
      const remote = readingSessionCreatedSchema.parse(this.unseal(row.remote_json))
      try { await this.adapter(config).closeSession(remote.sessionId) } catch { /* Local revocation also rejects every authorization callback. */ }
    }
    return { id, active: false, writable: false, displayed: false, expiresAt: row.expires_at }
  }
}
