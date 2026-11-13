import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import {
  coronaryVesselFindingSchema,
  coronaryVesselSchema,
  inpatientAngiographyReportSchema,
  inpatientAngiographyReportsSchema,
  type CoronaryVesselFinding,
  type InpatientAngiographyReport,
} from '@clinmesh/contracts/inpatient-angiography'
import { pciMeasurementSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'

const codingSystem = 'urn:clinmesh:synthetic:coronary-angiography'
const kinds = ['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter'] as const
const codingItemSchema = z.object({ system: z.string().optional(), code: z.string() })
const qcaObservationSchema = z.object({
  code: z.object({ coding: z.array(z.object({ system: z.string(), code: z.enum(kinds) })) }),
  bodySite: z.object({ text: z.string().trim().min(1).max(2000) }).optional(),
  valueQuantity: z.object({ value: z.number().positive().finite().max(1000), unit: z.string().min(1).max(2000).optional() }).optional(),
  method: z.object({ text: z.string().trim().min(1).max(2000) }).optional(),
})
const componentSchema = z.object({
  code: z.object({ coding: z.array(codingItemSchema) }),
  valueString: z.string().optional(),
  valueInteger: z.number().int().optional(),
  valueQuantity: z.object({ value: z.number().finite().optional(), unit: z.string().optional() }).optional(),
  valueCodeableConcept: z.object({
    text: z.string().optional(),
    coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() })).optional(),
  }).optional(),
})
const vesselObservationSchema = z.object({
  id: z.string().optional(),
  code: z.object({ coding: z.array(codingItemSchema) }),
  bodySite: z.object({ text: z.string().trim().min(1).max(200).optional() }).optional(),
  note: z.array(z.object({ text: z.string().optional() })).optional(),
  component: z.array(componentSchema).optional(),
})
const conclusionResourceSchema = z.object({
  resourceType: z.string().optional(),
  code: z.object({ coding: z.array(codingItemSchema) }),
  valueString: z.string().optional(),
  conclusion: z.string().optional(),
})
const rowSchema = z.object({ report_json: z.string() })

function matchingComponents(components: z.infer<typeof componentSchema>[], code: string) {
  return components.filter(item =>
    item.code.coding.some(coding => coding.code === code && (coding.system === undefined || coding.system === codingSystem)),
  )
}

