import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ClinMeshDatabase } from './database.ts'

const counterSchema = z.object({ visitDate: z.iso.date(), highWater: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
const authoritySchema = z.object({
  authorityId: z.uuid(),
  countersHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'retired']),
}).strict()

export interface RegistrationNumberCounter {
  visitDate: string
  highWater: number
}

export class RegistrationNumberError extends Error {
  readonly code: 'REGISTRATION_NUMBER_STATE_INVALID' | 'REGISTRATION_NUMBER_EXHAUSTED' | 'REGISTRATION_NUMBER_AUTHORITY_RETIRED'
  readonly status = 409

  constructor(code: RegistrationNumberError['code'], message: string) {
    super(message)
    this.name = 'RegistrationNumberError'
    this.code = code
  }
}

export function registrationCountersHash(counters: RegistrationNumberCounter[]): string {
  return createHash('sha256').update(JSON.stringify(counters.toSorted((a, b) => a.visitDate.localeCompare(b.visitDate)))).digest('hex')
}

export function readRegistrationNumberState(database: ClinMeshDatabase, options: { allowRetired?: boolean } = {}) {
  try {
    const authority = authoritySchema.parse(database.driver.prepare(`
      SELECT authority_id AS authorityId, status, counters_hash AS countersHash
      FROM registration_number_authority WHERE singleton = 1
    `).get())
    const counters = z.array(counterSchema).parse(database.driver.prepare(`
      SELECT visit_date AS visitDate, high_water AS highWater
      FROM registration_number_counter ORDER BY visit_date
    `).all())
    if (registrationCountersHash(counters) !== authority.countersHash) {
      throw new Error('Registration counter manifest does not match')
    }
    if (authority.status === 'retired' && options.allowRetired !== true) {
      throw new RegistrationNumberError('REGISTRATION_NUMBER_AUTHORITY_RETIRED', 'Registration issuance is disabled for this retired authority')
    }
    return { authorityId: authority.authorityId, status: authority.status, counters }
  } catch (error) {
    if (error instanceof RegistrationNumberError) throw error
    throw new RegistrationNumberError('REGISTRATION_NUMBER_STATE_INVALID', 'Registration issuance state is missing or corrupt; preserve the database and verify its trusted history')
  }
}

// The caller owns the Command's BEGIN IMMEDIATE transaction, including its receipt.
export function allocateRegistrationNumber(database: ClinMeshDatabase, visitDate: string): string {
  if (!database.driver.inTransaction) throw new Error('Registration issuance requires a write transaction')
  const date = z.iso.date().safeParse(visitDate)
  if (!date.success) throw new RegistrationNumberError('REGISTRATION_NUMBER_STATE_INVALID', 'Registration visit date is invalid')
  const state = readRegistrationNumberState(database)
  const counter = state.counters.find(entry => entry.visitDate === date.data)
  const previous = counter?.highWater ?? 0
  if (previous >= Number.MAX_SAFE_INTEGER) {
    throw new RegistrationNumberError('REGISTRATION_NUMBER_EXHAUSTED', 'Registration numbering capacity for this date is exhausted')
  }
  const highWater = previous + 1
  database.driver.prepare(`
    INSERT INTO registration_number_counter (visit_date, high_water) VALUES (?, ?)
    ON CONFLICT (visit_date) DO UPDATE SET high_water = excluded.high_water
  `).run(date.data, highWater)
  const counters = state.counters.filter(entry => entry.visitDate !== date.data)
  counters.push({ visitDate: date.data, highWater })
  database.driver.prepare('UPDATE registration_number_authority SET counters_hash = ? WHERE singleton = 1')
    .run(registrationCountersHash(counters))
  return `CM-OP-${date.data.replaceAll('-', '')}-${String(highWater).padStart(6, '0')}`
}
