import type { ClinicalEntityMention } from '@clinmesh/contracts/agent-sessions'
import type { ActorContext } from './command-executor.ts'
import type { WorkflowService } from './workflow-service.ts'

export type ReadableDoctorCaseDetail = ReturnType<WorkflowService['doctorCaseDetail']>

export interface VisibleClinicalScope {
  workspaceId: string
  epoch: string
  roleCode: string
  encounterId: string | null
  caseId: string | null
}

export interface VisibleCaseReader {
  readVisibleCaseSummary(scope: VisibleClinicalScope): string
  readLabResults?(scope: VisibleClinicalScope): string
  readImagingReports?(scope: VisibleClinicalScope): string
  readMedicationOrders?(scope: VisibleClinicalScope): string
  readVitalTrends?(scope: VisibleClinicalScope): string
  listVisibleMentions?(scope: VisibleClinicalScope): ClinicalEntityMention[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function formatResultValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '阳性' : '阴性'
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (typeof value === 'object' && value !== null && 'display' in value && typeof (value as { display?: unknown }).display === 'string') {
    return (value as { display: string }).display
  }
  return JSON.stringify(value)
}

function formatLabRequestName(req: NonNullable<ReadableDoctorCaseDetail['laboratoryRequests']>['requests'][number]): string {
  return req.laboratoryService?.nameZh
    ?? req.referenceConcept?.display
    ?? req.catalogItemId
    ?? req.id
}

function formatVitalsLine(detail: ReadableDoctorCaseDetail): string {
  if (detail.triage === undefined) return '暂无分诊生命体征记录'
  const bp = detail.triage.bloodPressure
    ? `${detail.triage.bloodPressure.systolicMmHg}/${detail.triage.bloodPressure.diastolicMmHg} mmHg`
    : '-'
  return `体温 ${detail.triage.temperatureC ?? '-'}°C，脉搏 ${detail.triage.pulseBpm ?? '-'} bpm，呼吸 ${detail.triage.respirationBpm ?? '-'}/分，血压 ${bp}，SpO2 ${detail.triage.oxygenSaturationPct ?? '-'}%`
}

/**
 * Strictly clinician-visible read-only clinical data adapter for Clinician Assistant tools
 * and `@` clinical entity mentions. Delegates exclusively to `doctorCaseDetail(...)` and
 * NEVER accesses hidden Case Truth, hidden diagnoses, or raw imaging/pathology pixels.
 */
export function createVisibleCaseReader(
  readDoctorCaseDetail: (actor: ActorContext, caseId: string) => ReadableDoctorCaseDetail,
): VisibleCaseReader {
  const loadVisibleDetail = (scope: VisibleClinicalScope): ReadableDoctorCaseDetail | null => {
    if (scope.caseId === null) return null
    try {
      return readDoctorCaseDetail(
        {
          actorId: 'clinician-assistant-read',
          workspaceId: scope.workspaceId,
          epoch: scope.epoch,
          scenarioRunId: 'scenario-run-1',
          roleCode: scope.roleCode,
        },
        scope.caseId,
      )
    } catch {
      return null
    }
  }

  const readVisibleCaseSummary = (scope: VisibleClinicalScope): string => {
    if (scope.caseId === null) return '当前未打开具体病例，暂无可读取的接诊摘要。'
    const detail = loadVisibleDetail(scope)
    if (detail === null) {
      return '无法读取当前病例的医生可见摘要（病例不存在或当前角色无权限）。'
    }
    const labCount = detail.laboratoryRequests?.requests.length ?? 0
    const labReported = detail.laboratoryRequests?.requests.filter(r => r.report !== undefined).length ?? 0
    const imgCount = detail.imagingRequests?.requests.length ?? 0
    const examCount = detail.examinationRequests?.requests.length ?? 0
    const pathCount = detail.pathologyRequests?.requests.length ?? 0
    const lines = [
      `- 患者：${detail.patient.name}（${detail.patient.gender}，出生日期 ${detail.patient.birthDate}）`,
      `- 就诊状态：${typeof detail.encounter.status === 'string' ? detail.encounter.status : detail.status}（Encounter ${detail.encounter.id}）`,
      ...(detail.triage === undefined ? [] : [
        `- 分诊主诉：${detail.triage.chiefComplaint}`,
        `- 生命体征：${formatVitalsLine(detail)}`,
      ]),
      `- 既往公开病史：${detail.priorFacts.length > 0 ? detail.priorFacts.map(f => f.display).join('、') : '无'}`,
      `- 过敏史：${detail.allergies.length > 0 ? detail.allergies.map(a => a.display).join('、') : '未报告'}`,
      `- 问诊轮次：${detail.consultation?.turns.length ?? 0} 条`,
      `- 可见检验/检查：检验 ${labCount} 项（已出报告 ${labReported} 项），放射 ${imgCount} 项，功能检查 ${examCount} 项，病理 ${pathCount} 项`,
    ]
    return lines.join('\n')
  }

  const readLabResults = (scope: VisibleClinicalScope): string => {
    if (scope.caseId === null) return '当前未打开具体病例，暂无检验结果。'
    const detail = loadVisibleDetail(scope)
    if (detail === null) return '无法读取当前病例的检验结果。'

    const requests = detail.laboratoryRequests?.requests ?? []
    const lines: string[] = []
    if (requests.length === 0 && detail.report === undefined) {
      return '当前病例尚未开立或收到任何医生可见的检验报告。'
    }

    for (const req of requests) {
      const name = formatLabRequestName(req)
      if (req.report === undefined) {
        lines.push(`- 【${name}】状态：${req.status}（尚未出报告）`)
        continue
      }
      lines.push(`- 【${name}】已报告（${req.report.issuedAt}）：${req.report.conclusion}`)
      for (const item of req.report.results) {
        const unitText = 'unit' in item && item.unit ? ` ${item.unit.display}` : ''
        const refText = item.referenceRange?.text ? `（参考范围：${item.referenceRange.text}）` : ''
        const flag = item.interpretation && item.interpretation !== 'normal' ? ` [${item.interpretation}]` : ''
        lines.push(`  · ${item.display}：${formatResultValue(item.value)}${unitText}${flag}${refText}`)
      }
    }

    if (detail.report !== undefined && detail.report.results.length > 0) {
      lines.push(`- 【汇总报告 ${detail.report.id}】状态：${detail.report.status}`)
      for (const row of detail.report.results) {
        const unit = row.unit ? ` ${row.unit}` : ''
        const ref = row.referenceRange ? `（参考：${row.referenceRange}）` : ''
        const interp = row.interpretation ? ` [${row.interpretation}]` : ''
        lines.push(`  · ${row.code}：${String(row.value)}${unit}${interp}${ref}`)
      }
    }

    return lines.join('\n')
  }

  const readImagingReports = (scope: VisibleClinicalScope): string => {
    if (scope.caseId === null) return '当前未打开具体病例，暂无影像/检查/病理报告。'
    const detail = loadVisibleDetail(scope)
    if (detail === null) return '无法读取当前病例的影像与检查报告。'

    const lines: string[] = []
    for (const req of detail.imagingRequests?.requests ?? []) {
      const title = `${req.service.name} (${req.service.modality})`
      if (req.report === undefined) {
        lines.push(`- 【放射影像 · ${title}】状态：${req.status}（尚未出报告）`)
      } else {
        lines.push(`- 【放射影像 · ${title}】已报告（${req.report.issuedAt}）`)
        lines.push(`  · 检查技术：${req.report.technique}`)
        lines.push(`  · 影像所见：${req.report.findings}`)
        lines.push(`  · 诊断意见：${req.report.impression}`)
      }
    }
    for (const req of detail.examinationRequests?.requests ?? []) {
      const title = `${req.service.name} (${req.service.modality})`
      if (req.report === undefined) {
        lines.push(`- 【功能检查 · ${title}】状态：${req.status}（尚未出报告）`)
      } else {
        lines.push(`- 【功能检查 · ${title}】已报告（${req.report.issuedAt}）`)
        lines.push(`  · 所见：${req.report.findings}`)
        lines.push(`  · 结论：${req.report.impression}`)
      }
    }
    for (const req of detail.pathologyRequests?.requests ?? []) {
      const title = req.service.name
      if (req.report === undefined) {
        lines.push(`- 【病理会诊 · ${title}】状态：${req.status}（尚未出报告）`)
      } else {
        lines.push(`- 【病理会诊 · ${title}】已报告（${req.report.issuedAt}）`)
        lines.push(`  · 镜下所见：${req.report.microscopy}`)
        lines.push(`  · 免疫组化：${req.report.immunohistochemistry}`)
        lines.push(`  · 病理诊断：${req.report.diagnosis}`)
        lines.push(`  · 备注：${req.report.note}`)
      }
    }

    if (lines.length === 0) {
      return '当前病例尚未开立或收到任何医生可见的影像、功能检查或病理报告。'
    }
    return lines.join('\n')
  }

  const readMedicationOrders = (scope: VisibleClinicalScope): string => {
    if (scope.caseId === null) return '当前未打开具体病例，暂无处方与用药记录。'
    const detail = loadVisibleDetail(scope)
    if (detail === null) return '无法读取当前病例的处方与过敏信息。'

    const lines: string[] = []
    lines.push(`- 过敏史：${detail.allergies.length > 0 ? detail.allergies.map(a => a.display).join('；') : '未报告过敏史'}`)

    const confirmedEntries = detail.diagnosis?.confirmation?.entries ?? []
    if (confirmedEntries.length > 0) {
      const primary = confirmedEntries.find(item => item.role === 'primary') ?? confirmedEntries[0]!
      const secondary = confirmedEntries.filter(item => item !== primary)
      lines.push(`- 已确认诊断：${primary.display}（${primary.code}）${secondary.length > 0 ? `；次要诊断：${secondary.map(item => item.display).join('、')}` : ''}`)
    } else if (isRecord(detail.drafts?.revisit) && isRecord(detail.drafts.revisit.diagnosis)) {
      const display = readStringField(detail.drafts.revisit.diagnosis, 'display') ?? ''
      const code = readStringField(detail.drafts.revisit.diagnosis, 'code') ?? ''
      if (display.length > 0) {
        lines.push(`- 复诊诊断草稿：${display}${code.length > 0 ? `（${code}）` : ''}`)
      }
    }

    const prescription = detail.drafts?.prescription
    if (isRecord(prescription) && Array.isArray(prescription.items) && prescription.items.length > 0) {
      const number = readStringField(prescription, 'number') ?? '草稿'
      const status = readStringField(prescription, 'status') ?? 'draft'
      lines.push(`- 处方 ${number}（状态：${status}）：`)
      for (const rawItem of prescription.items) {
        if (!isRecord(rawItem)) continue
        const med = readStringField(rawItem, 'medicationId') ?? readStringField(rawItem, 'medicationName') ?? '未知药品'
        const dose = readStringField(rawItem, 'doseText') ?? '-'
        const freq = readStringField(rawItem, 'frequencyCode') ?? '-'
        const route = readStringField(rawItem, 'routeCode') ?? '-'
        const qty = typeof rawItem.quantity === 'number' || typeof rawItem.quantity === 'string' ? String(rawItem.quantity) : '-'
        lines.push(`  · 药品 ${med} · 剂量 ${dose} · 频次 ${freq} · 途径 ${route} · 数量 ${qty}`)
      }
    } else if (detail.medicationConclusion !== undefined) {
      lines.push(`- 用药处置结论：${JSON.stringify(detail.medicationConclusion)}`)
    } else {
      lines.push('- 处方医嘱：当前暂无已开立或草稿处方。')
    }
    return lines.join('\n')
  }

  const readVitalTrends = (scope: VisibleClinicalScope): string => {
    if (scope.caseId === null) return '当前未打开具体病例，暂无生命体征与问诊记录。'
    const detail = loadVisibleDetail(scope)
    if (detail === null) return '无法读取当前病例的生命体征与问诊记录。'

    const lines: string[] = []
    if (detail.triage !== undefined) {
      lines.push(`- 分诊主诉：${detail.triage.chiefComplaint}`)
      lines.push(`- 生命体征：${formatVitalsLine(detail)}`)
    } else {
      lines.push('- 生命体征：暂无分诊记录')
    }

    const turns = detail.consultation?.turns ?? []
    if (turns.length > 0) {
      lines.push(`- 门诊问诊对话（最近 ${Math.min(turns.length, 10)} 条，共 ${turns.length} 条）：`)
      for (const turn of turns.slice(-10)) {
        const speaker = turn.speaker === 'doctor' ? '医生' : '患者'
        lines.push(`  · [${speaker}] ${turn.messageText}`)
      }
    } else {
      lines.push('- 门诊问诊对话：暂无记录')
    }

    if (isRecord(detail.drafts?.firstVisit)) {
      const hpi = readStringField(detail.drafts.firstVisit, 'historyOfPresentIllness')
      const assessment = readStringField(detail.drafts.firstVisit, 'assessment')
      if (hpi !== null) lines.push(`- 现病史草稿：${hpi}`)
      if (assessment !== null) lines.push(`- 初步评估草稿：${assessment}`)
    }
    return lines.join('\n')
  }

  const listVisibleMentions = (scope: VisibleClinicalScope): ClinicalEntityMention[] => {
    const detail = loadVisibleDetail(scope)
    if (detail === null) return []

    const entities: ClinicalEntityMention[] = []
    entities.push({
      id: 'vitals',
      kind: 'vitals',
      label: `主诉与生命体征（${detail.patient.name}）`,
      summary: detail.triage?.chiefComplaint ?? formatVitalsLine(detail),
      detailText: [
        `患者：${detail.patient.name}（${detail.patient.gender}）`,
        ...(detail.triage ? [`主诉：${detail.triage.chiefComplaint}`] : []),
        `生命体征：${formatVitalsLine(detail)}`,
      ].join('\n'),
    })

    const turns = detail.consultation?.turns ?? []
    if (turns.length > 0) {
      entities.push({
        id: 'consultation',
        kind: 'consultation',
        label: `问诊记录（${turns.length} 条）`,
        summary: turns[turns.length - 1]?.messageText.slice(0, 48) ?? '',
        detailText: turns.slice(-8).map(t => `[${t.speaker === 'doctor' ? '医生' : '患者'}] ${t.messageText}`).join('\n'),
      })
    }

    for (const req of detail.laboratoryRequests?.requests ?? []) {
      const name = formatLabRequestName(req)
      const summary = req.report ? req.report.conclusion.slice(0, 56) : `状态：${req.status}`
      const detailLines = req.report
        ? [
            `检验项目：${name}（已报告）`,
            `结论：${req.report.conclusion}`,
            ...req.report.results.slice(0, 12).map(r => `- ${r.display}: ${formatResultValue(r.value)}${r.interpretation ? ` [${r.interpretation}]` : ''}`),
          ]
        : [`检验项目：${name}，当前状态：${req.status}（尚未出报告）`]
      entities.push({
        id: `lab:${req.id}`,
        kind: 'lab',
        label: `检验：${name}`,
        summary,
        detailText: detailLines.join('\n'),
      })
    }

    for (const req of detail.imagingRequests?.requests ?? []) {
      const name = `${req.service.name} (${req.service.modality})`
      entities.push({
        id: `imaging:${req.id}`,
        kind: 'imaging',
        label: `影像：${name}`,
        summary: req.report ? req.report.impression.slice(0, 56) : `状态：${req.status}`,
        detailText: req.report
          ? `放射影像：${name}\n所见：${req.report.findings}\n诊断意见：${req.report.impression}`
          : `放射影像：${name}，当前状态：${req.status}（尚未出报告）`,
      })
    }

    for (const req of detail.examinationRequests?.requests ?? []) {
      const name = `${req.service.name} (${req.service.modality})`
      entities.push({
        id: `exam:${req.id}`,
        kind: 'exam',
        label: `检查：${name}`,
        summary: req.report ? req.report.impression.slice(0, 56) : `状态：${req.status}`,
        detailText: req.report
          ? `功能检查：${name}\n所见：${req.report.findings}\n结论：${req.report.impression}`
          : `功能检查：${name}，当前状态：${req.status}（尚未出报告）`,
      })
    }

    for (const req of detail.pathologyRequests?.requests ?? []) {
      entities.push({
        id: `pathology:${req.id}`,
        kind: 'pathology',
        label: `病理：${req.service.name}`,
        summary: req.report ? req.report.diagnosis.slice(0, 56) : `状态：${req.status}`,
        detailText: req.report
          ? `病理会诊：${req.service.name}\n病理诊断：${req.report.diagnosis}\n镜下所见：${req.report.microscopy}`
          : `病理会诊：${req.service.name}，当前状态：${req.status}（尚未出报告）`,
      })
    }

    entities.push({
      id: 'medications',
      kind: 'medications',
      label: '处方与过敏史',
      summary: detail.allergies.length > 0
        ? `过敏：${detail.allergies.map(a => a.display).join('、')}`
        : '未报告过敏史',
      detailText: readMedicationOrders(scope),
    })

    return entities
  }

  return {
    readVisibleCaseSummary,
    readLabResults,
    readImagingReports,
    readMedicationOrders,
    readVitalTrends,
    listVisibleMentions,
  }
}
