import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'
import { registrationCountersHash, type RegistrationNumberCounter } from './registration-numbering.ts'

const numberSystem = 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter'
const scopeSchema = z.object({ workspace_id: z.string(), epoch: z.string() })
const auditSchema = scopeSchema.extend({
  audit_id: z.string(), sequence: z.number().int().positive(), previous_hash: z.string(), current_hash: z.string(),
  real_timestamp: z.string(), actor_id: z.string(), practitioner_id: z.string().nullable(),
  practitioner_role_id: z.string().nullable(), role_code: z.string(), operation: z.string(),
  outcome: z.enum(['failed', 'success']), request_hash: z.string(),
})
const resourceRowSchema = scopeSchema.extend({ resource_id: z.string(), content_json: z.string(), content_hash: z.string() })
const resourceSchema = z.object({
  resourceType: z.string(), id: z.string(),
  code: z.object({ text: z.string().optional() }).optional(),
  outcome: z.object({ code: z.object({ code: z.string() }) }).optional(),
  identifier: z.array(z.object({ system: z.string().optional(), value: z.string().optional() })).optional(),
  actualPeriod: z.object({ start: z.string().optional() }).optional(),
  entity: z.array(z.object({
    role: z.object({ text: z.string().optional() }).optional(),
    what: z.object({ reference: z.string().optional() }).optional(),
  })).optional(),
})

export class RegistrationNumberMigrationError extends Error {
  readonly code = 'REGISTRATION_NUMBER_HISTORY_UNVERIFIED'

  constructor() {
    super('Registration numbering history cannot be proven complete; preserve the database and its trusted issuance evidence')
    this.name = 'RegistrationNumberMigrationError'
  }
}

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new RegistrationNumberMigrationError()
}

function key(scope: { workspace_id: string; epoch: string }, id: string): string {
  return JSON.stringify([scope.workspace_id, scope.epoch, id])
}

function parseResource(row: z.infer<typeof resourceRowSchema>) {
  requireEvidence(createHash('sha256').update(row.content_json).digest('hex') === row.content_hash)
  const resource = resourceSchema.parse(JSON.parse(row.content_json))
  requireEvidence(resource.id === row.resource_id)
  return resource
}

function verifyAuditHistory(database: ClinMeshDatabase) {
  const epochs = z.array(scopeSchema).parse(database.driver.prepare('SELECT workspace_id, epoch FROM workspace_epoch').all())
  const audits: Array<z.infer<typeof auditSchema>> = []
  for (const epoch of epochs) {
    const head = z.object({ sequence: z.number().int().nonnegative(), hash: z.string() }).parse(database.driver.prepare(`
      SELECT sequence, hash FROM audit_head WHERE workspace_id = ? AND epoch = ?
    `).get(epoch.workspace_id, epoch.epoch))
    const rows = z.array(auditSchema).parse(database.driver.prepare(`
      SELECT * FROM audit_log WHERE workspace_id = ? AND epoch = ? ORDER BY sequence
    `).all(epoch.workspace_id, epoch.epoch))
    let previousHash = '0'.repeat(64)
    for (const [index, row] of rows.entries()) {
      requireEvidence(row.sequence === index + 1 && row.previous_hash === previousHash)
      const content = {
        actorId: row.actor_id, auditId: row.audit_id, operation: row.operation,
        ...(row.practitioner_id === null ? {} : { practitionerId: row.practitioner_id }),
        ...(row.practitioner_role_id === null ? {} : { practitionerRoleId: row.practitioner_role_id }),
        previousHash, requestHash: row.request_hash, roleCode: row.role_code, sequence: row.sequence, timestamp: row.real_timestamp,
      }
      const hash = createHash('sha256').update(JSON.stringify(Object.fromEntries(
        Object.entries(content).toSorted(([left], [right]) => left.localeCompare(right)),
      ))).digest('hex')
      requireEvidence(hash === row.current_hash)
      previousHash = hash
    }
    requireEvidence(head.sequence === rows.length && head.hash === previousHash)
    audits.push(...rows)
  }
  return audits
}

