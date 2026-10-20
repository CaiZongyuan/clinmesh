import { inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientRecordSchema, inpatientRecordSnapshotSchema, inpatientRecordRevisionSchema, inpatientRecordReviewSchema, inpatientRecordArchiveSchema, inpatientRecordSubmitInputSchema, inpatientRecordReviewInputSchema, inpatientRecordArchiveInputSchema } from '@clinmesh/contracts/inpatient-record'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
const readers = ['inpatient-doctor', 'ward-nurse', 'medical-records']
/** 首页只引用正式事实；首页工作流本身不改变 Encounter 或来源指纹。 */
export class InpatientRecords {
  constructor(readonly owner: InpatientService) { }
  #rows(context: ActorContext, sql: string, admissionId: string) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(sql).all(context.workspaceId, context.epoch, admissionId))
  }
  #stored(context: ActorContext, admissionId: string) {
    const rows = (table: string, order: string) => this.#rows(context, `SELECT * FROM ${table} WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY ${order}`, admissionId)
    const common = (row: z.infer<typeof rowSchema>) => ({ revision: row.revision, sourcesHash: row.sources_hash, actorId: row.actor_id, practitionerRoleId: row.practitioner_role_id, recordedAt: row.recorded_at })
    const latest = rows('inpatient_record_revision', 'revision').at(-1)
    const revision = latest === undefined ? undefined : inpatientRecordRevisionSchema.parse({ ...common(latest), snapshot: JSON.parse(z.string().parse(latest.snapshot_json)) })
    const reviews = rows('inpatient_record_review', 'review_id').map(row => inpatientRecordReviewSchema.parse({ ...common(row), id: row.review_id, outcome: row.outcome, ...(row.reason === null ? {} : { reason: row.reason }) }))
    const archived = rows('inpatient_record_archive', 'archive_id')[0]
    const archive = archived === undefined ? undefined : inpatientRecordArchiveSchema.parse({ ...common(archived), id: archived.archive_id, reviewId: archived.review_id, snapshot: JSON.parse(z.string().parse(archived.snapshot_json)) })
    return { revision, reviews, archive }
  }
  #collect(context: ActorContext, admissionId: string, mainProcedureExecutionId: string | null) {
    const { row: admission } = this.owner.admissionBinding(context, admissionId)
    const patient = this.owner.fhir.read(context, 'Patient', admission.patient_id)
    const identity = z.object({ name: z.array(z.object({ text: z.string().optional() })).optional(), gender: z.string().optional(), birthDate: z.string().optional(), identifier: z.array(z.object({ value: z.string().optional() })).optional() }).parse(patient)
    const number = z.object({ record_number: z.string() }).optional().parse(this.owner.database.driver.prepare('SELECT record_number FROM inpatient_record_number WHERE workspace_id=? AND epoch=? AND patient_id=?').get(context.workspaceId, context.epoch, admission.patient_id))
    const count = z.object({ count: z.number().int().positive() }).parse(this.owner.database.driver.prepare(`SELECT COUNT(*) count FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND patient_id=? AND (julianday(registered_at)<julianday(?) OR (julianday(registered_at)=julianday(?) AND admission_id<=?))`).get(context.workspaceId, context.epoch, admission.patient_id, admission.registered_at, admission.registered_at, admissionId)).count
    const occupancy = this.#rows(context, `SELECT o.*,b.ward_id,w.organization_id FROM inpatient_bed_occupancy o JOIN inpatient_bed b ON b.workspace_id=o.workspace_id AND b.epoch=o.epoch AND b.bed_id=o.bed_id JOIN inpatient_ward w ON w.workspace_id=b.workspace_id AND w.epoch=b.epoch AND w.ward_id=b.ward_id WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? ORDER BY julianday(o.started_at),o.occupancy_id`, admissionId)
    const transfers = this.#rows(context, "SELECT * FROM inpatient_transfer WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='completed' ORDER BY julianday(received_at),transfer_id", admissionId)
    const events = this.owner.discharge.events(context, admissionId)
    const reversed = new Set(events.filter(event => event.kind === 'recall').map(event => event.reversesEventId))
    const departure = events.filter(event => event.kind === 'depart' && !reversed.has(event.id)).at(-1)
    const diagnosis = this.owner.orders.diagnosis(context, admissionId)
    const executions = this.owner.surgery.executedForAdmission(context, admissionId)
    const fees = this.owner.discharge.snapshot(context, admissionId)
    const settlements=this.#rows(context,'SELECT * FROM inpatient_settlement WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY settlement_id',admissionId)
    const versions = new Map<string, string>()
    const addResource = (type: string, id: string) => { const resource = this.owner.fhir.read(context, type, id); versions.set(`${type}/${id}`, resource.meta!.versionId!); return resource; }
    addResource('Encounter', admissionId)
    addResource('Account', admissionId)
    for (const entry of diagnosis.entries)
      addResource('Condition', entry.conditionId)
    const operations = executions.map(item => ({ ...item, procedureVersion: addResource('Procedure', item.id).meta!.versionId!, primary: item.id === mainProcedureExecutionId }))
    for (const charge of fees.charges)
      addResource('ChargeItem', charge.id)
    const requests = this.#rows(context, 'SELECT * FROM laboratory_request WHERE workspace_id=? AND epoch=? AND case_id=? ORDER BY request_id', admissionId)
    const revisions = this.#rows(context, `SELECT v.* FROM laboratory_report_revision v JOIN laboratory_request r ON r.workspace_id=v.workspace_id AND r.epoch=v.epoch AND r.request_id=v.request_id WHERE r.workspace_id=? AND r.epoch=? AND r.case_id=? ORDER BY v.revision_id`, admissionId)
    const acknowledgements = this.#rows(context, `SELECT a.* FROM laboratory_report_acknowledgement a JOIN laboratory_request r ON r.workspace_id=a.workspace_id AND r.epoch=a.epoch AND r.request_id=a.request_id WHERE r.workspace_id=? AND r.epoch=? AND r.case_id=? ORDER BY a.acknowledgement_id`, admissionId)
    const reports = new Set<string>()
    for (const request of requests) {
      addResource('ServiceRequest', z.string().parse(request.service_request_id))
      addResource('Task', z.string().parse(request.execution_task_id))
      if (request.diagnostic_report_id !== null)
        reports.add(z.string().parse(request.diagnostic_report_id))
    }
    for (const revision of revisions) {
      reports.add(z.string().parse(revision.diagnostic_report_id))
      reports.add(z.string().parse(revision.revision_of_diagnostic_report_id))
    }
    for (const id of [...reports].sort()) {
      const report = addResource('DiagnosticReport', id)
      for (const ref of z.array(z.object({ reference: z.string() })).parse(report.result ?? [])) {
        const [type, resourceId] = ref.reference.split('/')
        if (type === 'Observation' && resourceId)
          addResource(type, resourceId)
      }
      for (const study of z.array(z.object({ reference: z.string() })).parse(report.study ?? [])) {
        const ref = study.reference
        const [type, resourceId] = ref?.split('/') ?? []
        if (type === 'ImagingStudy' && resourceId)
          addResource(type, resourceId)
      }
    }
    const chargeCategories = new Map(fees.charges.map(item => [item.id, item.kind]))
    const snapshot = inpatientRecordSnapshotSchema.parse({ patient: { patientId: admission.patient_id, patientVersion: patient.meta!.versionId!, identifier: identity.identifier?.[0]?.value ?? '', name: identity.name?.[0]?.text ?? '', gender: identity.gender ?? '', birthDate: identity.birthDate ?? '', recordNumber: number?.record_number ?? null, admissionCount: count },
      stay: { admissionId, inpatientNumber: admission.inpatient_number, admissionRoute: admission.admission_route, registeredAt: admission.registered_at, ...(admission.admitted_at === null ? {} : { admittedAt: admission.admitted_at }), ...(occupancy[0] === undefined ? {} : { initialWardId: occupancy[0].ward_id, initialOrganizationId: occupancy[0].organization_id }), dischargeWardId: admission.ward_id, dischargeOrganizationId: admission.organization_id,
        transfers: transfers.map(row => ({ id: row.transfer_id, sourceWardId: row.source_ward_id, targetWardId: row.target_ward_id, receivedAt: row.received_at })), events, ...(departure === undefined ? {} : { departedAt: departure.virtualTime, departureMethod: departure.departureMethod }) },
      clinical: { diagnosis, operations, mainProcedureExecutionId }, fees: { ...fees, categoryNetFen: fees.charges.reduce<Record<string, number>>((sum, item) => { const kind = item.reversalOf ? chargeCategories.get(item.reversalOf) : item.kind; if (!kind)
          throw new InpatientError('INPATIENT_RECORD_FINANCIAL_CONFLICT', '冲正缺少原费用类别'); sum[kind] = (sum[kind] ?? 0) + item.amountFen; return sum; }, {}) } })
    // 主操作选择属于首页修订；来源指纹与查询者、当前目录及首页工作流无关。
    const sources = { patient, admission: { ...admission, record_status: undefined }, occupancy, transfers, events, diagnosis, executions, fees, settlements, requests, revisions, acknowledgements, versions: [...versions].sort(([a], [b]) => a.localeCompare(b)) }
    return { snapshot, sources, sourcesHash: canonicalJsonHash(sources) }
  }
  #read(context: ActorContext, admissionId: string) {
    const stored = this.#stored(context, admissionId)
    if (stored.archive)
      return inpatientRecordSchema.parse({ admissionId, recordNumber: stored.archive.snapshot.patient.recordNumber, snapshot: stored.archive.snapshot, sourcesHash: stored.archive.sourcesHash, ...stored, reviewCurrent: true })
    const current = this.#collect(context, admissionId, stored.revision?.snapshot.clinical.mainProcedureExecutionId ?? null)
    const review = stored.reviews.at(-1)
    return inpatientRecordSchema.parse({ admissionId, recordNumber: current.snapshot.patient.recordNumber, snapshot: current.snapshot, sourcesHash: current.sourcesHash, ...stored, reviewCurrent: review?.outcome === 'approved' && review.revision === stored.revision?.revision && review.sourcesHash === current.sourcesHash && stored.revision?.sourcesHash === current.sourcesHash })
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, readers)
    this.owner.readAdmissionBinding(context, admissionId)
    this.owner.database.driver.exec('BEGIN')
    try {
      const data = this.#read(context, admissionId)
      this.owner.database.driver.exec('COMMIT')
      return data
    }
    catch (error) {
      if (this.owner.database.driver.inTransaction)
        this.owner.database.driver.exec('ROLLBACK')
      throw error
    }
  }
  submit(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRecordSubmitInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.record.submit', expectedVersions: {}, dataSchema: inpatientRecordSchema, authorize: () => this.owner.assertRole(context, ['inpatient-doctor']) }, () => {
      const admission = this.owner.admissionBinding(context, input.admissionId)
      this.owner.assertNotArchived(context, input.admissionId)
      if (admission.status === 'registered')
        throw new InpatientError('INPATIENT_STATE_CONFLICT', '尚未入科，不能提交首页')
      const stored = this.#stored(context, input.admissionId), current = this.#collect(context, input.admissionId, input.mainProcedureExecutionId)
      this.#assertExpected(input, stored.revision?.revision ?? 0, current.sourcesHash)
      const operations = current.snapshot.clinical.operations
      if ((operations.length === 0 && input.mainProcedureExecutionId !== null) || (operations.length > 0 && !operations.some(item => item.id === input.mainProcedureExecutionId)))
        throw new InpatientError('INPATIENT_RECORD_MAIN_PROCEDURE_REQUIRED', '请明确选择本次实际实施的主操作；无操作时明确为空')
      const revision = input.expectedRevision + 1
      this.owner.database.driver.prepare('INSERT INTO inpatient_record_revision VALUES(?,?,?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, input.admissionId, revision, current.sourcesHash, JSON.stringify(current.snapshot), JSON.stringify(current.sources), context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      this.owner.database.driver.prepare("UPDATE inpatient_admission SET record_status='open' WHERE workspace_id=? AND epoch=? AND admission_id=?").run(context.workspaceId, context.epoch, input.admissionId)
      return { data: this.#read(context, input.admissionId), effects: [{ kind: 'created' as const, reference: `InpatientRecordRevision/${input.admissionId}.${revision}`, versionId: '1' }] }
    })
  }
  #validate(snapshot: z.infer<typeof inpatientRecordSnapshotSchema>) {
    const { patient, stay, clinical } = snapshot
    if (!patient.recordNumber || !patient.name || !patient.identifier || !patient.gender || !patient.birthDate || !stay.admittedAt || !stay.initialWardId || !stay.departedAt || !stay.departureMethod || clinical.diagnosis.entries.filter(entry => entry.role === 'primary').length !== 1)
      throw new InpatientError('INPATIENT_RECORD_INCOMPLETE', '首页核心字段或唯一主诊断尚不完整')
    for (const entry of clinical.diagnosis.entries) {
      const coding = entry.coding
      const reference = coding.releaseId === undefined ? undefined : this.owner.referenceData.diagnosisInRelease(coding.releaseId, coding.id)
      if (!reference || coding.version !== '2022' || !coding.id.startsWith('nhsa-diagnosis:nhc-icd10-clinical@2022.r4:') || !coding.sourceLocator.startsWith('cn-health:nhc-icd10-clinical@2022.r4:diagnosis:') || ['id', 'system', 'version', 'code', 'display', 'sourceLocator'].some(key => Reflect.get(reference, key) !== Reflect.get(coding, key)))
        throw new InpatientError('INPATIENT_RECORD_CODING_UNSUPPORTED', '诊断须通过正式诊断入口确认有完整来源的固定临床版编码；院内备用编码不能通过审核')
    }
    if (clinical.operations.length > 0 && clinical.operations.filter(operation => operation.primary).length !== 1)
      throw new InpatientError('INPATIENT_RECORD_MAIN_PROCEDURE_REQUIRED', '请显式确认本次实际实施主操作')
  }
  review(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRecordReviewInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.record.review', expectedVersions: {}, dataSchema: inpatientRecordSchema, authorize: () => this.owner.assertRole(context, ['medical-records']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const current = this.#read(context, input.admissionId)
      this.#assertExpected(input, current.revision?.revision ?? 0, current.sourcesHash)
      if (current.revision?.sourcesHash !== current.sourcesHash)
        throw new InpatientError('INPATIENT_RECORD_STALE', '来源已变化，请医生重新提交首页修订')
      if (input.outcome === 'approved')
        this.#validate(current.revision.snapshot)
      const id = uuidv7()
      this.owner.database.driver.prepare('INSERT INTO inpatient_record_review VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, input.admissionId, id, input.expectedRevision, input.expectedSourcesHash, input.outcome, input.reason ?? null, context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      this.owner.database.driver.prepare('UPDATE inpatient_admission SET record_status=? WHERE workspace_id=? AND epoch=? AND admission_id=?').run(input.outcome === 'approved' ? 'reviewed' : 'open', context.workspaceId, context.epoch, input.admissionId)
      return { data: this.#read(context, input.admissionId), effects: [{ kind: 'created' as const, reference: `InpatientRecordReview/${id}`, versionId: '1' }] }
    })
  }
  archive(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRecordArchiveInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.record.archive', expectedVersions: {}, dataSchema: inpatientRecordSchema, authorize: () => this.owner.assertRole(context, ['medical-records']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const current = this.#read(context, input.admissionId), admission = this.owner.admissionBinding(context, input.admissionId)
      this.#assertExpected(input, current.revision?.revision ?? 0, current.sourcesHash)
      if (!current.reviewCurrent || !current.revision)
        throw new InpatientError('INPATIENT_RECORD_REVIEW_REQUIRED', '当前首页及来源须经编码审核通过')
      if (admission.status !== 'cleared' || admission.financialStatus !== 'settled')
        throw new InpatientError('INPATIENT_RECORD_DISCHARGE_REQUIRED', '结算并清床后才可归档')
      this.#validate(current.revision.snapshot)
      this.owner.surgery.assertNoPending(context, input.admissionId)
      this.owner.investigations.assertNoPending(context, input.admissionId)
      this.owner.transfers.assertNoPending(context, input.admissionId)
      this.owner.discharge.assertOrdersFinished(context, input.admissionId)
      const fees = current.snapshot.fees
      const storedSettlement=z.object({preview_json:z.string()}).parse(this.owner.database.driver.prepare('SELECT preview_json FROM inpatient_settlement WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId,context.epoch,input.admissionId))
      const settledPreview=inpatientSettlementPreviewSchema.parse(JSON.parse(storedSettlement.preview_json))
      if(canonicalJsonHash(settledPreview.charges)!==canonicalJsonHash(fees.charges)||canonicalJsonHash(settledPreview.transactions)!==canonicalJsonHash(fees.transactions.filter(item=>item.kind==='deposit')))throw new InpatientError('INPATIENT_RECORD_FINANCIAL_CONFLICT','当前逐项账与原结算账不一致')
      if (fees.settlement?.chargesFen !== fees.chargesFen || fees.transactions.reduce((sum, item) => sum + item.amountFen, 0) !== fees.chargesFen)
        throw new InpatientError('INPATIENT_RECORD_FINANCIAL_CONFLICT', '当前费用与结算资金不一致')
      const id = uuidv7(), review = current.reviews.at(-1)!
      this.owner.database.driver.prepare('INSERT INTO inpatient_record_archive VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, input.admissionId, id, input.expectedRevision, review.id, input.expectedSourcesHash, JSON.stringify(current.revision.snapshot), context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      this.owner.database.driver.prepare("UPDATE inpatient_admission SET record_status='archived' WHERE workspace_id=? AND epoch=? AND admission_id=?").run(context.workspaceId, context.epoch, input.admissionId)
      return { data: this.#read(context, input.admissionId), effects: [{ kind: 'created' as const, reference: `InpatientRecordArchive/${id}`, versionId: '1' }] }
    })
  }
  #assertExpected(input: {
    expectedRevision: number
    expectedSourcesHash: string
  }, revision: number, hash: string) {
    if (input.expectedRevision !== revision || input.expectedSourcesHash !== hash)
      throw new InpatientError('INPATIENT_RECORD_STALE', '首页修订或来源已变化，请重新审阅后提交')
  }
}
