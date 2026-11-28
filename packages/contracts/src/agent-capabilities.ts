import { z } from 'zod'
import { hisOperationCatalog, type HisOperationDefinition } from './his-operations.ts'

export const agentPermissionTierSchema = z.enum(['allow', 'confirm', 'deny'])
export type AgentPermissionTier = z.infer<typeof agentPermissionTierSchema>

export const agentActivityEventCategorySchema = z.enum([
  'perceive',
  'navigate',
  'draft',
  'compute',
  'verify',
  'approval',
  'revert',
])
export type AgentActivityEventCategory = z.infer<typeof agentActivityEventCategorySchema>

export const agentBlacklistRuleSchema = z.object({
  id: z.string().min(1),
  surface: z.enum(['backend', 'frontend', 'both']),
  pattern: z.string().min(1),
  titleZh: z.string().min(1),
  titleEn: z.string().min(1),
  reasonZh: z.string().min(1),
  reasonEn: z.string().min(1),
}).strict()
export type AgentBlacklistRule = z.infer<typeof agentBlacklistRuleSchema>

export const agentEventDefinitionSchema = z.object({
  id: z.string().min(1),
  category: agentActivityEventCategorySchema,
  surface: z.enum(['frontend', 'backend', 'both']),
  permission: agentPermissionTierSchema,
  titleZh: z.string().min(1),
  titleEn: z.string().min(1),
  descriptionZh: z.string().min(1),
  descriptionEn: z.string().min(1),
  visualMode: z.enum(['scan', 'cursor-click', 'cursor-fill', 'region-glow', 'approval-beacon', 'revert-flash']),
  tools: z.array(z.string().min(1)),
}).strict()
export type AgentEventDefinition = z.infer<typeof agentEventDefinitionSchema>

export const agentOperationPolicyItemSchema = z.object({
  operationId: z.string().min(1),
  toolName: z.string().min(1),
  mode: z.string().min(1),
  risk: z.enum(['read', 'write', 'high-risk-write']),
  permission: agentPermissionTierSchema,
  summary: z.string().min(1),
}).strict()
export type AgentOperationPolicyItem = z.infer<typeof agentOperationPolicyItemSchema>

export const agentCapabilitiesManifestSchema = z.object({
  policyMode: z.literal('blacklist-default-allow'),
  roleCode: z.string().min(1),
  summaryZh: z.string().min(1),
  summaryEn: z.string().min(1),
  blacklist: z.array(agentBlacklistRuleSchema),
  events: z.array(agentEventDefinitionSchema),
  counts: z.object({
    totalRoleOperations: z.number().int().nonnegative(),
    defaultAllowedOperations: z.number().int().nonnegative(),
    confirmationGatedOperations: z.number().int().nonnegative(),
    blacklistedOperations: z.number().int().nonnegative(),
  }).strict(),
  confirmationOperations: z.array(agentOperationPolicyItemSchema),
  sampleDefaultAllowedOperations: z.array(agentOperationPolicyItemSchema),
}).strict()
export type AgentCapabilitiesManifest = z.infer<typeof agentCapabilitiesManifestSchema>

/**
 * Explicit formal clinical/financial commit IDs that require 1-click clinician approval
 * in addition to all `risk === 'high-risk-write'` operations.
 * Everything outside the hard blacklist and this explicit confirmation redline is DEFAULT-ALLOWED.
 */
export const EXTRA_CONFIRMATION_OPERATION_IDS: ReadonlySet<string> = new Set([
  'triage.record',
  'inpatient.diagnosis.confirm',
  'inpatient.orders.issue',
  'inpatient.orders.stop',
  'inpatient.discharge.issue',
  'inpatient.discharge.depart',
  'inpatient.discharge.clear',
  'inpatient.discharge.recall',
  'inpatient.medication.dispense',
  'inpatient.admission.register',
  'inpatient.bed.assign',
  'inpatient.referral.issue',
])

