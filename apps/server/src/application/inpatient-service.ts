import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import {
  inpatientAdmissionSchema, inpatientCommandResponseSchema, inpatientDetailSchema,
  inpatientListSchema, inpatientRegistrationInputSchema,
  inpatientBedInputSchema, inpatientSwapInputSchema, inpatientSwapResponseSchema,
  advanceVirtualTimeInputSchema, advanceVirtualTimeResponseSchema,
} from '@clinmesh/contracts/inpatient'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
import { type ActorContext, CommandExecutor } from './command-executor.ts'

export class InpatientError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 409) { super(message) }
}
const rowSchema = z.object({ admission_id: z.string(), patient_id: z.string(), inpatient_number: z.string(),
  admission_route: inpatientAdmissionSchema.shape.admissionRoute, referral_id: z.string().nullable(),
  ward_id: z.string(), organization_id: z.string(), status: inpatientAdmissionSchema.shape.status,
  financial_status: inpatientAdmissionSchema.shape.financialStatus, record_status: inpatientAdmissionSchema.shape.recordStatus,
  registered_at: z.string(), admitted_at: z.string().nullable() })
const sumSchema = z.object({ amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const clinicalRoles = ['inpatient-doctor', 'ward-nurse']
const readers = ['registrar', 'inpatient-doctor', 'ward-nurse', 'medical-records', 'cashier', 'pharmacist']

export class InpatientService {
  readonly #workspaces: WorkspaceRepository
  constructor(readonly database: ClinMeshDatabase, readonly fhir: FhirRepository, readonly commands: CommandExecutor) {
    this.#workspaces = new WorkspaceRepository(database)
  }
  assertRole(context: ActorContext, roles: readonly string[]) {
    if (!roles.includes(context.roleCode)) throw new InpatientError('INPATIENT_ROLE_FORBIDDEN', '当前岗位不能办理该住院业务', 403)
    this.#workspaces.assertActive(context, context.scenarioRunId)
  }
  virtualTime(context: ActorContext): string {
    return z.object({ virtual_time: z.iso.datetime({ offset: true }) }).parse(this.database.driver.prepare(
      'SELECT virtual_time FROM scenario_epoch_state WHERE workspace_id=? AND epoch=?')
      .get(context.workspaceId, context.epoch)).virtual_time
  }
  detail(context: ActorContext, admissionId: string) {
    this.assertRole(context, readers)
    const row = rowSchema.optional().parse(this.database.driver.prepare(
      'SELECT * FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?')
      .get(context.workspaceId, context.epoch, admissionId))
    if (row === undefined) throw new InpatientError('INPATIENT_NOT_FOUND', '未找到本次住院', 404)
    if (clinicalRoles.includes(context.roleCode) && (context.organizationId !== row.organization_id || context.locationId !== row.ward_id)) {
      throw new InpatientError('INPATIENT_SCOPE_FORBIDDEN', '当前科室或病区不负责本次住院', 403)
    }
    const patient = this.fhir.read(context, 'Patient', row.patient_id)
    const names = z.array(z.object({ text: z.string().optional() })).optional().parse(patient.name)
    const occupancy = z.object({ bed_id: z.string() }).optional().parse(this.database.driver.prepare(
      'SELECT bed_id FROM inpatient_bed_occupancy WHERE workspace_id=? AND epoch=? AND admission_id=? AND ended_at IS NULL')
      .get(context.workspaceId, context.epoch, admissionId))
    const sum = (table: 'inpatient_deposit' | 'inpatient_charge') => sumSchema.parse(this.database.driver.prepare(
      `SELECT COALESCE(SUM(amount_fen),0) amount FROM ${table} WHERE workspace_id=? AND epoch=? AND admission_id=?`)
      .get(context.workspaceId, context.epoch, admissionId)).amount
    return inpatientDetailSchema.parse({ admission: {
      id: row.admission_id, patientId: row.patient_id, patientName: names?.[0]?.text ?? row.patient_id,
      inpatientNumber: row.inpatient_number, admissionRoute: row.admission_route,
      ...(row.referral_id === null ? {} : { referralId: row.referral_id }), wardId: row.ward_id, organizationId: row.organization_id,
      ...(occupancy === undefined ? {} : { bedId: occupancy.bed_id }), status: row.status,
      financialStatus: row.financial_status, recordStatus: row.record_status,
      ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }), registeredAt: row.registered_at,
      depositFen: sum('inpatient_deposit'), chargesFen: sum('inpatient_charge'),
      versionId: this.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
    } })
  }
  list(context: ActorContext) {
    this.assertRole(context, readers)
    const scoped = clinicalRoles.includes(context.roleCode)
    const rows = z.array(z.object({ admission_id: z.string() })).parse(this.database.driver.prepare(`
      SELECT admission_id FROM inpatient_admission WHERE workspace_id=? AND epoch=?
      ${scoped ? 'AND organization_id=? AND ward_id=?' : ''} ORDER BY registered_at, admission_id`)
      .all(context.workspaceId, context.epoch, ...(scoped ? [context.organizationId ?? '', context.locationId ?? ''] : [])))
    return inpatientListSchema.parse({ items: rows.map(row => this.detail(context, row.admission_id).admission) })
  }
  register(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRegistrationInputSchema.parse(raw)
    return this.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.admission.register',
      expectedVersions: { [`Patient/${input.patientId}`]: input.patientVersion },
      dataSchema: inpatientCommandResponseSchema.shape.data, authorize: () => this.assertRole(context, ['registrar']) }, () => {
      const ward = z.object({ organization_id: z.string() }).optional().parse(this.database.driver.prepare(
        'SELECT organization_id FROM inpatient_ward WHERE workspace_id=? AND epoch=? AND ward_id=?')
        .get(context.workspaceId, context.epoch, input.wardId))
      if (ward === undefined) throw new InpatientError('INPATIENT_WARD_NOT_FOUND', '住院病区不存在', 404)
      let sourceEncounterId = input.sourceEncounterId
      if (input.referralId !== undefined) {
        const referral = z.object({ patient_id: z.string(), ward_id: z.string(), status: z.string(), encounter_id: z.string() }).optional().parse(this.database.driver.prepare(
          'SELECT patient_id, ward_id, status, encounter_id FROM inpatient_referral WHERE workspace_id=? AND epoch=? AND referral_id=?')
          .get(context.workspaceId, context.epoch, input.referralId))
        if (referral === undefined || referral.patient_id !== input.patientId || referral.ward_id !== input.wardId || referral.status !== 'issued') {
          throw new InpatientError('INPATIENT_REFERRAL_INVALID', '住院证无效、已转收或与患者病区不符')
        }
        if (sourceEncounterId !== undefined && sourceEncounterId !== referral.encounter_id) throw new InpatientError('INPATIENT_SOURCE_INVALID', '合成病例来源与住院证不符')
        sourceEncounterId = referral.encounter_id
      }
      const sources = z.array(z.object({ case_id: z.string() })).parse(this.database.driver.prepare(`
        SELECT case_id FROM synthetic_case_materialization WHERE workspace_id=? AND epoch=? AND patient_id=?
        ${sourceEncounterId === undefined ? '' : 'AND encounter_id=?'}`)
        .all(context.workspaceId, context.epoch, input.patientId, ...(sourceEncounterId === undefined ? [] : [sourceEncounterId])))
      if (sources.length > 1) throw new InpatientError('INPATIENT_SOURCE_AMBIGUOUS', '患者有多个合成病例来源，请明确原门诊就诊')
      if (input.sourceEncounterId !== undefined && sources.length === 0) throw new InpatientError('INPATIENT_SOURCE_INVALID', '未找到患者的指定合成病例来源')
      const id = uuidv7()
      const time = this.virtualTime(context)
      this.database.driver.prepare(`INSERT INTO inpatient_admission
        (workspace_id, epoch, admission_id, patient_id, inpatient_number, admission_route, referral_id, source_case_id,
         ward_id, organization_id, status, registered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)`)
        .run(context.workspaceId, context.epoch, id, input.patientId, `ZY-${id}`, input.admissionRoute,
          input.referralId ?? null, sources[0]?.case_id ?? null, input.wardId, ward.organization_id, time)
      const encounter = this.fhir.create(context, { resourceType: 'Encounter', id, status: 'planned',
        class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP' }] }],
        identifier: [{ system: 'https://caizongyuan.github.io/clinmesh/identifier/inpatient-number', value: `ZY-${id}` }],
        subject: { reference: `Patient/${input.patientId}` }, serviceProvider: { reference: `Organization/${ward.organization_id}` } })
      const account = this.fhir.create(context, { resourceType: 'Account', id, status: 'active',
        subject: [{ reference: `Patient/${input.patientId}` }], name: `住院费用账户 ${id}` })
      const effects = [encounter, account].map(resource => ({ kind: 'created' as const,
        reference: `${resource.resourceType}/${resource.id}`, versionId: resource.meta!.versionId! }))
      if (input.depositFen > 0) {
        const transactionId = uuidv7()
        this.database.driver.prepare('INSERT INTO inpatient_deposit VALUES (?, ?, ?, ?, ?, ?)')
          .run(context.workspaceId, context.epoch, transactionId, id, input.depositFen, time)
        effects.push({ kind: 'created', reference: `InpatientDeposit/${transactionId}`, versionId: '1' })
      }
      if (input.referralId !== undefined) this.database.driver.prepare(`
        UPDATE inpatient_referral SET status='received' WHERE workspace_id=? AND epoch=? AND referral_id=?`)
        .run(context.workspaceId, context.epoch, input.referralId)
      return { data: this.detail(context, id), effects }
    })
  }
  assignBed(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'receive' | 'move-bed') {
    const input = inpatientBedInputSchema.parse(raw)
    return this.commands.execute({ context, input, idempotencyKey, operation: `inpatient.admission.${action}`,
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion },
      dataSchema: inpatientDetailSchema, authorize: () => this.assertRole(context, ['ward-nurse']) }, () => {
      const admission = this.detail(context, input.admissionId).admission
      if (action === 'receive' ? admission.status !== 'registered' : admission.status !== 'admitted') {
        throw new InpatientError('INPATIENT_STATE_CONFLICT', '当前住院状态不允许接诊或转床')
      }
      this.#assertBed(context, input.bedId, admission.wardId)
      const time = this.virtualTime(context)
      this.#endOccupancy(context, input.admissionId, time)
      this.#startOccupancy(context, input.admissionId, input.bedId, time)
      this.database.driver.prepare(`UPDATE inpatient_admission SET status='admitted', admitted_at=COALESCE(admitted_at, ?)
        WHERE workspace_id=? AND epoch=? AND admission_id=?`).run(time, context.workspaceId, context.epoch, input.admissionId)
      const encounter = this.#updateBedProjection(context, input.admissionId, input.bedId, input.encounterVersion, time)
      return { data: this.detail(context, input.admissionId), effects: [{ kind: 'updated' as const,
        reference: `Encounter/${input.admissionId}`, versionId: encounter.meta!.versionId! }] }
    })
  }
  swapBeds(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSwapInputSchema.parse(raw)
    if (input.admissionId === input.otherAdmissionId) throw new InpatientError('INPATIENT_SWAP_INVALID', '换床必须指定两次不同住院')
    return this.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.admission.swap-bed',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion,
        [`Encounter/${input.otherAdmissionId}`]: input.otherEncounterVersion },
      dataSchema: inpatientSwapResponseSchema.shape.data, authorize: () => this.assertRole(context, ['ward-nurse']) }, () => {
      const a = this.detail(context, input.admissionId).admission
      const b = this.detail(context, input.otherAdmissionId).admission
      if (a.status !== 'admitted' || b.status !== 'admitted' || a.bedId === undefined || b.bedId === undefined || a.wardId !== b.wardId) {
        throw new InpatientError('INPATIENT_SWAP_INVALID', '换床仅限同病区两名已入科且占床的患者')
      }
      const time = this.virtualTime(context)
      this.#endOccupancy(context, a.id, time)
      this.#endOccupancy(context, b.id, time)
      this.#startOccupancy(context, a.id, b.bedId, time)
      this.#startOccupancy(context, b.id, a.bedId, time)
      const left = this.#updateBedProjection(context, a.id, b.bedId, input.encounterVersion, time)
      const right = this.#updateBedProjection(context, b.id, a.bedId, input.otherEncounterVersion, time)
      return { data: { admission: this.detail(context, a.id).admission, otherAdmission: this.detail(context, b.id).admission },
        effects: [left, right].map(resource => ({ kind: 'updated' as const,
          reference: `Encounter/${resource.id}`, versionId: resource.meta!.versionId! })) }
    })
  }
  advanceTime(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = advanceVirtualTimeInputSchema.parse(raw)
    return this.commands.execute({ context, input, idempotencyKey, operation: 'scenario.advance-time', expectedVersions: {},
      dataSchema: advanceVirtualTimeResponseSchema.shape.data, authorize: () => this.assertRole(context, ['administrator']) }, () => {
      const current = this.virtualTime(context)
      const targetMs = Date.parse(input.targetVirtualTime)
      if (Date.parse(input.expectedVirtualTime) !== Date.parse(current) || targetMs < Date.parse(current)) {
        throw new InpatientError('VIRTUAL_TIME_CONFLICT', '虚拟时间已变化或目标时间早于当前时间')
      }
      let count = 0
      const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = []
      // Shanghai has no daylight-saving transitions; business days turn at UTC 16:00.
      const dayMs = 86_400_000
      const offset = 8 * 3_600_000
      const firstMidnight = (Math.floor((Date.parse(current) + offset) / dayMs) + 1) * dayMs - offset
      for (let midnight = firstMidnight; midnight <= targetMs; midnight += dayMs) {
        const time = new Date(midnight).toISOString()
        const date = new Date(midnight + offset).toISOString().slice(0, 10)
        const beds = z.array(z.object({ admission_id: z.string(), patient_id: z.string(), organization_id: z.string(),
          bed_id: z.string(), daily_price_fen: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).parse(this.database.driver.prepare(`
          SELECT a.admission_id, a.patient_id, a.organization_id, b.bed_id, b.daily_price_fen
          FROM inpatient_bed_occupancy o JOIN inpatient_admission a
            ON a.workspace_id=o.workspace_id AND a.epoch=o.epoch AND a.admission_id=o.admission_id
          JOIN inpatient_bed b ON b.workspace_id=o.workspace_id AND b.epoch=o.epoch AND b.bed_id=o.bed_id
          WHERE o.workspace_id=? AND o.epoch=? AND o.started_at<? AND o.ended_at IS NULL AND a.status='admitted'`)
          .all(context.workspaceId, context.epoch, time))
        for (const bed of beds) {
          const id = uuidv7()
          const inserted = this.database.driver.prepare(`INSERT INTO inpatient_charge
            (workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time)
            VALUES (?, ?, ?, ?, ?, 'bed', ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
            .run(context.workspaceId, context.epoch, id, bed.admission_id, bed.organization_id, bed.admission_id, date, bed.daily_price_fen, time)
          if (inserted.changes === 0) continue
          const charge = this.fhir.create(context, { resourceType: 'ChargeItem', id, status: 'billable',
            code: { text: '住院床位费', coding: [{ system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/inpatient-charge', code: 'bed-day' }] },
            subject: { reference: `Patient/${bed.patient_id}` }, encounter: { reference: `Encounter/${bed.admission_id}` },
            account: [{ reference: `Account/${bed.admission_id}` }], occurrenceDateTime: time,
            totalPriceComponent: { amount: { value: bed.daily_price_fen / 100, currency: 'CNY' } } })
          effects.push({ kind: 'created', reference: `ChargeItem/${charge.id}`, versionId: charge.meta!.versionId! })
          count += 1
        }
      }
      this.database.driver.prepare('UPDATE scenario_epoch_state SET virtual_time=? WHERE workspace_id=? AND epoch=?')
        .run(new Date(targetMs).toISOString(), context.workspaceId, context.epoch)
      effects.push({ kind: 'updated', reference: `ScenarioClock/${context.scenarioRunId}`, versionId: String(targetMs) })
      return { data: { virtualTime: new Date(targetMs).toISOString(), bedChargesCreated: count }, effects }
    })
  }
  #assertBed(context: ActorContext, bedId: string, wardId: string) {
    const bed = z.object({ ward_id: z.string() }).optional().parse(this.database.driver.prepare(
      'SELECT ward_id FROM inpatient_bed WHERE workspace_id=? AND epoch=? AND bed_id=?')
      .get(context.workspaceId, context.epoch, bedId))
    if (bed === undefined || bed.ward_id !== wardId) throw new InpatientError('INPATIENT_BED_INVALID', '床位不存在或不属于当前病区')
    if (this.database.driver.prepare(`SELECT 1 FROM inpatient_bed_occupancy WHERE workspace_id=? AND epoch=? AND bed_id=? AND ended_at IS NULL`)
      .get(context.workspaceId, context.epoch, bedId) !== undefined) throw new InpatientError('INPATIENT_BED_OCCUPIED', '床位已被占用')
  }
  #endOccupancy(context: ActorContext, admissionId: string, time: string) {
    this.database.driver.prepare(`UPDATE inpatient_bed_occupancy SET ended_at=?
      WHERE workspace_id=? AND epoch=? AND admission_id=? AND ended_at IS NULL`)
      .run(time, context.workspaceId, context.epoch, admissionId)
  }
  #startOccupancy(context: ActorContext, admissionId: string, bedId: string, time: string) {
    this.database.driver.prepare('INSERT INTO inpatient_bed_occupancy VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(context.workspaceId, context.epoch, uuidv7(), bedId, admissionId, time)
  }
  #updateBedProjection(context: ActorContext, admissionId: string, bedId: string, version: string, time: string) {
    const existing = this.fhir.read(context, 'Encounter', admissionId)
    const locations = z.array(z.object({ location: z.object({ reference: z.string() }),
      status: z.string(), period: z.object({ start: z.string(), end: z.string().optional() }) })).optional().parse(existing.location) ?? []
    return this.fhir.update(context, { ...existing, status: 'in-progress',
      actualPeriod: existing.actualPeriod ?? { start: time },
      extension: [{ url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-administrative-status', valueCode: 'admitted' }],
      location: [...locations.map(location => location.status === 'active'
        ? { ...location, status: 'completed', period: { ...location.period, end: time } } : location),
      { location: { reference: `Location/${bedId}` }, status: 'active', period: { start: time } }],
    }, version)
  }
}
