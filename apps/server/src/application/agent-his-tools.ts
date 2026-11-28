import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '@earendil-works/chord/json'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import {
  defineDoc,
  defineExtension,
  defineSignal,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolPark,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import {
  buildRoleAgentCapabilitiesManifest,
  isHardBlacklistedHisOperation,
  requiresClinicianConfirmation,
  toAgentHisToolName,
} from '@clinmesh/contracts/agent-capabilities'
import {
  getHisOperation,
  hisOperationCatalog,
  type HisOperationDefinition,
} from '@clinmesh/contracts/his-operations'
import type {
  AgentUiBridgeAction,
  AgentUiBridgeRequest,
} from '@clinmesh/contracts/agent-sessions'
import type { DevReflectionRuntime } from './agent-dev-reflection.ts'
import { z } from 'zod'

export interface EphemeralHisAuthContext {
  readonly cookie?: string
  readonly authorization?: string
  readonly origin: string
  readonly roleCode: string
  readonly workspaceId: string
  readonly epoch: string
  readonly caseId: string | null
  readonly encounterId: string | null
}

export type StoredApprovalDetailItem = {
  label: string
  value: string
  badge: string | null
}

export type StoredPendingApproval = {
  approvalId: string
  taskId: number
  callId: string
  operationId: string
  toolName: string
  title: string
  summary: string
  risk: 'write' | 'high-risk-write'
  details: StoredApprovalDetailItem[]
  argumentsPreview: string
  createdAt: string
  expiresAt: string
}

export type StoredPendingApprovalsDoc = {
  items: StoredPendingApproval[]
  mutationVersion: number
}

export type StoredUiBridgeDoc = {
  requests: AgentUiBridgeRequest[]
}

export const ClinMeshPendingApprovalsDoc = defineDoc<StoredPendingApprovalsDoc>({
  kind: 'clinmesh.pending_approvals',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: [], mutationVersion: 0 }),
  checkpointWhen: () => true,
})

export const ClinMeshUiBridgeDoc = defineDoc<StoredUiBridgeDoc>({
  kind: 'clinmesh.ui_bridge',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ requests: [] }),
  checkpointWhen: () => true,
})

export const ClinicianApprovalSignal = defineSignal({
  name: 'clinmesh.clinician_approval',
  version: 1,
  schema: obj({
    approved: bool(),
    reason: opt(str()),
  }),
})

export const UiBridgeResultSignal = defineSignal({
  name: 'clinmesh.ui_bridge_result',
  version: 1,
  schema: obj({
    ok: bool(),
    resultJson: opt(str()),
    error: opt(str()),
  }),
})

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1_000
const UI_BRIDGE_TIMEOUT_MS = 12_000

const DOMAIN_PLAYBOOKS: Record<string, string> = {
  'outpatient-briefing': [
    '# 门诊病例综合简报 Playbook',
    '1. 首选调用 `macro_clinical_briefing({ caseId, encounterId })` 一次性并行获取可见病例、分诊生命体征、既往史、全部已发布检验报告、临床评分与完诊预览。',
    '2. 明确区分异常指标（H/L）与正常指标，并标出参考范围与待确认已阅状态。',
    '3. 红线：严格遵守 Reveal Policy，严禁臆造或推测未向医生公开的隐藏诊断。',
  ].join('\n'),
  'outpatient-safety-audit': [
    '# 门诊完诊前安全与临床质控预检 Playbook',
    '1. 调用 `macro_safety_completion_audit({ caseId, encounterId })` 一次核查完诊阻断项、临床质控、专病评分、指南主题与医嘱组草稿。',
    '2. 纯审计任务禁止执行写操作，逐条列出待补齐项与优先级。',
  ].join('\n'),
  'outpatient-e2e-write': [
    '# 门诊自动化问诊、起草与一次确认闭环 Playbook',
    '核心原则：**自主完成全部准备工作，所有正式临床提交合并为 1 张确认卡片由医生一次确认**，严禁逐项反复弹窗打扰医生。',
    '1. **主动向患者问诊**：直接调用 `macro_consultation_ask({ message })`（内置自动获取最新 `consultation.version`，一步拿到患者回复，严禁手猜或循环试探版本号）。',
    '2. **查目录与版本号**：调用 `macro_outpatient_write_preflight({})` 获取最新病例版本与常用目录；查检验/检查/影像/诊断/药品目录优先用 `macro_search_clinical_catalog({ kind, queries })`（支持任意长度中文关键词）。',
    '3. **自主保存草稿**：`encounter_clinical_document_draft_set`、`encounter_diagnosis_draft_set`、`encounter_prescription_draft_set` 均可直接自主落库（也可配合 `ui_navigate_workspace` 切到对应栏位供医生直观查看）。',
    '4. **多项正式提交一次确认（强烈推荐）**：如需同时签署病历、确认诊断、开立多项检验/心电图/影像或签发处方，**直接调用 1 次 `batch_confirm_clinical_orders`** 把所有待签发/待确认项打包成 1 张清晰清单让医生一键确认；仅单项确认时才调用单独的 `*_sign` / `*_confirm` / `*_issue`。',
    '5. **完诊**：确认前置门禁满足后，可在 `batch_confirm_clinical_orders` 中一并勾选 `completeEncounter: true` 或单独调用 `encounter_complete`。',
  ].join('\n'),
  'inpatient-workflow': [
    '# 住院工作流自动化 Playbook',
    '1. 使用 `tool_search` 或 `codemode`（`searchTools("inpatient ...")`）按需检索住院查询、草稿与医嘱工具。',
    '2. 只读查询与草稿保存可自主执行；住院诊断确认、医嘱开立/停嘱、发药、分床与出院办理均会自动弹出【医生确认卡片】待人工确认后生效。',
  ].join('\n'),
  'frontend-ui-collab': [
    '# 前端工作台导航与未保存表单协同 Playbook（默认放行制）',
    '1. **切换工作区栏位/页签**：直接调用 `ui_navigate_workspace({ target: "病历记录" })`（支持“问诊记录/患者对话”、“病历记录/病历栏”、“诊断”、“检验检查”、“处方”等模糊或精确名称），系统自动驱动虚拟光标与页签高亮完成切换，默认放行无拦截。',
    '2. **读取当前画面控件**：调用 `ui_read_workspace({})` 获取当前工作区全部可见控件（含 `ref`、`label`、`actions`、`items`、`value`）与 `humanEditedLabels`（医生手改未保存字段清单）。',
    '3. **批量预填表单草稿**：调用 `ui_stage_form_draft({ changes })` 实时写入屏幕表单；内置手改锁会自动跳过医生刚手改的字段绝不覆写，并支持医生一键撤销。',
    '4. **通用界面交互**：调用 `ui_act_workspace({ steps })` 可执行任意非黑名单控件的合法动作（`setValue`、`press`、`setOpen`、`open`、`close`、`toggle`、`setChecked` 等）；仅命中带 `data-agent-confirm` 的高危提交按钮时会被门禁拦截，此时请改用对应的后端审批工具以弹出医生一键确认卡片。',
  ].join('\n'),
}

export function requiresClinicianApproval(op: HisOperationDefinition): boolean {
  return requiresClinicianConfirmation(op)
}

export function hisOpToToolName(opId: string): string {
  return toAgentHisToolName(opId)
}

function classifyDomain(op: HisOperationDefinition): 'clinical_case' | 'diagnostics' | 'therapy' | 'cds' | 'finance' {
  const id = op.id
  if (
    id.includes('clinical-scores')
    || id.includes('guideline')
    || id.includes('order-set')
    || id.includes('clinical-quality')
    || id.includes('risk-assessment')
  ) {
    return 'cds'
  }
  if (id.includes('laboratory') || id.includes('imaging') || id.includes('pathology') || id.includes('examination')) {
    return 'diagnostics'
  }
  if (
    id.includes('prescription')
    || id.includes('medication')
    || id.includes('diagnosis')
    || id.includes('service.')
    || id.includes('inpatient')
    || id.includes('triage')
    || id.includes('pharmacy')
  ) {
    return 'therapy'
  }
  if (
    id.includes('payment')
    || id.includes('billing')
    || id.includes('refund')
    || id.includes('receipt')
    || id.includes('catalog')
    || id.includes('reference.')
    || id.includes('registration')
  ) {
    return 'finance'
  }
  return 'clinical_case'
}

function sanitizeJsonSchema(zodSchema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(zodSchema, { unrepresentable: 'any' }) as Record<string, unknown>
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean)
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$schema') continue
        out[k] = clean(v)
      }
      return out
    }
    return node
  }
  const cleaned = clean(raw) as Record<string, unknown>
  if (cleaned.type !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  if (!cleaned.properties) cleaned.properties = {}
  return cleaned
}