export const AGENT_HARD_BLACKLIST_RULES: readonly AgentBlacklistRule[] = [
  {
    id: 'deny.auth-session',
    surface: 'backend',
    pattern: 'auth.*',
    titleZh: '身份认证与角色切换接口',
    titleEn: 'Authentication & role-switching operations',
    reasonZh: '助手必须严格继承当前登录医生身份，禁止自行登录、登出或切换工作角色。',
    reasonEn: 'Assistant strictly inherits the signed-in clinician session and cannot sign in, sign out, or switch roles.',
  },
  {
    id: 'deny.agent-self-admin',
    surface: 'backend',
    pattern: 'agent.*',
    titleZh: '助手自身会话与密钥管理',
    titleEn: 'Assistant session & provider key admin',
    reasonZh: '禁止助手自我修改模型配置、API Key 或跨会话读取其他接诊记录。',
    reasonEn: 'Prevents the assistant from altering provider keys, model config, or accessing other sessions.',
  },
  {
    id: 'deny.hidden-truth',
    surface: 'frontend',
    pattern: '[data-agent-hidden]',
    titleZh: '隐藏病例真值与助手自身侧栏控件',
    titleEn: 'Hidden case truth & sidebar self-controls',
    reasonZh: '严格遵守临床 Reveal Policy，隔离未公开病例真值并防止助手误操作自身聊天框。',
    reasonEn: 'Enforces clinical Reveal Policy and prevents the assistant from clicking its own sidebar.',
  },
  {
    id: 'deny.secret-readout',
    surface: 'frontend',
    pattern: '[data-agent-secret]',
    titleZh: '敏感密钥/口令明文回显',
    titleEn: 'Secret field plaintext readout',
    reasonZh: '密码、API Key 与敏感口令字段禁止明文读取或输出至模型上下文。',
    reasonEn: 'Passwords, API keys, and credentials are always redacted from agent snapshots.',
  },
]

export const AGENT_ACTIVITY_EVENT_CATALOG: readonly AgentEventDefinition[] = [
  {
    id: 'event.perceive',
    category: 'perceive',
    surface: 'both',
    permission: 'allow',
    titleZh: '感知页面与读取临床数据',
    titleEn: 'Perceive workspace & read clinical data',
    descriptionZh: '扫描当前工作区控件、未保存手改内容、病例摘要、检验影像报告、生命体征与指南评分。',
    descriptionEn: 'Inspect active workspace controls, unsaved clinician edits, case details, lab/imaging reports, vitals, and guidelines.',
    visualMode: 'scan',
    tools: ['ui_read_workspace', 'macro_clinical_briefing', 'doctor_case_get', 'read_visible_case_summary', 'read_lab_results', 'read_imaging_reports', 'read_medication_orders', 'read_vital_trends'],
  },
  {
    id: 'event.navigate',
    category: 'navigate',
    surface: 'frontend',
    permission: 'allow',
    titleZh: '切换工作区栏位与界面导航',
    titleEn: 'Navigate workspace tabs & UI panels',
    descriptionZh: '在问诊对话、病历记录、诊断、检验检查、处方、住院各分区页签与面板之间自由切换、展开与筛选。',
    descriptionEn: 'Switch between consultation, medical record, diagnosis, lab/imaging, prescription, and inpatient tabs or expand panels.',
    visualMode: 'cursor-click',
    tools: ['ui_navigate_workspace', 'ui_act_workspace'],
  },
  {
    id: 'event.draft',
    category: 'draft',
    surface: 'both',
    permission: 'allow',
    titleZh: '自动起草病历、医嘱草稿与预填表单',
    titleEn: 'Draft clinical notes, orders & stage forms',
    descriptionZh: '自动撰写结构化病历草稿、诊断草稿、处方草稿、检查检验申请草稿并实时预填页面未保存字段（自动避开医生手改字段）。',
    descriptionEn: 'Draft structured clinical documents, diagnoses, prescriptions, and lab/imaging requests, and stage unsaved UI fields while protecting human edits.',
    visualMode: 'cursor-fill',
    tools: ['ui_stage_form_draft', 'macro_consultation_ask', 'encounter_clinical_document_draft_set', 'encounter_diagnosis_draft_set', 'encounter_prescription_draft_set', 'encounter_laboratory_request_draft_set'],
  },
  {
    id: 'event.compute',
    category: 'compute',
    surface: 'backend',
    permission: 'allow',
    titleZh: '沙箱并行检索与流程编排',
    titleEn: 'Sandboxed parallel queries & tool discovery',
    descriptionZh: '在 QuickJS 沙箱中并行调用只读/草稿/预览接口、按需检索全量角色授权 HIS 操作、查阅临床 Playbook 与能力清单。',
    descriptionEn: 'Batch parallel read/draft/preview calls in QuickJS codemode, discover deferred HIS operations, and consult clinical playbooks.',
    visualMode: 'region-glow',
    tools: ['codemode', 'tool_search', 'read_clinical_playbook', 'list_agent_capabilities', 'macro_outpatient_write_preflight', 'macro_search_clinical_catalog'],
  },
  {
    id: 'event.verify',
    category: 'verify',
    surface: 'backend',
    permission: 'allow',
    titleZh: '预签核验与完诊质控安全审计',
    titleEn: 'Sign preview & completion safety audit',
    descriptionZh: '自动执行病历签署预检、完诊阻断项检查、临床质控评分与风险评估，确保所有前置条件就绪。',
    descriptionEn: 'Run clinical document sign previews, completion readiness checks, clinical quality audits, and risk scoring.',
    visualMode: 'region-glow',
    tools: ['macro_safety_completion_audit', 'encounter_clinical_document_sign_preview', 'encounter_completion_preview', 'encounter_clinical_quality_read'],
  },
  {
    id: 'event.approval',
    category: 'approval',
    surface: 'both',
    permission: 'confirm',
    titleZh: '高危正式临床/财务提交（需医生一键确认）',
    titleEn: 'Formal clinical/financial commits (1-click approval)',
    descriptionZh: '病历正式电子签名、诊断确诊、处方签发、完诊、住院医嘱开立/停嘱、出院办理及收退款等不可逆提交均自动挂起并弹出确认卡片。',
    descriptionEn: 'Irreversible commits (signing records, confirming diagnoses, issuing prescriptions/orders, completing visits, billing/refunds) park for 1-click clinician approval.',
    visualMode: 'approval-beacon',
    tools: ['batch_confirm_clinical_orders', 'encounter_clinical_document_sign', 'encounter_diagnosis_confirm', 'encounter_prescription_issue', 'encounter_complete'],
  },
  {
    id: 'event.revert',
    category: 'revert',
    surface: 'frontend',
    permission: 'allow',
    titleZh: '独立撤销助手界面填写',
    titleEn: 'Revert assistant UI form edits',
    descriptionZh: '一键撤销临床助手对当前表单所做的全部修改，完整保留医生自己的手工编辑内容。',
    descriptionEn: 'Revert only assistant-applied form changes while preserving every manual clinician edit.',
    visualMode: 'revert-flash',
    tools: ['ui_undo_agent_edits'],
  },
]