function componentText(component: z.infer<typeof componentSchema> | undefined): string | undefined {
  const raw = component?.valueString
    ?? component?.valueCodeableConcept?.coding?.[0]?.code
    ?? component?.valueCodeableConcept?.text
  const trimmed = raw?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function componentNumber(component: z.infer<typeof componentSchema> | undefined): number | undefined {
  return component?.valueQuantity?.value ?? component?.valueInteger
}

function parsePhysiologicalRatio(
  components: z.infer<typeof componentSchema>[],
  code: 'ffr' | 'ifr',
  labelText: 'FFR' | 'iFR',
  segmentLabel: string,
  missing: string[],
): { ok: true; value: number | undefined } | { ok: false } {
  const matched = matchingComponents(components, code)
  if (matched.length === 0) return { ok: true, value: undefined }
  if (matched.length > 1) {
    missing.push(`冠脉节段 ${labelText} 记录冲突：${segmentLabel}`)
    return { ok: false }
  }
  const parsed = z.number().finite().min(0).max(1.5).safeParse(componentNumber(matched[0]))
  if (!parsed.success) {
    missing.push(`冠脉节段 ${labelText} 数值缺失或越界：${segmentLabel}`)
    return { ok: false }
  }
  return { ok: true, value: parsed.data }
}

function parseVesselFindings(rawResources: unknown[], missing: string[]): { hasVesselSource: boolean; vessels: CoronaryVesselFinding[] } {
  const vesselObservations = rawResources.flatMap(resource => {
    const parsed = vesselObservationSchema.safeParse(resource)
    return parsed.success && parsed.data.code.coding.some(c => c.system === codingSystem && c.code === 'vessel-finding')
      ? [parsed.data]
      : []
  })
  const findings: CoronaryVesselFinding[] = []
  const seenSegments = new Set<string>()

  for (const [index, observation] of vesselObservations.entries()) {
    const components = observation.component ?? []
    const rawVessel = componentText(matchingComponents(components, 'vessel')[0])
    const vesselParsed = coronaryVesselSchema.safeParse(rawVessel)
    const segment = componentText(matchingComponents(components, 'segment')[0]) ?? observation.bodySite?.text?.trim()
    const label = segment ?? rawVessel ?? observation.id ?? `#${index + 1}`

    const duplicateFields = ([
      ['vessel', '血管'], ['segment', '节段'], ['stenosis-percent', '狭窄比例'],
      ['timi-flow', 'TIMI 血流'], ['lesion-characteristics', '病变特征'],
    ] as const).filter(([code]) => matchingComponents(components, code).length > 1)
    if (duplicateFields.length > 0) {
      missing.push(...duplicateFields.map(([, name]) => `冠脉节段 ${name} 记录冲突：${label}`))
      continue
    }

    const rawStenosis = componentNumber(matchingComponents(components, 'stenosis-percent')[0])
    const stenosisParsed = z.number().finite().min(0).max(100).safeParse(rawStenosis)
    const rawTimi = componentNumber(matchingComponents(components, 'timi-flow')[0])
    const timiParsed = z.number().int().min(0).max(3).safeParse(rawTimi)
    const characteristics = componentText(matchingComponents(components, 'lesion-characteristics')[0])
      ?? observation.note?.[0]?.text?.trim()

    let valid = true
    if (!vesselParsed.success || !segment) {
      missing.push(`冠脉节段所见缺少有效血管或节段：${label}`)
      valid = false
    }
    if (!stenosisParsed.success) {
      missing.push(`冠脉节段狭窄比例缺失或越界：${label}`)
      valid = false
    }
    if (!timiParsed.success) {
      missing.push(`冠脉节段 TIMI 血流分级缺失或越界：${label}`)
      valid = false
    }
    if (!characteristics) {
      missing.push(`冠脉节段病变特征缺失：${label}`)
      valid = false
    }

    const ffrResult = parsePhysiologicalRatio(components, 'ffr', 'FFR', label, missing)
    if (!ffrResult.ok) valid = false
    const ifrResult = parsePhysiologicalRatio(components, 'ifr', 'iFR', label, missing)
    if (!ifrResult.ok) valid = false

    if (!valid || !vesselParsed.success || !segment || !stenosisParsed.success || !timiParsed.success || !characteristics || !ffrResult.ok || !ifrResult.ok) {
      continue
    }
    const dedupKey = `${vesselParsed.data}:${segment}`
    if (seenSegments.has(dedupKey)) {
      missing.push(`冠脉节段所见重复：${vesselParsed.data}(${segment})`)
      continue
    }
    seenSegments.add(dedupKey)
    findings.push(coronaryVesselFindingSchema.parse({
      vessel: vesselParsed.data,
      segment,
      stenosisPercent: stenosisParsed.data,
      timiFlow: timiParsed.data,
      lesionCharacteristics: characteristics,
      ...(ffrResult.value === undefined ? {} : { ffr: ffrResult.value }),
      ...(ifrResult.value === undefined ? {} : { ifr: ifrResult.value }),
    }))
  }

  return { hasVesselSource: vesselObservations.length > 0, vessels: findings }
}

function parseAngiographyConclusion(rawResources: unknown[], missing: string[]): { hasConclusionResource: boolean; conclusion: string | null } {
  const matched = rawResources.flatMap(resource => {
    const parsed = conclusionResourceSchema.safeParse(resource)
    if (!parsed.success) return []
    const isConclusionObservation = parsed.data.code.coding.some(c => c.system === codingSystem && c.code === 'angiography-conclusion')
    const isConclusionReport = parsed.data.resourceType === 'DiagnosticReport'
      && parsed.data.code.coding.some(c => c.system === codingSystem)
    return isConclusionObservation || isConclusionReport ? [parsed.data] : []
  })
  if (matched.length === 0) return { hasConclusionResource: false, conclusion: null }
  const texts = new Set<string>()
  for (const item of matched) {
    const text = (item.valueString ?? item.conclusion)?.trim()
    if (!text) {
      missing.push('冠脉造影结论缺少文本内容')
      continue
    }
    texts.add(text)
  }
  if (texts.size > 1) {
    missing.push('冠脉造影结论存在冲突')
    return { hasConclusionResource: true, conclusion: null }
  }
  return { hasConclusionResource: true, conclusion: [...texts][0] ?? null }
}

function formatDiagnosticReportConclusion(result: InpatientAngiographyReport, hasQcaSource: boolean): string {
  if (result.status === 'unavailable') return '造影所见资料不足，无法生成报告。'
  const sections: string[] = []
  if (hasQcaSource || result.measurements.length > 0) {
    sections.push(
      `靶部位：${result.targetSite ?? '缺项'}。${result.measurements.map(item => `${item.kind}：${item.value ?? '缺项'} ${item.unit ?? '单位缺项'}，${item.method}`).join('；')}`,
    )
  }
  if (result.vessels.length > 0) {
    sections.push(
      `冠脉节段：${result.vessels.map(v => `${v.vessel}(${v.segment}) 狭窄 ${v.stenosisPercent}%，TIMI ${v.timiFlow} 级，${v.lesionCharacteristics}${v.ffr !== undefined && v.ffr !== null ? `，FFR ${v.ffr}` : ''}${v.ifr !== undefined && v.ifr !== null ? `，iFR ${v.ifr}` : ''}`).join('；')}。`,
    )
  }
  if (result.conclusion !== null) {
    sections.push(`结论：${result.conclusion}`)
  }
  if (sections.length === 0) {
    sections.push(`造影所见部分缺项：${result.missing.join('；')}`)
  }
  return sections.join(' ')
}

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
    const report = inpatientAngiographyReportSchema.parse({
      id: uuidv7(),
      version: 1,
      admissionId,
      procedureId,
      status: 'processing',
      synthetic: true,
      targetSite: null,
      measurements: [],
      vessels: [],
      conclusion: null,
      missing: [],
      issuedAt: null,
    })
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
      const hiddenResources = (truth?.hiddenResources ?? []).map(item => item.resource)
      const qcaObservations = hiddenResources.flatMap(resource => {
        const parsed = qcaObservationSchema.safeParse(resource)
        return parsed.success && parsed.data.code.coding.some(coding => coding.system === codingSystem) ? [parsed.data] : []
      })

      const missing: string[] = []
      const { hasVesselSource, vessels } = parseVesselFindings(hiddenResources, missing)
      const { hasConclusionResource, conclusion } = parseAngiographyConclusion(hiddenResources, missing)
      if (hasVesselSource && !hasConclusionResource) missing.push('缺少冠脉造影总体结论')
      const hasAnySource = qcaObservations.length > 0 || hasVesselSource || hasConclusionResource

      const measurements = !hasAnySource
        ? kinds.flatMap(kind => {
            missing.push(`缺少或存在冲突的造影测量：${kind}`)
            return []
          })
        : qcaObservations.length > 0
          ? kinds.flatMap(kind => {
              const found = qcaObservations.filter(item => item.code.coding.some(coding => coding.system === codingSystem && coding.code === kind))
              if (found.length !== 1) { missing.push(`缺少或存在冲突的造影测量：${kind}`); return [] }
              const observation = found[0]!
              if (!observation.bodySite || !observation.method) { missing.push(`造影测量缺少部位或方法：${kind}`); return [] }
              if (!observation.valueQuantity?.value || !observation.valueQuantity.unit) missing.push(`造影测量缺少数值或单位：${kind}`)
              return [pciMeasurementSchema.parse({ kind, object: kind === 'lesion-length' ? 'lesion' : 'reference-lumen',
                site: observation.bodySite.text, method: observation.method.text, value: observation.valueQuantity?.value ?? null,
                unit: observation.valueQuantity?.unit ?? null,
                source: { reference: `DiagnosticReport/${report.id}`, version: String(report.version), note: '本院合成造影报告测量', synthetic: true } })]
            })
          : []
      if (hasAnySource && qcaObservations.length === 0 && !hasVesselSource) {
        missing.push('缺少冠脉节段造影所见')
      }

      const targetSite = measurements.find(item => item.kind === 'lesion-length')?.site ?? null
      const result = inpatientAngiographyReportSchema.parse({
        ...report,
        targetSite,
        measurements,
        vessels,
        conclusion,
        missing,
        status: !hasAnySource ? 'unavailable' : missing.length > 0 ? 'partial' : 'final',
        issuedAt: this.owner.virtualTime(context),
      })
      this.owner.database.driver.prepare('UPDATE inpatient_angiography_report SET report_json=? WHERE workspace_id=? AND epoch=? AND procedure_id=?')
        .run(JSON.stringify(result), context.workspaceId, context.epoch, input.procedureId)
      this.owner.fhir.create(context, {
        resourceType: 'DiagnosticReport',
        id: report.id,
        status: result.status === 'unavailable' ? 'cancelled' : result.status === 'partial' ? 'partial' : 'final',
        code: { text: '冠脉造影报告（合成）' },
        subject: { reference: `Patient/${admission.patient_id}` },
        encounter: { reference: `Encounter/${input.admissionId}` },
        issued: result.issuedAt,
        supportingInfo: [{ type: { text: '造影操作' }, reference: { reference: `Procedure/${input.procedureId}` } }],
        conclusion: formatDiagnosticReportConclusion(result, qcaObservations.length > 0),
      })
      this.owner.pciSelection.preparePending(context, input.admissionId)
      return { data: result, effects: [{ kind: 'created' as const, reference: `DiagnosticReport/${report.id}`, versionId: '1' }] }
    })
    return { status: 'completed' }
  }
}