function sha256Short(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function encodePath(template: string, input: Record<string, unknown>): { path: string; remaining: Record<string, unknown> } {
  const remaining = { ...input }
  const path = template.replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = remaining[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing required path parameter: ${name}`)
    }
    Reflect.deleteProperty(remaining, name)
    return encodeURIComponent(value)
  })
  return { path, remaining }
}

function encodeQuery(input: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) query.append(name, String(item))
    } else {
      query.set(name, String(value))
    }
  }
  return query
}

export function compactHisOperationOutput(opId: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || typeof raw !== 'object') return raw
  const obj = raw as Record<string, unknown>

  if (opId === 'doctor.case.get') {
    const encounter = obj.encounter as Record<string, unknown> | undefined
    const patient = obj.patient as Record<string, unknown> | undefined
    const triage = obj.triage as Record<string, unknown> | undefined
    const consultation = obj.consultation as {
      version?: number
      turns?: Array<Record<string, unknown>>
      replyAttempt?: Record<string, unknown>
    } | undefined
    const clinicalDoc = obj.clinicalDocument as Record<string, unknown> | undefined
    const diagnosis = obj.diagnosis as Record<string, unknown> | undefined
    const medConclusion = obj.medicationConclusion as Record<string, unknown> | undefined
    const labState = obj.laboratoryRequests as { draftVersion?: number; draft?: Record<string, unknown>; requests?: Array<Record<string, unknown>> } | undefined
    const examState = obj.examinationRequests as { draftVersion?: number; draft?: Record<string, unknown>; requests?: Array<Record<string, unknown>> } | undefined
    const imgState = obj.imagingRequests as { draftVersion?: number; draft?: Record<string, unknown>; requests?: Array<Record<string, unknown>> } | undefined
    const pathState = obj.pathologyRequests as { draftVersion?: number; draft?: Record<string, unknown>; requests?: Array<Record<string, unknown>> } | undefined
    const labReqs = labState?.requests ?? []
    const consultationTurns = Array.isArray(consultation?.turns) ? consultation.turns : []
    const lastTextTurn = [...consultationTurns].reverse().find(t => t.kind === 'text')
    return {
      caseId: obj.caseId,
      status: obj.status,
      taskId: obj.taskId,
      taskVersion: obj.taskVersion,
      patient: patient ? { id: patient.id, name: patient.name, gender: patient.gender, birthDate: patient.birthDate } : undefined,
      encounter: encounter ? { id: encounter.id, status: encounter.status, versionId: encounter.versionId } : undefined,
      consultation: consultation ? {
        version: consultation.version,
        turnCount: consultationTurns.length,
        hasPendingDoctorTurn: lastTextTurn?.speaker === 'doctor',
        latestTurns: consultationTurns.slice(-6).map(t => ({
          speaker: t.speaker,
          messageText: typeof t.messageText === 'string' ? t.messageText.slice(0, 220) : '',
        })),
      } : undefined,
      triage: triage ? {
        acuityCode: triage.acuityCode,
        chiefComplaint: triage.chiefComplaint,
        bloodPressure: triage.bloodPressure,
        temperatureC: triage.temperatureC,
        pulseBpm: triage.pulseBpm,
        respirationBpm: triage.respirationBpm,
        oxygenSaturationPct: triage.oxygenSaturationPct,
      } : undefined,
      priorFacts: obj.priorFacts,
      allergies: obj.allergies,
      clinicalDocument: clinicalDoc ? {
        draftVersion: (clinicalDoc.draft as Record<string, unknown> | undefined)?.version ?? 0,
        draft: clinicalDoc.draft ?? null,
        signedCount: Array.isArray(clinicalDoc.signed) ? clinicalDoc.signed.length : 0,
        latestSigned: Array.isArray(clinicalDoc.signed) && clinicalDoc.signed.length > 0
          ? {
              compositionId: (clinicalDoc.signed[clinicalDoc.signed.length - 1] as Record<string, unknown>).compositionId,
              content: (clinicalDoc.signed[clinicalDoc.signed.length - 1] as Record<string, unknown>).content,
            }
          : null,
      } : undefined,
      diagnosis: diagnosis ? {
        draftVersion: diagnosis.draftVersion,
        confirmed: diagnosis.confirmation !== undefined && diagnosis.confirmation !== null,
        confirmation: diagnosis.confirmation ?? null,
        draft: diagnosis.draft ?? null,
      } : undefined,
      medicationConclusion: medConclusion ? {
        draftVersion: medConclusion.draftVersion,
        hasPrescription: medConclusion.prescription != null,
        hasNoMedication: medConclusion.noMedication != null,
        prescription: medConclusion.prescription ?? null,
        noMedication: medConclusion.noMedication ?? null,
      } : null,
      laboratoryDraftVersion: labState?.draftVersion ?? 0,
      laboratoryDraft: labState?.draft ? {
        catalogItemId: labState.draft.catalogItemId,
        indicationCode: labState.draft.indicationCode,
        serviceName: (labState.draft.laboratoryService as Record<string, unknown> | undefined)?.nameZh
          ?? (labState.draft.referenceConcept as Record<string, unknown> | undefined)?.nameZh,
      } : null,
      examinationDraftVersion: examState?.draftVersion ?? 0,
      examinationRequests: (examState?.requests ?? []).map(r => ({
        id: r.id,
        serviceName: (r.service as Record<string, unknown> | undefined)?.name,
        status: r.status,
      })),
      imagingDraftVersion: imgState?.draftVersion ?? 0,
      imagingRequests: (imgState?.requests ?? []).map(r => ({
        id: r.id,
        serviceName: (r.service as Record<string, unknown> | undefined)?.name,
        status: r.status,
      })),
      pathologyDraftVersion: pathState?.draftVersion ?? 0,
      pathologyRequests: (pathState?.requests ?? []).map(r => ({
        id: r.id,
        serviceName: (r.service as Record<string, unknown> | undefined)?.name,
        status: r.status,
      })),
      laboratoryReports: labReqs.map(r => {
        const rep = r.report as Record<string, unknown> | undefined
        const rawResults = Array.isArray(rep?.results) ? rep.results : []
        const results = (rawResults as Array<Record<string, unknown>>).map(it => ({
          code: it.code,
          name: it.display ?? it.name ?? it.code,
          value: it.value,
          unit: it.unit,
          referenceRange: it.referenceRangeText ?? it.referenceRange,
          interpretation: it.interpretation ?? it.flag,
        }))
        return {
          requestId: r.id,
          serviceId: r.serviceId ?? r.catalogItemId,
          serviceName: r.serviceNameZh ?? r.serviceName ?? r.display,
          status: r.status,
          reportId: rep?.diagnosticReportId ?? null,
          conclusion: rep?.conclusion ?? null,
          acknowledged: rep?.acknowledgement != null,
          results,
        }
      }),
    }
  }

  if (opId === 'doctor.case.laboratory-catalog.search') {
    const items = Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>).slice(0, 20).map(it => ({
          id: it.id,
          code: it.code,
          nameZh: it.nameZh ?? it.name,
          orderable: it.doctorOrderable ?? true,
          allowedIndications: it.allowedIndicationCodes ?? ['clinical-evaluation'],
        }))
      : []
    return { total: obj.total ?? items.length, items }
  }

  if (
    opId === 'doctor.case.examination-services.list'
    || opId === 'doctor.case.imaging-services.list'
    || opId === 'doctor.case.pathology-services.list'
  ) {
    const items = Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>).map(it => {
          const svc = (it.service as Record<string, unknown> | undefined) ?? it
          return {
            available: it.available ?? true,
            id: svc.id,
            code: svc.code,
            name: svc.name ?? svc.nameZh,
            department: svc.department,
          }
        })
      : []
    return { items }
  }

  if (opId === 'reference.diagnoses.search') {
    const items = Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>).slice(0, 20).map(d => ({
          id: d.id,
          code: d.code,
          nameZh: d.nameZh ?? d.display,
        }))
      : []
    return { total: obj.total ?? items.length, items }
  }

  if (opId === 'reference.medications.search') {
    const items = Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>).slice(0, 20).map(m => ({
          id: m.id,
          nameZh: m.nameZh ?? m.display,
          specification: m.specification,
          allowedDoseTexts: m.allowedDoseTexts,
          allowedFrequencyCodes: m.allowedFrequencyCodes,
          allowedRouteCodes: m.allowedRouteCodes,
        }))
      : []
    return { total: obj.total ?? items.length, items }
  }

  if (opId === 'catalog.clinical.read') {
    const diagnoses = Array.isArray(obj.diagnoses)
      ? (obj.diagnoses as Array<Record<string, unknown>>).slice(0, 20).map(d => ({
          id: d.id,
          code: d.code,
          nameZh: d.nameZh ?? d.display,
        }))
      : []
    const medications = Array.isArray(obj.medications)
      ? (obj.medications as Array<Record<string, unknown>>).slice(0, 20).map(m => ({
          id: m.id,
          nameZh: m.nameZh,
          allowedDoseTexts: m.allowedDoseTexts,
          allowedFrequencyCodes: m.allowedFrequencyCodes,
          allowedRouteCodes: m.allowedRouteCodes,
        }))
      : []
    return { diagnoses, medications }
  }

  if (opId === 'doctor.case.clinical-scores.read') {
    const scores = Array.isArray(obj.scores)
      ? (obj.scores as Array<Record<string, unknown>>).map(s => ({
          id: s.id,
          titleZh: s.titleZh,
          status: s.status,
          value: s.value,
          tierLabelZh: s.tierLabelZh,
          missingInputs: s.missingInputs,
          summaryZh: s.summaryZh,
        }))
      : []
    return {
      encounterId: obj.encounterId,
      encounterVersion: obj.encounterVersion,
      scores,
    }
  }

  if (opId === 'doctor.case.guideline-topics.read') {
    const topics = Array.isArray(obj.topics)
      ? (obj.topics as Array<Record<string, unknown>>).map(t => ({
          id: t.id,
          titleZh: t.titleZh,
          applicable: t.applicable ?? t.status,
          summaryZh: t.summaryZh,
        }))
      : obj
    return { topics }
  }

  if (opId === 'doctor.case.order-set-drafts.read') {
    const drafts = Array.isArray(obj.drafts)
      ? (obj.drafts as Array<Record<string, unknown>>).map(d => ({
          templateId: d.templateId,
          titleZh: d.titleZh,
          applicable: d.applicable ?? d.status,
          itemCount: Array.isArray(d.items) ? d.items.length : 0,
        }))
      : obj
    return { drafts }
  }

  const serialized = JSON.stringify(raw)
  if (serialized.length <= 6_500) return raw
  return { _truncated: true, preview: serialized.slice(0, 6_200) }
}

function formatApprovalTitle(op: HisOperationDefinition): string {
  const map: Record<string, string> = {
    'encounter.clinical-document.sign': '正式签署门急诊结构化病历',
    'clinical-document.revise': '提交病历正式修订',
    'encounter.diagnosis.confirm': '正式确认门诊诊断',
    'encounter.prescription.issue': '正式开立门诊处方',
    'prescription.withdraw': '撤回已开立处方',
    'encounter.medication-conclusion.confirm-none': '确认本次无需用药结论',
    'encounter.complete': '正式完成本次门诊接诊（完诊）',
    'encounter.laboratory-request.issue': '正式开立检验申请',
    'encounter.imaging-request.issue': '正式开立影像检查申请',
    'encounter.examination-request.issue': '正式开立功能检查申请',
    'encounter.pathology-request.issue': '正式开立病理检查申请',
    'triage.record': '提交分诊分级与生命体征（完成分诊）',
    'inpatient.diagnosis.confirm': '正式确认住院诊断',
    'inpatient.orders.issue': '正式开立住院医嘱',
    'inpatient.orders.stop': '停用住院医嘱',
    'inpatient.discharge.issue': '开立出院医嘱',
    'inpatient.discharge.depart': '办理患者出院',
    'inpatient.discharge.clear': '办理清床归档',
    'inpatient.medication.dispense': '确认住院发药',
  }
  return map[op.id] ?? `确认执行高危临床操作：${op.id}`
}

function formatApprovalSummary(op: HisOperationDefinition): string {
  const map: Record<string, string> = {
    'encounter.clinical-document.sign': '将当前门急诊结构化病历正式电子签名并归档。',
    'encounter.diagnosis.confirm': '确认主诊断与次要诊断，落库成为本次就诊正式诊断。',
    'encounter.prescription.issue': '正式签发当前草稿处方并生成待发药/收费医嘱。',
    'encounter.medication-conclusion.confirm-none': '登记本次就诊无需开具处方药的正式用药结论。',
    'encounter.complete': '完结本次门诊接诊并锁定门诊文书与医嘱。',
    'encounter.laboratory-request.issue': '正式开立当前草稿检验申请并计费。',
    'encounter.examination-request.issue': '正式开立当前草稿功能检查申请并计费。',
    'encounter.imaging-request.issue': '正式开立当前草稿影像检查申请并计费。',
    'encounter.pathology-request.issue': '正式开立当前草稿病理检查申请并计费。',
  }
  return map[op.id] ?? (op.summary.length > 96 ? `${op.summary.slice(0, 96)}…` : op.summary)
}

const TECHNICAL_ARG_KEYS = new Set([
  'encounterId',
  'encounterVersion',
  'caseId',
  'taskId',
  'taskVersion',
  'expectedDraftVersion',
  'expectedConsultationVersion',
  'previewId',
  'commitToken',
  'idempotencyKey',
])

const LAB_SHORT_QUERY_EXPANSIONS: Record<string, string> = {
  血脂: '胆固醇',
  肝功: '转氨酶',
  肾功: '肌酐测定',
  血糖: '葡萄糖',
  糖化: '糖化血红蛋白',
  心梗: '肌钙蛋白',
  心肌酶: '肌酸激酶',
  凝血: '凝血酶原',
  血常规: '白细胞计数',
  甲功: '甲状腺',
  电解质: '钾测定',
  尿常规: '尿液分析',
}

function truncateText(text: string, maxLen = 72): string {
  const clean = text.replaceAll(/\s+/g, ' ').trim()
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean
}

function formatIndicationLabel(code: unknown): string {
  const map: Record<string, string> = {
    'clinical-evaluation': '临床评估',
    'diagnostic-confirmation': '明确诊断',
    'baseline-assessment': '基线评估',
    'treatment-monitoring': '疗效与安全监测',
    'preoperative-assessment': '术前评估',
  }
  const s = typeof code === 'string' ? code : ''
  return map[s] ?? (s || '临床评估')
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function previewArgs(args: unknown): string {
  try {
    const raw = JSON.stringify(args, null, 2)
    return raw.length > 1_200 ? `${raw.slice(0, 1_200)}\n…` : raw
  } catch {
    return String(args)
  }
}

export interface InProcessHisDispatcher {
  dispatch(request: Request): Promise<Response>
}

export interface HisToolsBundleOptions {
  readonly getDispatcher: () => InProcessHisDispatcher | undefined
  readonly getAuthContext: (conversationId: number) => EphemeralHisAuthContext | undefined
  readonly onMutationCommitted: (conversationId: number, operationId: string) => Promise<void>
  readonly devReflection?: DevReflectionRuntime
}

export interface ProductionHisToolsBundle {
  readonly domainExtensions: readonly Extension[]
  readonly macroExtension: Extension
  readonly uiBridgeExtension: Extension
  readonly allCatalogTools: readonly ToolRegistration[]
  readonly macroTools: readonly ToolRegistration[]
  readonly uiBridgeTools: readonly ToolRegistration[]
  readonly getRoleAllowedHisTools: (roleCode: string) => readonly ToolRegistration[]
  readonly executeHisOperation: (
    conversationId: number,
    operationId: string,
    rawArgs: unknown,
  ) => Promise<unknown>
}

function formatHttpError(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string; clinicalQuality?: unknown; conflict?: unknown } }
    if (parsed.error) {
      return JSON.stringify({ status, error: parsed.error })
    }
  } catch {
    // plain text fallback
  }
  return JSON.stringify({ status, error: { code: `HTTP_${status}`, message: bodyText.slice(0, 600) } })
}

export function createProductionHisToolsBundle(
  options: HisToolsBundleOptions,
): ProductionHisToolsBundle {
  const executeHisOperation = async (
    conversationId: number,
    operationId: string,
    rawArgs: unknown,
  ): Promise<unknown> => {
    const dispatcher = options.getDispatcher()
    if (dispatcher === undefined) {
      throw new Error('HIS 内部操作通道尚未就绪（HTTP Dispatcher 未挂载）。')
    }
    const auth = options.getAuthContext(conversationId)
    if (auth === undefined) {
      throw new Error('当前会话缺少有效的登录凭据上下文，请重新发送消息或刷新页面后再试。')
    }
    const op = getHisOperation(operationId)
    const input = op.input.parse(rawArgs ?? {}) as Record<string, unknown>
    const { path, remaining } = encodePath(op.http.path, input)
    const url = new URL(path, auth.origin)
    if (op.http.method === 'GET') {
      const query = op.http.encodeQuery === undefined ? remaining : op.http.encodeQuery(input)
      url.search = encodeQuery(query).toString()
    }

    const headers = new Headers({ accept: 'application/json' })
    if (auth.cookie) headers.set('cookie', auth.cookie)
    if (auth.authorization) headers.set('authorization', auth.authorization)
    if (op.requirements.idempotency === 'required') {
      headers.set('idempotency-key', `agent-${op.id}-${sha256Short(JSON.stringify(input))}-${randomUUID().slice(0, 6)}`)
    }

    let body: string | undefined
    if (op.http.method !== 'GET') {
      if (op.http.encodeBody === undefined) {
        throw new Error(`HIS operation missing HTTP body encoder: ${op.id}`)
      }
      headers.set('content-type', 'application/json')
      headers.set('origin', auth.origin)
      body = JSON.stringify(op.http.encodeBody(input))
    }

    const request = new Request(url, {
      method: op.http.method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
    const response = await dispatcher.dispatch(request)
    const rawText = await response.text()
    if (!response.ok) {
      const formatted = formatHttpError(response.status, rawText)
      const watchdogHint = options.devReflection?.recordToolOutcome(conversationId, operationId, false, formatted)
      throw new Error(watchdogHint ? `${formatted}\n${watchdogHint}` : formatted)
    }
    const parsedJson = rawText.length > 0 ? JSON.parse(rawText) as unknown : {}
    options.devReflection?.recordToolOutcome(conversationId, operationId, true)
    if (op.risk !== 'read') {
      await options.onMutationCommitted(conversationId, op.id).catch(() => undefined)
    }
    return parsedJson
  }

  const buildApprovalDetails = async (
    conversationId: number,
    op: HisOperationDefinition,
    rawArgs: unknown,
  ): Promise<StoredApprovalDetailItem[]> => {
    const details: StoredApprovalDetailItem[] = []
    const auth = options.getAuthContext(conversationId)
    let liveCase: Record<string, unknown> | null = null
    if (auth?.caseId) {
      try {
        const fetched = await executeHisOperation(conversationId, 'doctor.case.get', { caseId: auth.caseId })
        if (fetched && typeof fetched === 'object') liveCase = fetched as Record<string, unknown>
      } catch {
        // Non-blocking enrichment: fall back to argument fields below.
      }
    }

    const patientName = (liveCase?.patient as { name?: string } | undefined)?.name
    if (patientName) {
      details.push({ label: '患者', value: patientName, badge: '病例' })
    }

    if (op.id === 'encounter.laboratory-request.issue') {
      const draft = (liveCase?.laboratoryRequests as {
        draft?: {
          indicationCode?: string
          laboratoryService?: { nameZh?: string }
          referenceConcept?: { nameZh?: string }
          catalogItemId?: string
        }
      } | undefined)?.draft
      const name = draft?.laboratoryService?.nameZh ?? draft?.referenceConcept?.nameZh ?? draft?.catalogItemId
      if (name) details.push({ label: '检验项目', value: name, badge: '检验' })
      if (draft?.indicationCode) details.push({ label: '指征', value: formatIndicationLabel(draft.indicationCode), badge: null })
    } else if (op.id === 'encounter.examination-request.issue') {
      const draft = (liveCase?.examinationRequests as {
        draft?: { indication?: string; service?: { name?: string } }
      } | undefined)?.draft
      if (draft?.service?.name) details.push({ label: '功能检查', value: draft.service.name, badge: '检查' })
      if (draft?.indication) details.push({ label: '检查指征', value: truncateText(draft.indication), badge: null })
    } else if (op.id === 'encounter.imaging-request.issue') {
      const draft = (liveCase?.imagingRequests as {
        draft?: { indication?: string; service?: { name?: string } }
      } | undefined)?.draft
      if (draft?.service?.name) details.push({ label: '影像检查', value: draft.service.name, badge: '影像' })
      if (draft?.indication) details.push({ label: '检查指征', value: truncateText(draft.indication), badge: null })
    } else if (op.id === 'encounter.pathology-request.issue') {
      const draft = (liveCase?.pathologyRequests as {
        draft?: { purpose?: string; service?: { name?: string } }
      } | undefined)?.draft
      if (draft?.service?.name) details.push({ label: '病理检查', value: draft.service.name, badge: '病理' })
      if (draft?.purpose) details.push({ label: '会诊目的', value: truncateText(draft.purpose), badge: null })
    } else if (op.id === 'encounter.diagnosis.confirm') {
      const entries = ((liveCase?.diagnosis as {
        draft?: { entries?: Array<{ role?: string; display?: string; nameZh?: string; code?: string; referenceConcept?: { nameZh?: string; code?: string }; catalogItemId?: string }> }
      } | undefined)?.draft?.entries) ?? []
      for (const entry of entries.slice(0, 6)) {
        const title = entry.referenceConcept?.nameZh ?? entry.display ?? entry.nameZh ?? entry.code ?? entry.catalogItemId ?? '诊断'
        const code = entry.referenceConcept?.code ?? entry.code
        details.push({
          label: entry.role === 'primary' ? '主诊断' : '次要诊断',
          value: code ? `${title}（${code}）` : title,
          badge: entry.role === 'primary' ? '主诊断' : '次诊断',
        })
      }
    } else if (op.id === 'encounter.clinical-document.sign') {
      const draftObj = (liveCase?.clinicalDocument as {
        draft?: Record<string, unknown> & { content?: Record<string, unknown> }
      } | undefined)?.draft
      const docContent = draftObj?.content ?? draftObj
      if (typeof docContent?.chiefComplaint === 'string' && docContent.chiefComplaint.trim()) {
        details.push({ label: '主诉', value: truncateText(docContent.chiefComplaint), badge: '病历' })
      }
      if (typeof docContent?.assessment === 'string' && docContent.assessment.trim()) {
        details.push({ label: '初步评估', value: truncateText(docContent.assessment), badge: null })
      }
      if (typeof docContent?.disposition === 'string' && docContent.disposition.trim()) {
        details.push({ label: '处置计划', value: truncateText(docContent.disposition), badge: null })
      }
    } else if (op.id === 'encounter.prescription.issue') {
      const items = ((liveCase?.medicationConclusion as {
        draft?: { items?: Array<{ medicationNameZh?: string; display?: string; doseText?: string; frequencyCode?: string; quantity?: number }> }
      } | undefined)?.draft?.items) ?? []
      for (const it of items.slice(0, 6)) {
        const name = it.medicationNameZh ?? it.display ?? '药品'
        const spec = [it.doseText, it.frequencyCode, it.quantity ? `×${it.quantity}` : ''].filter(Boolean).join(' ')
        details.push({ label: name, value: spec || '按草稿方案开立', badge: '处方' })
      }
    }

    if (details.length <= 1 && rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
        if (TECHNICAL_ARG_KEYS.has(k) || v === undefined || v === null) continue
        const rendered = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? truncateText(String(v), 80)
          : truncateText(JSON.stringify(v), 80)
        if (rendered) details.push({ label: k, value: rendered, badge: null })
        if (details.length >= 6) break
      }
    }
    return details
  }

  // Blacklist-first: exclude ONLY hard-blacklisted auth/agent ops; everything else in catalog is exposed
  const exposableOps = hisOperationCatalog.filter(op => !isHardBlacklistedHisOperation(op))

  const buckets: Record<string, ToolRegistration[]> = {
    clinical_case: [],
    diagnostics: [],
    therapy: [],
    cds: [],
    finance: [],
  }
  const toolsByRole = new Map<string, ToolRegistration[]>()
  const allCatalogTools: ToolRegistration[] = []

  const nsMeta: Record<string, { desc: string; instructions: string }> = {
    clinical_case: {
      desc: '门诊/住院病例详情、病历草稿/预签/签署、完诊预览与完诊',
      instructions: '读病例用 doctor_case_get({ caseId })；草稿和预签可直接在 codemode 内执行；正式签署和完诊需经 tool_search 加载后由模型直接调用以弹出医生确认卡片。',
    },
    diagnostics: {
      desc: '检验、影像、功能检查、病理申请草稿与报告已阅确认',
      instructions: '检验报告数值直接包含在 doctor_case_get 返回的 laboratoryReports 中；申请草稿可自主保存，正式开立会弹出医生确认卡片。',
    },
    therapy: {
      desc: '门诊/住院诊断、处方、用药结论、分诊与住院医嘱/出院管理',
      instructions: '草稿工具可自主调用；确诊、开方、确认无需用药、住院医嘱开立/停嘱与出院办理均会触发医生确认卡片。',
    },
    cds: {
      desc: '专病临床评分、指南主题、医嘱组草稿、风险评估与临床质控门禁',
      instructions: '均为只读或低风险评估工具，可在 codemode 内用 Promise.all 并行读取。',
    },
    finance: {
      desc: '临床诊断/药品/服务参考目录、挂号与收费退款预览确认',
      instructions: '写病历/诊断/处方前先用 catalog_clinical_read({}) 查询有效目录 ID。',
    },
  }

  for (const op of exposableOps) {
    const domain = classifyDomain(op)
    const schema = sanitizeJsonSchema(op.input)
    const needsApproval = requiresClinicianApproval(op)
    const toolName = hisOpToToolName(op.id)

    type ApprovalCheckpoint = {
      approvalId: string
      operationId: string
      args: JsonValue
    }

    const tool = defineTool<typeof schema, JsonValue, ApprovalCheckpoint>({
      name: toolName,
      description: needsApproval
        ? `[${op.mode}/需医生确认] ${op.summary}`
        : `[${op.mode}/${op.risk}] ${op.summary}`,
      parameters: schema,
      structuredOutputSchema: { type: 'object' },
      deferred: true,
      callers: needsApproval ? ['model'] : ['model', 'tools'],
      replay: op.risk === 'read' ? 'safe' : 'unsafe',
      execute: async (rawArgs, api: ToolExecutionApi<JsonValue, ApprovalCheckpoint>, context) => {
        if (needsApproval) {
          if (api.wake === undefined) {
            // Park until the clinician explicitly approves or rejects in the sidebar!
            const approvalId = `appr-${randomUUID().slice(0, 12)}`
            const nowMs = api.now()
            const expiresAtMs = nowMs + APPROVAL_TIMEOUT_MS
            const approvalDetails = await buildApprovalDetails(api.conversationId, op, rawArgs)
            const approvalRecord: StoredPendingApproval = {
              approvalId,
              taskId: api.taskId,
              callId: api.callId,
              operationId: op.id,
              toolName,
              title: formatApprovalTitle(op),
              summary: formatApprovalSummary(op),
              risk: op.risk === 'high-risk-write' ? 'high-risk-write' : 'write',
              details: approvalDetails,
              argumentsPreview: previewArgs(rawArgs),
              createdAt: new Date(nowMs).toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
            }
            await api.commit(async (tx) => {
              const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
              doc.items = [...doc.items.filter(i => i.approvalId !== approvalId), approvalRecord]
            }, context)
            options.devReflection?.recordApprovalParked(api.conversationId, op.id)

            const park: ToolPark<ApprovalCheckpoint> = {
              kind: 'sleep',
              signals: [ClinicianApprovalSignal.key(approvalId)],
              until: expiresAtMs,
              checkpoint: {
                approvalId,
                operationId: op.id,
                args: toJsonValue(rawArgs),
              },
            }
            return park
          }

          // Woken from park: clear pending card and inspect clinician decision
          const checkpoint = api.checkpoint
          const approvalId = checkpoint?.approvalId ?? ''
          if (approvalId) {
            await api.commit(async (tx) => {
              const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
              doc.items = doc.items.filter(i => i.approvalId !== approvalId)
            }, context)
          }

          const signalState = approvalId
            ? await api.readSignal(ClinicianApprovalSignal, approvalId, context)
            : undefined

          if (signalState === undefined || signalState.kind === 'expired') {
            const payload = {
              approved: false,
              reason: 'DOCTOR_APPROVAL_TIMEOUT',
              message: `医生确认已超时（${formatApprovalTitle(op)}），未执行任何写入。请询问医生是否需要重新发起确认。`,
            }
            return {
              isError: true,
              output: [{ type: 'text', text: JSON.stringify(payload) }],
              structuredOutput: payload,
            }
          }

          if (!signalState.value.approved) {
            const payload = {
              approved: false,
              reason: signalState.value.reason ?? 'DOCTOR_REJECTED',
              message: `医生已拒绝执行「${formatApprovalTitle(op)}」${signalState.value.reason ? `（备注：${signalState.value.reason}）` : ''}。严禁擅自重试或绕过，请等待医生新指令。`,
            }
            return {
              isError: true,
              output: [{ type: 'text', text: JSON.stringify(payload) }],
              structuredOutput: payload,
            }
          }
        }

        // Execute real HIS operation through in-process Hono app (full RBAC + Zod + FHIR + Audit)
        try {
          const raw = await executeHisOperation(api.conversationId, op.id, rawArgs)
          const compact = compactHisOperationOutput(op.id, raw)
          const structured = (compact !== null && typeof compact === 'object' && !Array.isArray(compact))
            ? toJsonValue(compact)
            : toJsonValue({ value: compact })
          return {
            output: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredOutput: structured,
          }
        } catch (error) {
          const errText = error instanceof Error ? error.message : String(error)
          return {
            isError: true,
            output: [{ type: 'text', text: errText }],
          }
        }
      },
      cancel: async (_args, api, context) => {
        const approvalId = api.checkpoint?.approvalId
        if (!approvalId) return
        await api.commit(async (tx) => {
          const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
          doc.items = doc.items.filter(i => i.approvalId !== approvalId)
        }, context).catch(() => undefined)
      },
    })

    buckets[domain]!.push(tool)
    allCatalogTools.push(tool)
    for (const role of op.roles) {
      const list = toolsByRole.get(role) ?? []
      list.push(tool)
      toolsByRole.set(role, list)
    }
  }

  const domainExtensions = Object.entries(buckets).map(([domain, tools]) =>
    defineExtension({
      name: `clinmesh.${domain}`,
      namespace: {
        name: domain,
        description: nsMeta[domain]!.desc,
        instructions: nsMeta[domain]!.instructions,
      },
      tools,
    }),
  )

  // Eager Clinical Workflow Macros + Playbook
  const macroTools: ToolRegistration[] = [
    defineTool({
      name: 'macro_clinical_briefing',
      description: '【临床工作流宏】一次性并行读取门诊可见病例、分诊生命体征、已发布检验报告、专病临床评分与完诊预览（紧凑投影）。',
      parameters: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: '门诊病例 caseId（可省略，默认取当前会话绑定病例）' },
          encounterId: { type: 'string', description: '门诊接诊 encounterId（可省略，默认取当前会话绑定接诊）' },
        },
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'safe',
      execute: async (raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const args = (raw ?? {}) as { caseId?: string; encounterId?: string }
        const caseId = args.caseId ?? auth?.caseId
        const encounterId = args.encounterId ?? auth?.encounterId
        if (!caseId) {
          return { isError: true, output: [{ type: 'text', text: '缺少 caseId，请打开一个门诊病例或在参数中传入 caseId。' }] }
        }
        try {
          const [caseDetail, scores, completion] = await Promise.all([
            executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }),
            executeHisOperation(api.conversationId, 'doctor.case.clinical-scores.read', { caseId }),
            encounterId
              ? executeHisOperation(api.conversationId, 'encounter.completion.preview', { encounterId })
              : Promise.resolve(null),
          ])
          return {
            output: [{
              type: 'text',
              text: JSON.stringify({
                case: compactHisOperationOutput('doctor.case.get', caseDetail),
                clinicalScores: compactHisOperationOutput('doctor.case.clinical-scores.read', scores),
                completionPreview: completion,
              }),
            }],
          }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
    defineTool({
      name: 'macro_safety_completion_audit',
      description: '【临床工作流宏】只读并行核查门诊完诊门禁、临床质控、专病评分、指南主题与医嘱组草稿适用性。',
      parameters: {
        type: 'object',
        properties: {
          caseId: { type: 'string' },
          encounterId: { type: 'string' },
        },
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'safe',
      execute: async (raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const args = (raw ?? {}) as { caseId?: string; encounterId?: string }
        const caseId = args.caseId ?? auth?.caseId
        const encounterId = args.encounterId ?? auth?.encounterId
        if (!caseId || !encounterId) {
          return { isError: true, output: [{ type: 'text', text: '缺少 caseId 或 encounterId。' }] }
        }
        try {
          const [caseDetail, completion, quality, scores, guidelines, orderSets] = await Promise.all([
            executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }),
            executeHisOperation(api.conversationId, 'encounter.completion.preview', { encounterId }),
            executeHisOperation(api.conversationId, 'encounter.clinical-quality.read', { encounterId, gate: 'outpatient-completion' }),
            executeHisOperation(api.conversationId, 'doctor.case.clinical-scores.read', { caseId }),
            executeHisOperation(api.conversationId, 'doctor.case.guideline-topics.read', { caseId }),
            executeHisOperation(api.conversationId, 'doctor.case.order-set-drafts.read', { caseId }),
          ])
          return {
            output: [{
              type: 'text',
              text: JSON.stringify({
                caseSummary: compactHisOperationOutput('doctor.case.get', caseDetail),
                completionPreview: completion,
                clinicalQuality: quality,
                clinicalScores: compactHisOperationOutput('doctor.case.clinical-scores.read', scores),
                guidelineTopics: compactHisOperationOutput('doctor.case.guideline-topics.read', guidelines),
                orderSetDrafts: compactHisOperationOutput('doctor.case.order-set-drafts.read', orderSets),
              }),
            }],
          }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
    defineTool({
      name: 'macro_outpatient_write_preflight',
      description: '【临床工作流宏】一次性读取最新 encounterVersion、病历/诊断/处方草稿版本、完诊阻断项及有效诊断/药品目录 ID，为自动写病历/诊断/处方做好准备。',
      parameters: {
        type: 'object',
        properties: {
          caseId: { type: 'string' },
          encounterId: { type: 'string' },
        },
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'safe',
      execute: async (raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const args = (raw ?? {}) as { caseId?: string; encounterId?: string }
        const caseId = args.caseId ?? auth?.caseId
        const encounterId = args.encounterId ?? auth?.encounterId
        if (!caseId || !encounterId) {
          return { isError: true, output: [{ type: 'text', text: '缺少 caseId 或 encounterId。' }] }
        }
        try {
          const [caseDetail, catalog, completion] = await Promise.all([
            executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }),
            executeHisOperation(api.conversationId, 'catalog.clinical.read', {}),
            executeHisOperation(api.conversationId, 'encounter.completion.preview', { encounterId }),
          ])
          return {
            output: [{
              type: 'text',
              text: JSON.stringify({
                case: compactHisOperationOutput('doctor.case.get', caseDetail),
                catalog: compactHisOperationOutput('catalog.clinical.read', catalog),
                completionPreview: completion,
              }),
            }],
          }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
    defineTool({
      name: 'read_clinical_playbook',
      description: '按需加载临床任务操作手册（简报/安全审计/门诊自动写病历与完诊闭环/住院流程/前端表单协同）。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: [
              'outpatient-briefing',
              'outpatient-safety-audit',
              'outpatient-e2e-write',
              'inpatient-workflow',
              'frontend-ui-collab',
            ],
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      callers: ['model'],
      replay: 'safe',
      execute: async (raw) => {
        const { name } = raw as { name: string }
        return { output: [{ type: 'text', text: DOMAIN_PLAYBOOKS[name] ?? 'Unknown playbook' }] }
      },
    }),
    defineTool({
      name: 'list_agent_capabilities',
      description: '查看当前角色的「黑名单默认放行」权限策略、可执行的全部事件清单（感知/切栏导航/起草填表/沙箱检索/安全核验/高危确认/撤销）以及需医生确认的高危操作清单。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'safe',
      execute: async (_raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const manifest = buildRoleAgentCapabilitiesManifest(auth?.roleCode ?? 'outpatient-doctor')
        return {
          output: [{ type: 'text', text: JSON.stringify(manifest) }],
        }
      },
    }),
    defineTool({
      name: 'macro_consultation_ask',
      description: '【门诊问诊快捷宏】一步向当前合成患者发送问诊问题并直接获取患者回复。内部自动读取最新 encounterVersion、consultation.version 与 taskVersion，严禁手动循环试探版本号。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '要向患者提出的问题（可一次性合并 2-4 个关键追问）' },
          caseId: { type: 'string', description: '可选，默认使用当前绑定病例' },
          encounterId: { type: 'string', description: '可选，默认使用当前绑定接诊' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'unsafe',
      execute: async (raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const args = (raw ?? {}) as { message?: string; caseId?: string; encounterId?: string }
        const caseId = args.caseId ?? auth?.caseId
        const message = args.message?.trim() ?? ''
        if (!caseId || !message) {
          return { isError: true, output: [{ type: 'text', text: '缺少 caseId 或提问内容 message。' }] }
        }
        try {
          const rawCase = await executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }) as {
            encounter?: { id?: string; versionId?: string }
            taskId?: string
            taskVersion?: string
            consultation?: { version?: number; turns?: Array<{ kind?: string; speaker?: string; messageText?: string }> }
          }
          const encounterId = args.encounterId ?? rawCase.encounter?.id ?? auth?.encounterId
          const encounterVersion = rawCase.encounter?.versionId
          const taskId = rawCase.taskId
          const taskVersion = rawCase.taskVersion
          const consultationVersion = rawCase.consultation?.version
          if (!encounterId || !encounterVersion || !taskId || !taskVersion || typeof consultationVersion !== 'number') {
            return {
              isError: true,
              output: [{ type: 'text', text: '当前病例未处于可问诊状态或缺少问诊版本号，请确认已接诊。' }],
            }
          }

          // If previous doctor question is still unanswered, retry its patient reply first
          const turns = rawCase.consultation?.turns ?? []
          const lastText = [...turns].reverse().find(t => t.kind === 'text')
          if (lastText?.speaker === 'doctor') {
            await executeHisOperation(api.conversationId, 'encounter.consultation.reply.retry', {
              encounterId,
              expectedConsultationVersion: consultationVersion,
            })
            const refreshed = await executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }) as typeof rawCase
            const nextConsultVersion = refreshed.consultation?.version ?? consultationVersion
            const askRes = await executeHisOperation(api.conversationId, 'encounter.consultation.ask', {
              encounterId,
              encounterVersion: refreshed.encounter?.versionId ?? encounterVersion,
              expectedConsultationVersion: nextConsultVersion,
              taskId: refreshed.taskId ?? taskId,
              taskVersion: refreshed.taskVersion ?? taskVersion,
              message,
            }) as { data?: { consultationVersion?: number; patientTurn?: { messageText?: string }; doctorTurn?: { messageText?: string } } }
            return {
              output: [{
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  consultationVersion: askRes.data?.consultationVersion,
                  doctorMessage: askRes.data?.doctorTurn?.messageText ?? message,
                  patientReply: askRes.data?.patientTurn?.messageText ?? null,
                }),
              }],
            }
          }

          const askRes = await executeHisOperation(api.conversationId, 'encounter.consultation.ask', {
            encounterId,
            encounterVersion,
            expectedConsultationVersion: consultationVersion,
            taskId,
            taskVersion,
            message,
          }) as { data?: { consultationVersion?: number; patientTurn?: { messageText?: string }; doctorTurn?: { messageText?: string } } }

          return {
            output: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                consultationVersion: askRes.data?.consultationVersion,
                doctorMessage: askRes.data?.doctorTurn?.messageText ?? message,
                patientReply: askRes.data?.patientTurn?.messageText ?? null,
              }),
            }],
          }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
    defineTool({
      name: 'macro_search_clinical_catalog',
      description: '【临床目录批量检索宏】一次按多个关键词（支持 2 字简写如“血脂/肝功/肾功/血糖”）并行查询有效的检验/功能检查/影像/病理/诊断/药品目录 ID，返回极简结果永不截断。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['laboratory', 'examination', 'imaging', 'pathology', 'diagnosis', 'medication'],
          },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: '可选关键词列表（功能检查/影像/病理留空可一次返回本院全部可用项目）',
          },
          caseId: { type: 'string' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      callers: ['model', 'tools'],
      replay: 'safe',
      execute: async (raw, api) => {
        const auth = options.getAuthContext(api.conversationId)
        const args = (raw ?? {}) as { kind: string; queries?: string[]; caseId?: string }
        const caseId = args.caseId ?? auth?.caseId
        const queries = (args.queries ?? []).map(q => q.trim()).filter(Boolean)

        try {
          if (args.kind === 'examination' || args.kind === 'imaging' || args.kind === 'pathology') {
            if (!caseId) return { isError: true, output: [{ type: 'text', text: '缺少 caseId。' }] }
            const opId = args.kind === 'examination'
              ? 'doctor.case.examination-services.list'
              : args.kind === 'imaging'
                ? 'doctor.case.imaging-services.list'
                : 'doctor.case.pathology-services.list'
            const data = compactHisOperationOutput(opId, await executeHisOperation(api.conversationId, opId, { caseId })) as {
              items?: Array<{ available?: boolean; id?: string; code?: string; name?: string; department?: string }>
            }
            const allItems = data.items ?? []
            const filtered = queries.length === 0
              ? allItems
              : allItems.filter(it => queries.some(q => (it.name ?? '').toLowerCase().includes(q.toLowerCase()) || (it.code ?? '').toLowerCase().includes(q.toLowerCase())))
            return { output: [{ type: 'text', text: JSON.stringify({ kind: args.kind, items: filtered.length > 0 ? filtered : allItems }) }] }
          }

          if (args.kind === 'laboratory') {
            if (!caseId) return { isError: true, output: [{ type: 'text', text: '缺少 caseId。' }] }
            const keywords = queries.length > 0 ? queries : ['血常规', '肌钙蛋白', '肝功', '肾功']
            const results: Record<string, unknown> = {}
            await Promise.all(keywords.map(async (kw) => {
              const expanded = LAB_SHORT_QUERY_EXPANSIONS[kw] ?? (kw.length < 3 ? `${kw}测定` : kw)
              try {
                const rawRes = await executeHisOperation(api.conversationId, 'doctor.case.laboratory-catalog.search', {
                  caseId,
                  query: expanded,
                  page: 1,
                  pageSize: 8,
                })
                results[kw] = (compactHisOperationOutput('doctor.case.laboratory-catalog.search', rawRes) as { items?: unknown[] }).items ?? []
              } catch (err) {
                results[kw] = { error: err instanceof Error ? err.message : String(err) }
              }
            }))
            return { output: [{ type: 'text', text: JSON.stringify({ kind: 'laboratory', results }) }] }
          }

          if (args.kind === 'diagnosis' || args.kind === 'medication') {
            const opId = args.kind === 'diagnosis' ? 'reference.diagnoses.search' : 'reference.medications.search'
            const keywords = queries.length > 0 ? queries : ['高血压']
            const results: Record<string, unknown> = {}
            await Promise.all(keywords.map(async (kw) => {
              const effectiveQuery = kw.length < 2 ? `${kw} ` : kw
              try {
                const rawRes = await executeHisOperation(api.conversationId, opId, {
                  query: effectiveQuery.trim(),
                  page: 1,
                  pageSize: 8,
                })
                results[kw] = (compactHisOperationOutput(opId, rawRes) as { items?: unknown[] }).items ?? []
              } catch (err) {
                results[kw] = { error: err instanceof Error ? err.message : String(err) }
              }
            }))
            return { output: [{ type: 'text', text: JSON.stringify({ kind: args.kind, results }) }] }
          }

          return { isError: true, output: [{ type: 'text', text: `Unsupported catalog kind: ${args.kind}` }] }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      },
    }),
    (() => {
      type BatchConfirmInput = {
        title?: string
        caseId?: string
        encounterId?: string
        signClinicalDocument?: boolean
        confirmDiagnosis?: boolean
        laboratoryRequests?: Array<{ catalogItemId: string; serviceName: string; indicationCode?: string }>
        examinationRequests?: Array<{ serviceId: string; serviceName: string; indication: string }>
        imagingRequests?: Array<{ serviceId: string; serviceName: string; indication: string }>
        pathologyRequests?: Array<{ serviceId: string; serviceName: string; purpose: string; sourceProcedureReference: string }>
        issuePrescription?: boolean
        confirmNoMedicationReason?: string
        completeEncounter?: boolean
      }
      type BatchCheckpoint = { approvalId: string; args: JsonValue }
      const batchParams = {
        type: 'object',
        properties: {
          title: { type: 'string', description: '确认卡片标题（如“批量开立胸痛检验与心电图”）' },
          caseId: { type: 'string' },
          encounterId: { type: 'string' },
          signClinicalDocument: { type: 'boolean', description: '正式签署当前已保存的结构化病历草稿（若已签署则自动跳过）' },
          confirmDiagnosis: { type: 'boolean', description: '正式确认当前已保存的诊断草稿（若已确认则自动跳过）' },
          laboratoryRequests: {
            type: 'array',
            description: '批量开立检验申请列表（后端按顺序自动存草稿并签发，只需医生一次确认）',
            items: {
              type: 'object',
              properties: {
                catalogItemId: { type: 'string' },
                serviceName: { type: 'string', description: '中文项目名称（用于确认卡片清晰展示）' },
                indicationCode: { type: 'string', description: '默认 clinical-evaluation' },
              },
              required: ['catalogItemId', 'serviceName'],
            },
          },
          examinationRequests: {
            type: 'array',
            description: '批量开立功能检查列表（如心电图 ECG-12、心脏超声 TTE）',
            items: {
              type: 'object',
              properties: {
                serviceId: { type: 'string' },
                serviceName: { type: 'string' },
                indication: { type: 'string' },
              },
              required: ['serviceId', 'serviceName', 'indication'],
            },
          },
          imagingRequests: {
            type: 'array',
            description: '批量开立影像检查列表（如胸片、CT、MRI）',
            items: {
              type: 'object',
              properties: {
                serviceId: { type: 'string' },
                serviceName: { type: 'string' },
                indication: { type: 'string' },
              },
              required: ['serviceId', 'serviceName', 'indication'],
            },
          },
          pathologyRequests: {
            type: 'array',
            description: '批量开立病理会诊列表',
            items: {
              type: 'object',
              properties: {
                serviceId: { type: 'string' },
                serviceName: { type: 'string' },
                purpose: { type: 'string' },
                sourceProcedureReference: { type: 'string' },
              },
              required: ['serviceId', 'serviceName', 'purpose', 'sourceProcedureReference'],
            },
          },
          issuePrescription: { type: 'boolean', description: '正式签发当前已保存的处方草稿' },
          confirmNoMedicationReason: { type: 'string', description: '若本次无需用药，填写理由以一并登记无需用药结论' },
          completeEncounter: { type: 'boolean', description: '在所有前置步骤完成后一并办理完诊' },
        },
        additionalProperties: false,
      }

      return defineTool<typeof batchParams, JsonValue, BatchCheckpoint>({
        name: 'batch_confirm_clinical_orders',
        description: '【统一批量确认提交（1 张卡片一次确认）】将多项高危正式提交（签署病历、确认诊断、多项检验、功能检查、影像、病理、处方签发、完诊）合并为 1 张可读清单由医生一键确认后由后端自动刷新版本顺序执行，彻底避免逐项弹窗打扰医生。',
        parameters: batchParams,
        callers: ['model'],
        replay: 'unsafe',
        execute: async (raw, api: ToolExecutionApi<JsonValue, BatchCheckpoint>, context) => {
          const auth = options.getAuthContext(api.conversationId)
          const input = (raw ?? {}) as BatchConfirmInput
          const caseId = input.caseId ?? auth?.caseId
          if (!caseId) {
            return { isError: true, output: [{ type: 'text', text: '缺少 caseId。' }] }
          }

          if (api.wake === undefined) {
            const details: StoredApprovalDetailItem[] = []
            let liveCase: Record<string, unknown> | null = null
            try {
              const fetched = await executeHisOperation(api.conversationId, 'doctor.case.get', { caseId })
              if (fetched && typeof fetched === 'object') liveCase = fetched as Record<string, unknown>
            } catch {
              // continue with explicit names
            }

            if (input.signClinicalDocument) {
              const draftObj = (liveCase?.clinicalDocument as {
                draft?: { chiefComplaint?: string; content?: { chiefComplaint?: string } }
              } | undefined)?.draft
              const cc = draftObj?.chiefComplaint ?? draftObj?.content?.chiefComplaint
              details.push({
                label: '正式签署门诊病历',
                value: cc ? `主诉：${truncateText(cc, 48)}` : '按当前病历草稿电子签名',
                badge: '病历',
              })
            }
            if (input.confirmDiagnosis) {
              const entries = ((liveCase?.diagnosis as { draft?: { entries?: Array<{ display?: string; nameZh?: string; code?: string; referenceConcept?: { nameZh?: string; code?: string }; catalogItemId?: string }> } } | undefined)?.draft?.entries) ?? []
              const summary = entries.length > 0
                ? entries.map(e => {
                    const name = e.referenceConcept?.nameZh ?? e.display ?? e.nameZh ?? e.catalogItemId
                    const code = e.referenceConcept?.code ?? e.code
                    return `${name}${code ? `(${code})` : ''}`
                  }).join('、')
                : '按当前诊断草稿确认'
              details.push({ label: '正式确认临床诊断', value: truncateText(summary, 72), badge: '诊断' })
            }
            for (const exam of input.examinationRequests ?? []) {
              details.push({ label: exam.serviceName, value: truncateText(exam.indication, 56), badge: '功能检查' })
            }
            for (const img of input.imagingRequests ?? []) {
              details.push({ label: img.serviceName, value: truncateText(img.indication, 56), badge: '影像' })
            }
            for (const lab of input.laboratoryRequests ?? []) {
              details.push({
                label: lab.serviceName,
                value: formatIndicationLabel(lab.indicationCode ?? 'clinical-evaluation'),
                badge: '检验',
              })
            }
            for (const path of input.pathologyRequests ?? []) {
              details.push({ label: path.serviceName, value: truncateText(path.purpose, 56), badge: '病理' })
            }
            if (input.issuePrescription) {
              const items = ((liveCase?.medicationConclusion as { draft?: { items?: Array<{ medicationNameZh?: string; display?: string }> } } | undefined)?.draft?.items) ?? []
              details.push({
                label: '正式签发门诊处方',
                value: items.length > 0 ? items.map(i => i.medicationNameZh ?? i.display).join('、') : '按当前处方草稿签发',
                badge: '处方',
              })
            }
            if (input.confirmNoMedicationReason) {
              details.push({ label: '确认无需用药', value: truncateText(input.confirmNoMedicationReason, 60), badge: '用药结论' })
            }
            if (input.completeEncounter) {
              details.push({ label: '正式完诊', value: '完成本次门诊接诊并锁定文书', badge: '完诊' })
            }

            if (details.length === 0) {
              return { isError: true, output: [{ type: 'text', text: 'batch_confirm_clinical_orders 未指定任何待确认操作。' }] }
            }

            const approvalId = `appr-${randomUUID().slice(0, 12)}`
            const nowMs = api.now()
            const expiresAtMs = nowMs + APPROVAL_TIMEOUT_MS
            const approvalRecord: StoredPendingApproval = {
              approvalId,
              taskId: api.taskId,
              callId: api.callId,
              operationId: 'batch.clinical-orders.confirm',
              toolName: 'batch_confirm_clinical_orders',
              title: input.title?.trim() || `批量确认临床提交（共 ${details.length} 项）`,
              summary: `以下 ${details.length} 项临床操作已准备就绪，确认后将按临床门禁顺序一次性自动落库。`,
              risk: 'high-risk-write',
              details,
              argumentsPreview: previewArgs(input),
              createdAt: new Date(nowMs).toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
            }

            await api.commit(async (tx) => {
              const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
              doc.items = [...doc.items.filter(i => i.approvalId !== approvalId), approvalRecord]
            }, context)
            options.devReflection?.recordApprovalParked(api.conversationId, 'batch.clinical-orders.confirm')

            return {
              kind: 'sleep',
              signals: [ClinicianApprovalSignal.key(approvalId)],
              until: expiresAtMs,
              checkpoint: { approvalId, args: toJsonValue(input) },
            }
          }

          const approvalId = api.checkpoint?.approvalId ?? ''
          if (approvalId) {
            await api.commit(async (tx) => {
              const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
              doc.items = doc.items.filter(i => i.approvalId !== approvalId)
            }, context)
          }

          const signalState = approvalId
            ? await api.readSignal(ClinicianApprovalSignal, approvalId, context)
            : undefined

          if (signalState === undefined || signalState.kind === 'expired') {
            return {
              isError: true,
              output: [{ type: 'text', text: JSON.stringify({ approved: false, reason: 'DOCTOR_APPROVAL_TIMEOUT', message: '批量确认已超时，未执行任何提交。' }) }],
            }
          }

          if (!signalState.value.approved) {
            return {
              isError: true,
              output: [{ type: 'text', text: JSON.stringify({ approved: false, reason: signalState.value.reason ?? 'DOCTOR_REJECTED', message: '医生已拒绝本次批量提交，未执行任何写入。请按医生新指令调整方案。' }) }],
            }
          }

          // Clinician approved ONCE -> execute every item in clinical gate order with fresh versions!
          const readFresh = async () => executeHisOperation(api.conversationId, 'doctor.case.get', { caseId }) as Promise<{
            encounter: { id: string; versionId: string }
            clinicalDocument?: { draft?: { version?: number }; signed?: unknown[] }
            diagnosis?: { draftVersion?: number; confirmation?: unknown }
            laboratoryRequests?: { draftVersion?: number }
            examinationRequests?: { draftVersion?: number }
            imagingRequests?: { draftVersion?: number }
            pathologyRequests?: { draftVersion?: number }
            medicationConclusion?: { draftVersion?: number }
          }>

          const receipt: Array<{ step: string; ok: boolean; detail?: string; error?: string }> = []

          // 1. Sign clinical document first (unlocks outpatient order gate!)
          if (input.signClinicalDocument) {
            try {
              const fresh = await readFresh()
              const alreadySigned = (fresh.clinicalDocument?.signed?.length ?? 0) > 0
              if (alreadySigned) {
                receipt.push({ step: '签署门诊病历', ok: true, detail: '病历已签署，自动跳过' })
              } else {
                const draftVersion = fresh.clinicalDocument?.draft?.version ?? 1
                const preview = await executeHisOperation(api.conversationId, 'encounter.clinical-document.sign.preview', {
                  encounterId: fresh.encounter.id,
                  encounterVersion: fresh.encounter.versionId,
                  expectedDraftVersion: draftVersion,
                }) as { data?: { previewId?: string; commitToken?: string } }
                const fresh2 = await readFresh()
                await executeHisOperation(api.conversationId, 'encounter.clinical-document.sign', {
                  encounterId: fresh2.encounter.id,
                  encounterVersion: fresh2.encounter.versionId,
                  previewId: preview.data?.previewId ?? '',
                  commitToken: preview.data?.commitToken ?? '',
                })
                receipt.push({ step: '签署门诊病历', ok: true, detail: '已正式电子签名' })
              }
            } catch (err) {
              receipt.push({ step: '签署门诊病历', ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 2. Confirm diagnosis
          if (input.confirmDiagnosis) {
            try {
              const fresh = await readFresh()
              if (fresh.diagnosis?.confirmation) {
                receipt.push({ step: '确认临床诊断', ok: true, detail: '诊断已确认，自动跳过' })
              } else {
                await executeHisOperation(api.conversationId, 'encounter.diagnosis.confirm', {
                  encounterId: fresh.encounter.id,
                  encounterVersion: fresh.encounter.versionId,
                  expectedDraftVersion: fresh.diagnosis?.draftVersion ?? 1,
                })
                receipt.push({ step: '确认临床诊断', ok: true, detail: '已确认落库' })
              }
            } catch (err) {
              receipt.push({ step: '确认临床诊断', ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 3. Issue examination requests (ECG / TTE)
          for (const exam of input.examinationRequests ?? []) {
            try {
              const fresh = await readFresh()
              const saved = await executeHisOperation(api.conversationId, 'encounter.examination-request.draft.set', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.examinationRequests?.draftVersion ?? 0,
                serviceId: exam.serviceId,
                indication: exam.indication,
              }) as { data?: { draftVersion?: number } }
              const freshAfterDraft = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.examination-request.issue', {
                encounterId: freshAfterDraft.encounter.id,
                encounterVersion: freshAfterDraft.encounter.versionId,
                expectedDraftVersion: saved.data?.draftVersion ?? freshAfterDraft.examinationRequests?.draftVersion ?? 1,
              })
              receipt.push({ step: `功能检查：${exam.serviceName}`, ok: true, detail: '已开立' })
            } catch (err) {
              receipt.push({ step: `功能检查：${exam.serviceName}`, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 4. Issue imaging requests
          for (const img of input.imagingRequests ?? []) {
            try {
              const fresh = await readFresh()
              const saved = await executeHisOperation(api.conversationId, 'encounter.imaging-request.draft.set', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.imagingRequests?.draftVersion ?? 0,
                serviceId: img.serviceId,
                indication: img.indication,
              }) as { data?: { draftVersion?: number } }
              const freshAfterDraft = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.imaging-request.issue', {
                encounterId: freshAfterDraft.encounter.id,
                encounterVersion: freshAfterDraft.encounter.versionId,
                expectedDraftVersion: saved.data?.draftVersion ?? freshAfterDraft.imagingRequests?.draftVersion ?? 1,
              })
              receipt.push({ step: `影像检查：${img.serviceName}`, ok: true, detail: '已开立' })
            } catch (err) {
              receipt.push({ step: `影像检查：${img.serviceName}`, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 5. Issue laboratory requests sequentially with fresh draftVersion each time
          for (const lab of input.laboratoryRequests ?? []) {
            try {
              const fresh = await readFresh()
              const saved = await executeHisOperation(api.conversationId, 'encounter.laboratory-request.draft.set', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.laboratoryRequests?.draftVersion ?? 0,
                catalogItemId: lab.catalogItemId,
                indicationCode: lab.indicationCode ?? 'clinical-evaluation',
              }) as { data?: { draftVersion?: number } }
              const freshAfterDraft = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.laboratory-request.issue', {
                encounterId: freshAfterDraft.encounter.id,
                encounterVersion: freshAfterDraft.encounter.versionId,
                expectedDraftVersion: saved.data?.draftVersion ?? freshAfterDraft.laboratoryRequests?.draftVersion ?? 1,
              })
              receipt.push({ step: `检验：${lab.serviceName}`, ok: true, detail: '已开立' })
            } catch (err) {
              receipt.push({ step: `检验：${lab.serviceName}`, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 6. Issue pathology requests
          for (const path of input.pathologyRequests ?? []) {
            try {
              const fresh = await readFresh()
              const saved = await executeHisOperation(api.conversationId, 'encounter.pathology-request.draft.set', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.pathologyRequests?.draftVersion ?? 0,
                serviceId: path.serviceId,
                purpose: path.purpose,
                sourceProcedureReference: path.sourceProcedureReference,
              }) as { data?: { draftVersion?: number } }
              const freshAfterDraft = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.pathology-request.issue', {
                encounterId: freshAfterDraft.encounter.id,
                encounterVersion: freshAfterDraft.encounter.versionId,
                expectedDraftVersion: saved.data?.draftVersion ?? freshAfterDraft.pathologyRequests?.draftVersion ?? 1,
              })
              receipt.push({ step: `病理：${path.serviceName}`, ok: true, detail: '已开立' })
            } catch (err) {
              receipt.push({ step: `病理：${path.serviceName}`, ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 7. Prescription or no-medication conclusion
          if (input.issuePrescription) {
            try {
              const fresh = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.prescription.issue', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.medicationConclusion?.draftVersion ?? 1,
              })
              receipt.push({ step: '签发门诊处方', ok: true, detail: '已签发' })
            } catch (err) {
              receipt.push({ step: '签发门诊处方', ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          } else if (input.confirmNoMedicationReason) {
            try {
              const fresh = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.medication-conclusion.confirm-none', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
                expectedDraftVersion: fresh.medicationConclusion?.draftVersion ?? 0,
                reason: input.confirmNoMedicationReason,
              })
              receipt.push({ step: '确认无需用药结论', ok: true, detail: '已确认' })
            } catch (err) {
              receipt.push({ step: '确认无需用药结论', ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          // 8. Complete encounter
          if (input.completeEncounter) {
            try {
              const fresh = await readFresh()
              await executeHisOperation(api.conversationId, 'encounter.complete', {
                encounterId: fresh.encounter.id,
                encounterVersion: fresh.encounter.versionId,
              })
              receipt.push({ step: '门诊完诊', ok: true, detail: '已完成接诊' })
            } catch (err) {
              receipt.push({ step: '门诊完诊', ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          const succeededCount = receipt.filter(r => r.ok).length
          const failedCount = receipt.length - succeededCount
          return {
            isError: succeededCount === 0 && failedCount > 0,
            output: [{
              type: 'text',
              text: JSON.stringify({
                ok: failedCount === 0,
                succeededCount,
                failedCount,
                items: receipt,
              }),
            }],
          }
        },
        cancel: async (_args, api, context) => {
          const approvalId = api.checkpoint?.approvalId
          if (!approvalId) return
          await api.commit(async (tx) => {
            const doc = await tx.doc(ClinMeshPendingApprovalsDoc, api.conversationId)
            doc.items = doc.items.filter(i => i.approvalId !== approvalId)
          }, context).catch(() => undefined)
        },
      })
    })(),
  ]

  const macroExtension = defineExtension({
    name: 'clinmesh.macros',
    tools: macroTools,
  })

  // Frontend UI-SDK Park Bridge Extension
  type UiCheckpoint = { requestId: string; action: AgentUiBridgeAction }

  const makeUiBridgeTool = <S extends Record<string, unknown>>(
    name: string,
    description: string,
    action: AgentUiBridgeAction,
    parameters: S,
  ) => defineTool<S, JsonValue, UiCheckpoint>({
    name,
    description,
    parameters,
    callers: ['model'],
    replay: 'unsafe',
    execute: async (rawArgs, api: ToolExecutionApi<JsonValue, UiCheckpoint>, context) => {
      if (api.wake === undefined) {
        const requestId = `uibr-${randomUUID().slice(0, 12)}`
        const nowMs = api.now()
        const expiresAtMs = nowMs + UI_BRIDGE_TIMEOUT_MS
        const reqRecord: AgentUiBridgeRequest = {
          requestId,
          taskId: api.taskId,
          callId: api.callId,
          action,
          payloadJson: JSON.stringify(rawArgs ?? {}),
          createdAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        }
        await api.commit(async (tx) => {
          const doc = await tx.doc(ClinMeshUiBridgeDoc, api.conversationId)
          doc.requests = [...doc.requests.filter(r => r.requestId !== requestId), reqRecord]
        }, context)

        const park: ToolPark<UiCheckpoint> = {
          kind: 'sleep',
          signals: [UiBridgeResultSignal.key(requestId)],
          until: expiresAtMs,
          checkpoint: { requestId, action },
        }
        return park
      }

      const requestId = api.checkpoint?.requestId ?? ''
      if (requestId) {
        await api.commit(async (tx) => {
          const doc = await tx.doc(ClinMeshUiBridgeDoc, api.conversationId)
          doc.requests = doc.requests.filter(r => r.requestId !== requestId)
        }, context)
      }

      const signalState = requestId
        ? await api.readSignal(UiBridgeResultSignal, requestId, context)
        : undefined
      if (signalState === undefined || signalState.kind === 'expired') {
        return {
          isError: true,
          output: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              code: 'UI_BRIDGE_UNAVAILABLE',
              message: '当前前端浏览器工作台未响应界面桥接请求（可能未打开界面或正处于无头调用模式）。请改用后端 HIS 工具（如 encounter_clinical_document_draft_set）直接读取或保存草稿。',
            }),
          }],
        }
      }

      if (!signalState.value.ok) {
        return {
          isError: true,
          output: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: signalState.value.error ?? 'UI action failed',
            }),
          }],
        }
      }

      return {
        output: [{ type: 'text', text: signalState.value.resultJson ?? '{"ok":true}' }],
      }
    },
    cancel: async (_args, api, context) => {
      const requestId = api.checkpoint?.requestId
      if (!requestId) return
      await api.commit(async (tx) => {
        const doc = await tx.doc(ClinMeshUiBridgeDoc, api.conversationId)
        doc.requests = doc.requests.filter(r => r.requestId !== requestId)
      }, context).catch(() => undefined)
    },
  })

  const uiBridgeTools: ToolRegistration[] = [
    makeUiBridgeTool(
      'ui_read_workspace',
      '【前端 UI-SDK 感知】读取医生浏览器当前工作区的可见控件（含 ref、component、label、actions、items、value、confirm）与医生手改未保存字段清单（humanEditedLabels），侧边栏与隐藏真值已物理隔离。',
      'scopedSnapshot',
      {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选 CSS 作用域选择器，留空自动聚焦当前工作区主容器。' },
        },
        additionalProperties: false,
      },
    ),
    makeUiBridgeTool(
      'ui_navigate_workspace',
      '【前端 UI-SDK 栏位切换（默认放行）】直接切换当前工作区的页签、分栏或展开导航面板（例如从“问诊记录/患者对话”切换到“病历记录/病历栏”、“诊断”、“检验检查”、“处方”等），同步驱动页面虚拟光标与目标高亮。',
      'navigate',
      {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: '目标栏位或页签名称（如“病历记录”、“病历栏”、“问诊记录”、“患者对话”、“诊断”、“检验检查”、“处方”或对应 value 如 record/consultation/diagnosis/laboratory/prescription）。',
          },
          container: {
            type: 'string',
            description: '可选：目标所在页签组或容器名称（如“工作分区”），留空自动匹配当前工作区页签。',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
    ),
    makeUiBridgeTool(
      'ui_stage_form_draft',
      '【前端 UI-SDK 预填草稿（默认放行）】将起草内容实时填入医生当前打开的表单字段（如主诉、现病史、既往史、体格检查、初步评估等），自动跳过医生手改字段绝不覆写，且支持一键撤销。',
      'stage',
      {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: '目标控件 label（如 现病史、体格检查）或 ref' },
                value: {},
              },
              required: ['ref', 'value'],
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
    ),
    makeUiBridgeTool(
      'ui_act_workspace',
      '【前端 UI-SDK 通用界面操作（黑名单制默认放行）】在当前工作台执行任意非黑名单界面交互（如 Tabs 的 setValue、按钮 press、下拉/弹层 setOpen/open/close、手风琴 toggle、开关 setChecked、输入框 setValue/clear 等）。仅命中带 data-agent-confirm 的高危提交按钮与医生手改锁字段时拦截。',
      'act',
      {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: '控件 ref 或可见 label（也可直接传页签名称自动映射至对应 Tabs）' },
                action: { type: 'string', description: '组件支持的动作名（如 setValue、press、toggle、setChecked、clear、setOpen、open、close、increment、decrement 等）' },
                args: { type: 'array', items: {} },
              },
              required: ['ref', 'action'],
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    ),
    makeUiBridgeTool(
      'ui_undo_agent_edits',
      '【前端 UI-SDK 独立撤销】仅撤销临床助手在当前表单上的修改（history.undoSource("agent")），完整保留医生手工编辑的内容。',
      'undoAgent',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    ),
  ]

  const uiBridgeExtension = defineExtension({
    name: 'clinmesh.ui_bridge',
    tools: uiBridgeTools,
  })

  return {
    domainExtensions,
    macroExtension,
    uiBridgeExtension,
    allCatalogTools,
    macroTools,
    uiBridgeTools,
    getRoleAllowedHisTools: (roleCode: string) => toolsByRole.get(roleCode) ?? [],
    executeHisOperation,
  }
}