export function isHardBlacklistedHisOperation(op: Pick<HisOperationDefinition, 'id'>): boolean {
  return op.id.startsWith('auth.') || op.id.startsWith('agent.')
}

export function requiresClinicianConfirmation(op: Pick<HisOperationDefinition, 'id' | 'risk'>): boolean {
  if (op.risk === 'high-risk-write') return true
  return EXTRA_CONFIRMATION_OPERATION_IDS.has(op.id)
}

export function classifyHisOperationPermission(op: Pick<HisOperationDefinition, 'id' | 'risk'>): AgentPermissionTier {
  if (isHardBlacklistedHisOperation(op)) return 'deny'
  if (requiresClinicianConfirmation(op)) return 'confirm'
  return 'allow'
}

export function toAgentHisToolName(opId: string): string {
  return opId.replaceAll(/[^A-Za-z0-9_]/g, '_')
}

export function buildRoleAgentCapabilitiesManifest(roleCode: string): AgentCapabilitiesManifest {
  const blacklistedOps = hisOperationCatalog.filter(op => isHardBlacklistedHisOperation(op))
  const roleOps = hisOperationCatalog.filter(
    op => !isHardBlacklistedHisOperation(op) && (op.roles.length === 0 || (op.roles as readonly string[]).includes(roleCode)),
  )
  const confirmationOps: AgentOperationPolicyItem[] = []
  const defaultAllowedOps: AgentOperationPolicyItem[] = []

  for (const op of roleOps) {
    const permission = classifyHisOperationPermission(op)
    const item: AgentOperationPolicyItem = {
      operationId: op.id,
      toolName: toAgentHisToolName(op.id),
      mode: op.mode,
      risk: op.risk,
      permission,
      summary: op.summary,
    }
    if (permission === 'confirm') {
      confirmationOps.push(item)
    } else if (permission === 'allow') {
      defaultAllowedOps.push(item)
    }
  }

  return {
    policyMode: 'blacklist-default-allow',
    roleCode,
    summaryZh: '采用「黑名单 + 高危确认红线，其余默认放行」策略：助手可自由切换工作区栏位、读取病例与页面未保存内容、起草病历/诊断/处方/检查草稿及预签核验；仅黑名单操作禁止调用，正式签署/确诊/开方/完诊/出院/收退款需医生一键确认。',
    summaryEn: 'Blacklist-first default-allow policy: the assistant can freely switch workspace tabs, read clinical & unsaved form state, draft records/orders, and run safety previews. Only blacklisted boundaries are denied, and formal clinical/financial commits park for 1-click clinician approval.',
    blacklist: [...AGENT_HARD_BLACKLIST_RULES],
    events: [...AGENT_ACTIVITY_EVENT_CATALOG],
    counts: {
      totalRoleOperations: roleOps.length,
      defaultAllowedOperations: defaultAllowedOps.length,
      confirmationGatedOperations: confirmationOps.length,
      blacklistedOperations: blacklistedOps.length,
    },
    confirmationOperations: confirmationOps,
    sampleDefaultAllowedOperations: defaultAllowedOps.slice(0, 32),
  }
}