function verifiedLegacyCounters(database: ClinMeshDatabase): RegistrationNumberCounter[] {
  requireEvidence(z.array(z.unknown()).parse(database.driver.pragma('foreign_key_check')).length === 0)
  const audits = verifyAuditHistory(database)
  // Historical reset replay discarded its created Encounter effects. Its issuance
  // upper bound cannot be recovered merely by counting the surviving resources.
  requireEvidence(!audits.some(row => row.operation === 'scenario.reset' && row.outcome === 'success'))
  const issued = new Map<string, string>()
  const highWater = new Map<string, number>()
  const history = database.driver.prepare(`
    SELECT workspace_id, epoch, resource_id, content_json, content_hash FROM fhir_history
    WHERE workspace_id = ? AND epoch = ? AND resource_type = ? AND resource_id = ? AND version_id = 1
  `)
  for (const audit of audits) {
    const projection = parseResource(resourceRowSchema.parse(history.get(audit.workspace_id, audit.epoch, 'AuditEvent', audit.audit_id)))
    requireEvidence(projection.resourceType === 'AuditEvent')
    requireEvidence(projection.code?.text === audit.operation)
    requireEvidence(projection.outcome?.code.code === (audit.outcome === 'success' ? '0' : '8'))
    const knownIssuance = ['registration.register', 'synthetic-case.start-outpatient-visit'].includes(audit.operation)
    const encounters = projection.entity?.filter(entity => entity.role?.text === 'created' && entity.what?.reference?.startsWith('Encounter/')) ?? []
    if (audit.outcome !== 'success' || (!knownIssuance && encounters.length === 0)) continue
    requireEvidence(encounters.length === 1)
    const encounterId = encounters[0]!.what!.reference!.slice('Encounter/'.length)
    const row = resourceRowSchema.parse(history.get(audit.workspace_id, audit.epoch, 'Encounter', encounterId))
    const encounter = parseResource(row)
    requireEvidence(encounter.resourceType === 'Encounter')
    const identifiers = encounter.identifier?.filter(identifier => identifier.system === numberSystem) ?? []
    if (!knownIssuance && identifiers.length === 0) continue
    requireEvidence(knownIssuance)
    requireEvidence(identifiers.length === 1)
    const value = identifiers[0]!.value
    const match = /^CM-OP-(\d{4})(\d{2})(\d{2})-(\d+)$/.exec(value ?? '')
    requireEvidence(match !== null)
    const visitDate = z.iso.date().parse(`${match[1]}-${match[2]}-${match[3]}`)
    requireEvidence(encounter.actualPeriod?.start?.slice(0, 10) === visitDate)
    const sequence = BigInt(match[4]!)
    requireEvidence(sequence > 0n && sequence <= BigInt(Number.MAX_SAFE_INTEGER))
    const encounterKey = key(row, encounterId)
    requireEvidence(!issued.has(encounterKey))
    issued.set(encounterKey, value!)
    highWater.set(visitDate, Math.max(highWater.get(visitDate) ?? 0, Number(sequence)))
  }
  for (const table of ['fhir_history', 'fhir_resource']) {
    const rows = z.array(resourceRowSchema).parse(database.driver.prepare(`
      SELECT workspace_id, epoch, resource_id, content_json, content_hash FROM ${table} WHERE resource_type = 'Encounter'
    `).all())
    for (const row of rows) {
      const resource = parseResource(row)
      for (const identifier of resource.identifier ?? []) {
        if (identifier.system === numberSystem) requireEvidence(issued.get(key(row, row.resource_id)) === identifier.value)
      }
    }
  }
  const registrations = z.array(scopeSchema.extend({
    encounter_id: z.string(), registration_number: z.string(), visit_date: z.iso.date(),
  })).parse(database.driver.prepare('SELECT workspace_id, epoch, encounter_id, registration_number, visit_date FROM registration').all())
  for (const registration of registrations) {
    requireEvidence(issued.get(key(registration, registration.encounter_id)) === registration.registration_number)
    requireEvidence(registration.registration_number.startsWith(`CM-OP-${registration.visit_date.replaceAll('-', '')}-`))
  }
  return [...highWater].map(([visitDate, value]) => ({ visitDate, highWater: value }))
}

// Called only inside the new migration's transaction. Runtime never repairs it.
export function initializeRegistrationNumbering(database: ClinMeshDatabase): void {
  try {
    requireEvidence(database.driver.inTransaction)
    requireEvidence(database.driver.prepare('SELECT 1 FROM registration_number_authority').get() === undefined)
    requireEvidence(database.driver.prepare('SELECT 1 FROM registration_number_counter').get() === undefined)
    const counters = verifiedLegacyCounters(database)
    const insert = database.driver.prepare('INSERT INTO registration_number_counter (visit_date, high_water) VALUES (?, ?)')
    for (const counter of counters) insert.run(counter.visitDate, counter.highWater)
    database.driver.prepare(`
      INSERT INTO registration_number_authority (singleton, authority_id, status, counters_hash) VALUES (1, ?, 'active', ?)
    `).run(randomUUID(), registrationCountersHash(counters))
  } catch (error) {
    if (error instanceof RegistrationNumberMigrationError) throw error
    throw new RegistrationNumberMigrationError()
  }
}
