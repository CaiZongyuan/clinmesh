import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientAngiographyReportSchema, inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { pciMeasurementSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'

const codingSystem = 'urn:clinmesh:synthetic:coronary-angiography'
const kinds = ['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter'] as const
const observationSchema = z.object({
  code: z.object({ coding: z.array(z.object({ system: z.string(), code: z.enum(kinds) })) }),
  bodySite: z.object({ text: z.string().trim().min(1).max(2000) }).optional(),
  valueQuantity: z.object({ value: z.number().positive().finite().max(1000), unit: z.string().min(1).max(2000).optional() }).optional(),
  method: z.object({ text: z.string().trim().min(1).max(2000) }).optional(),
})
const rowSchema = z.object({ report_json: z.string() })

/** 只有仿真 worker 读取隔离来源；临床入口只返回已物化的本院报告。 */
export class InpatientAngiography {
  constructor(readonly owner: InpatientService) {}
  list(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return inpatientAngiographyReportsSchema.parse({ admissionId, reports: this.reports(context, admissionId) })
  }
  reports(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, admissionId: string) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT report_json FROM inpatient_angiography_report
      WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY report_id DESC`).all(context.workspaceId, context.epoch, admissionId))
      .map(row => inpatientAngiographyReportSchema.parse(JSON.parse(row.report_json)))
  }
  schedule(context: ActorContext, admissionId: string, procedureId: string, transaction: CommandTransaction) {
    const procedure = this.owner.fhir.read(context, 'Procedure', procedureId)
    if (!z.object({ code: z.object({ coding: z.array(z.object({ code: z.string() })) }) }).parse(procedure).code.coding
      .some(coding => ['88.5500', '88.5600'].includes(coding.code))) return
    const report = inpatientAngiographyReportSchema.parse({ id: uuidv7(), version: 1, admissionId, procedureId,
      status: 'processing', synthetic: true, targetSite: null, measurements: [], missing: [], issuedAt: null })
    this.owner.database.driver.prepare('INSERT INTO inpatient_angiography_report VALUES(?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, admissionId, procedureId, report.id, JSON.stringify(report))
    transaction.enqueue({ kind: 'inpatient.angiography.report', dedupKey: `angiography:${procedureId}`, payload: { admissionId, procedureId } })
  }
  async process(event: OutboxHandlerInput, context: ActorContext): Promise<OutboxHandlerResult> {
    const input = z.object({ admissionId: z.string(), procedureId: z.string() }).strict().parse(event.payload)
    this.owner.commands.execute({ context, input, idempotencyKey: `angiography:${input.procedureId}`, operation: 'inpatient.angiography.publish',
      expectedVersions: {}, dataSchema: inpatientAngiographyReportSchema,
      authorize: () => this.owner.assertRole(context, ['lis-system']) }, () => {
      const report = this.reports(context, input.admissionId).find(item => item.procedureId === input.procedureId)
      if (!report) throw new InpatientError('INPATIENT_ANGIOGRAPHY_NOT_FOUND', '未找到待生成的造影报告', 404)
      if (report.status !== 'processing') return { data: report, effects: [] }
      const admission = z.object({ source_case_id: z.string().nullable(), patient_id: z.string() }).parse(this.owner.database.driver.prepare(
        'SELECT source_case_id,patient_id FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?')
        .get(context.workspaceId, context.epoch, input.admissionId))
      const truth = admission.source_case_id === null ? undefined
        : new SyntheticCaseRepository(this.owner.database).getTruthForSimulator(context.workspaceId, admission.source_case_id)
      const observations = (truth?.hiddenResources ?? []).flatMap(item => {
        const parsed = observationSchema.safeParse(item.resource)
        return parsed.success && parsed.data.code.coding.some(coding => coding.system === codingSystem) ? [parsed.data] : []
      })
      const missing: string[] = []
      const measurements = kinds.flatMap(kind => {
        const found = observations.filter(item => item.code.coding.some(coding => coding.system === codingSystem && coding.code === kind))
        if (found.length !== 1) { missing.push(`缺少或存在冲突的造影测量：${kind}`); return [] }
        const observation = found[0]!
        if (!observation.bodySite || !observation.method) { missing.push(`造影测量缺少部位或方法：${kind}`); return [] }
        if (!observation.valueQuantity?.value || !observation.valueQuantity.unit) missing.push(`造影测量缺少数值或单位：${kind}`)
        return [pciMeasurementSchema.parse({ kind, object: kind === 'lesion-length' ? 'lesion' : 'reference-lumen',
          site: observation.bodySite.text, method: observation.method.text, value: observation.valueQuantity?.value ?? null,
          unit: observation.valueQuantity?.unit ?? null,
          source: { reference: `DiagnosticReport/${report.id}`, version: String(report.version), note: '本院合成造影报告测量', synthetic: true } })]
      })
      const targetSite = measurements.find(item => item.kind === 'lesion-length')?.site ?? null
      const result = inpatientAngiographyReportSchema.parse({ ...report, targetSite, measurements, missing,
        status: observations.length === 0 ? 'unavailable' : missing.length > 0 ? 'partial' : 'final', issuedAt: this.owner.virtualTime(context) })
      this.owner.database.driver.prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND procedure_id=?')
        .run(JSON.stringify(result), context.workspaceId, context.epoch, input.procedureId)
      this.owner.fhir.create(context, { resourceType: 'DiagnosticReport', id: report.id,
        status: result.status === 'unavailable' ? 'cancelled' : result.status === 'partial' ? 'partial' : 'final',
        code: { text: '冠脉造影报告（合成）' }, subject: { reference: `Patient/${admission.patient_id}` },
        encounter: { reference: `Encounter/${input.admissionId}` }, issued: result.issuedAt,
        supportingInfo: [{ type: { text: '造影操作' }, reference: { reference: `Procedure/${input.procedureId}` } }],
        conclusion: result.status === 'unavailable' ? '造影所见资料不足，无法生成报告。' : `靶部位：${targetSite ?? '缺项'}。${measurements.map(item => `${item.kind}：${item.value ?? '缺项'} ${item.unit ?? '单位缺项'}，${item.method}`).join('；')}` })
      this.owner.pciSelection.preparePending(context, input.admissionId)
      return { data: result, effects: [{ kind: 'created' as const, reference: `DiagnosticReport/${report.id}`, versionId: '1' }] }
    })
    return { status: 'completed' }
  }
}
