import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  getHisOperation,
  hisOperationCatalog,
  type HisOperationDefinition,
} from '@clinmesh/contracts/his-operations'
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import type { OutpatientBenchmarkFixture } from './clinical-fixture.ts'
import type { ArmMeta, BackendArmId, SkillReceipt } from './types.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const SHARED_SKILL_MD = readFileSync(join(REPO_ROOT, 'skills', 'clinmesh-shared', 'SKILL.md'), 'utf8')
const DOCTOR_SKILL_MD = readFileSync(join(REPO_ROOT, 'skills', 'clinmesh-doctor', 'SKILL.md'), 'utf8')

const OUTPATIENT_DOCTOR_OPS: readonly HisOperationDefinition[] = hisOperationCatalog.filter(op =>
  op.roles.includes('outpatient-doctor'),
)

const HIGH_RISK_WRITE_IDS = new Set([
  'encounter.clinical-document.sign',
  'encounter.diagnosis.confirm',
  'encounter.prescription.issue',
  'encounter.medication-conclusion.confirm-none',
  'encounter.complete',
  'clinical-document.revise',
  'prescription.withdraw',
])

const DOMAIN_PLAYBOOKS: Record<string, string> = {
  'outpatient-briefing': [
    '# Clinical Playbook: Outpatient Clinical Briefing',
    '1. Fetch visible case summary (`doctor.case.get` with `{ caseId }`), clinical scores (`doctor.case.clinical-scores.read`), and completion preview (`encounter.completion.preview` with `{ encounterId }`).',
    '2. Summarize patient identity, chief complaint, triage vital signs (BP, HR, RR, Temp, SpO2), prior medical history, and ALL published laboratory items explicitly separating abnormal (H/L) from normal (N) results.',
    '3. Report clinical score completeness & missing inputs directly from `doctor.case.clinical-scores.read`.',
    '4. Reveal Policy Red-Line: NEVER invent, infer, or expose unseen diagnoses outside visible clinician records.',
  ].join('\n'),
  'outpatient-safety-audit': [
    '# Clinical Playbook: Outpatient Safety & Completion Preflight Audit',
    '1. Inspect `encounter.completion.preview` (`{ encounterId }`) for exact blocking gates (`ready`, `blockers`).',
    '2. Inspect `encounter.clinical-quality.read` (`{ encounterId, gate: "outpatient-completion" }`) for clinical quality warnings/blocks.',
    '3. Inspect `doctor.case.clinical-scores.read`, `doctor.case.guideline-topics.read`, and `doctor.case.order-set-drafts.read` (each takes `{ caseId }`).',
    '4. Read-only audit: do NOT execute any write or commit mutations during audit.',
  ].join('\n'),
  'outpatient-e2e-write': [
    '# Clinical Playbook: Outpatient End-to-End Clinical Write & Completion',
    'Always read fresh `encounterVersion` from `doctor.case.get` (or previous write response) before mutations:',
    'Step 1 — Lookup valid catalog IDs: `catalog.clinical.read` (`{}`) gives `diagnoses[]` and `medications[]` with exact `id`, `dose`, `frequency`.',
    'Step 2 — Clinical Document: `encounter.clinical-document.draft.set` (`{ encounterId, encounterVersion, expectedDraftVersion: 0, document: { chiefComplaint, historyOfPresentIllness, priorMedicalHistory, physicalExamination, assessment, disposition, followUp, allergyHistory, familyHistory, menstrualHistory, obstetricHistory, auxiliaryExamination } }`) → `encounter.clinical-document.sign.preview` (`{ encounterId, encounterVersion, expectedDraftVersion }`) → `encounter.clinical-document.sign` (`{ encounterId, encounterVersion, previewId, commitToken }`).',
    'Step 3 — Diagnosis: `encounter.diagnosis.draft.set` (`{ encounterId, encounterVersion, expectedDraftVersion: 0, entries: [{ catalogItemId, role: "primary" }] }`) → `encounter.diagnosis.confirm` (`{ encounterId, encounterVersion, expectedDraftVersion }`). Note: `confirm` increments `encounterVersion`!',
    'Step 4 — Medication Conclusion: either `encounter.prescription.draft.set` + `encounter.prescription.issue`, OR `encounter.medication-conclusion.confirm-none` (`{ encounterId, encounterVersion, reason }`).',
    'Step 5 — Complete Encounter: verify `encounter.completion.preview` (`ready === true`) then call `encounter.complete` (`{ encounterId, encounterVersion }`).',
  ].join('\n'),
}

function sha256Short(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2)
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

function opToToolName(opId: string): string {
  return opId.replaceAll(/[^A-Za-z0-9_]/g, '_')
}

function classifyDomain(op: HisOperationDefinition): 'clinical_case' | 'diagnostics' | 'therapy' | 'cds' | 'finance' {
  const id = op.id
  if (id.includes('clinical-scores') || id.includes('guideline') || id.includes('order-set') || id.includes('clinical-quality') || id.includes('risk-assessment')) {
    return 'cds'
  }
  if (id.includes('laboratory') || id.includes('imaging') || id.includes('pathology') || id.includes('examination')) {
    return 'diagnostics'
  }
  if (id.includes('prescription') || id.includes('medication') || id.includes('diagnosis') || id.includes('service.') || id.includes('inpatient')) {
    return 'therapy'
  }
  if (id.includes('payment') || id.includes('billing') || id.includes('receipt') || id.includes('catalog') || id.includes('reference.')) {
    return 'finance'
  }
  return 'clinical_case'
}

/**
 * Compact projection stripping verbose FHIR / boilerplate metadata while keeping 100% of clinically
 * actionable facts, versions, abnormal flags, blockers, and catalog IDs.
 */
export function compactOperationOutput(opId: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || typeof raw !== 'object') return raw
  const obj = raw as Record<string, unknown>

  if (opId === 'doctor.case.get') {
    const encounter = obj.encounter as Record<string, unknown> | undefined
    const patient = obj.patient as Record<string, unknown> | undefined
    const triage = obj.triage as Record<string, unknown> | undefined
    const clinicalDoc = obj.clinicalDocument as Record<string, unknown> | undefined
    const diagnosis = obj.diagnosis as Record<string, unknown> | undefined
    const labReqs = (obj.laboratoryRequests as { requests?: Array<Record<string, unknown>> } | undefined)?.requests ?? []
    const priorFacts = obj.priorFacts
    const allergies = obj.allergies
    const medConclusion = obj.medicationConclusion as Record<string, unknown> | undefined
    return {
      caseId: obj.caseId,
      status: obj.status,
      patient: patient ? { id: patient.id, name: patient.name, gender: patient.gender, birthDate: patient.birthDate } : undefined,
      encounter: encounter ? { id: encounter.id, status: encounter.status, versionId: encounter.versionId } : undefined,
      triage: triage ? {
        acuityCode: triage.acuityCode,
        chiefComplaint: triage.chiefComplaint,
        bloodPressure: triage.bloodPressure,
        temperatureC: triage.temperatureC,
        pulseBpm: triage.pulseBpm,
        respirationBpm: triage.respirationBpm,
        oxygenSaturationPct: triage.oxygenSaturationPct,
      } : undefined,
      priorFacts,
      allergies,
      clinicalDocument: clinicalDoc ? {
        draftVersion: (clinicalDoc.draft as Record<string, unknown> | undefined)?.version ?? 0,
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

  if (opId === 'catalog.clinical.read') {
    const diagnoses = Array.isArray(obj.diagnoses)
      ? (obj.diagnoses as Array<Record<string, unknown>>).slice(0, 15).map(d => ({
          id: d.id,
          code: d.code,
          nameZh: d.nameZh ?? d.display,
        }))
      : []
    const medications = Array.isArray(obj.medications)
      ? (obj.medications as Array<Record<string, unknown>>).slice(0, 15).map(m => ({
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

  // Default: keep JSON under 5000 chars
  const str = JSON.stringify(raw)
  if (str.length <= 5000) return raw
  return { _truncated: true, preview: str.slice(0, 4800) }
}

function applyFieldsAndTail(data: unknown, fields?: string, tail?: number): unknown {
  let result = data
  if (fields && result && typeof result === 'object' && !Array.isArray(result)) {
    const allowed = new Set(fields.split(',').map(f => f.trim()).filter(Boolean))
    const picked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (allowed.has(k)) picked[k] = v
    }
    result = picked
  }
  if (tail !== undefined && tail > 0 && Array.isArray(result)) {
    result = result.slice(-tail)
  }
  return result
}

async function executeWithDeterministicIdempotency(
  fixture: OutpatientBenchmarkFixture,
  op: HisOperationDefinition,
  rawArgs: unknown,
): Promise<unknown> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  const idempotencyKey = op.requirements.idempotency === 'required'
    ? `bench-${op.id}-${sha256Short(JSON.stringify(args))}-${randomUUID().slice(0, 6)}`
    : undefined
  return fixture.executeOp(op.id, args, idempotencyKey)
}

function formatOpError(error: unknown): string {
  if (error && typeof error === 'object' && 'problem' in error) {
    const prob = (error as { problem: Record<string, unknown> }).problem
    return JSON.stringify({ error: prob })
  }
  if (error instanceof z.ZodError) {
    return JSON.stringify({
      error: {
        code: 'VALIDATION_ERROR',
        issues: error.issues.slice(0, 6).map(i => ({ path: i.path.join('.'), message: i.message })),
      },
    })
  }
  return JSON.stringify({ error: { code: 'EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error) } })
}

function searchCatalog(query: string, filters?: { mode?: string; risk?: string; limit?: number }) {
  const tokens = query.toLowerCase().split(/[\s,._/-]+/).filter(Boolean)
  const limit = Math.min(Math.max(filters?.limit ?? 8, 1), 20)
  const scored = OUTPATIENT_DOCTOR_OPS
    .filter(op => {
      if (filters?.mode && op.mode !== filters.mode) return false
      if (filters?.risk && op.risk !== filters.risk) return false
      return true
    })
    .map(op => {
      const hay = `${op.id} ${op.cliPath.join(' ')} ${op.summary} ${op.http.path} ${classifyDomain(op)}`.toLowerCase()
      let score = 0
      for (const tok of tokens) {
        if (op.id.toLowerCase().includes(tok)) score += 5
        if (op.cliPath.join(' ').toLowerCase().includes(tok)) score += 4
        if (hay.includes(tok)) score += 2
      }
      return { op, score }
    })
    .filter(item => tokens.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.map(({ op }) => {
    const schema = sanitizeJsonSchema(op.input)
    return {
      id: op.id,
      cli: `clinmesh ${op.cliPath.join(' ')}`,
      domain: classifyDomain(op),
      mode: op.mode,
      risk: op.risk,
      summary: op.summary,
      requiredArgs: Array.isArray(schema.required) ? schema.required : [],
    }
  })
}

export interface BuiltBackendArm {
  readonly meta: ArmMeta
  readonly extensions: readonly Extension[]
  readonly instructions: string
  readonly skillReceipt?: SkillReceipt
  readonly cleanup: () => Promise<void>
}

export const BACKEND_ARM_CATALOG: readonly Omit<ArmMeta, 'initialSchemaTokensEst' | 'initialGuidanceChars' | 'offeredToolsTurn1'>[] = [
  {
    id: 'B1-flat-mcp',
    track: 'backend',
    label: 'B1: Flat MCP (73 全量扁平工具)',
    shortLabel: 'B1 Flat MCP',
    category: 'baseline',
    summary: '将全部 73 个门诊医生 HIS 操作的完整 Zod→JSON Schema 在首轮一次性注入上下文（传统未优化 MCP 基线）。',
    supportsProgressiveDisclosure: false,
    supportsCodeExecution: false,
  },
  {
    id: 'B2-legacy-cli',
    track: 'backend',
    label: 'B2: Legacy CLI + 全量 SKILL.md (35KB)',
    shortLabel: 'B2 Legacy CLI',
    category: 'baseline',
    summary: '将仓库现有 clinmesh-shared + clinmesh-doctor 全量 35KB SKILL.md 注入系统提示词，搭配通用 clinmesh_cli 执行器。',
    supportsProgressiveDisclosure: false,
    supportsCodeExecution: false,
  },
  {
    id: 'B3-multica-cli',
    track: 'backend',
    label: 'B3: Multica-Style Agent-First CLI',
    shortLabel: 'B3 Multica CLI',
    category: 'cli',
    summary: '融合 Multica 七大设计：2KB 极简索引卡 + gh 分组 --help + 报错回显帮助 + --summary/--compact/--fields + 自动幂等 + 复合宏命令 + SkillReceipt。',
    supportsProgressiveDisclosure: true,
    supportsCodeExecution: false,
  },
  {
    id: 'B4-stateless-mcp-2026',
    track: 'backend',
    label: 'B4: 2026 Stateless Progressive MCP (HTTP)',
    shortLabel: 'B4 MCP 2026',
    category: 'mcp',
    summary: '真实本地 HTTP `/api/mcp`（2026-07-28 JSON-RPC 2.0 + server/discover + Tool Annotations + 4 个渐进元工具 + Playbook Prompts）。',
    supportsProgressiveDisclosure: true,
    supportsCodeExecution: false,
  },
  {
    id: 'B5-hybrid-tool-search',
    track: 'backend',
    label: 'B5: Hybrid 架构 (pi-durable tool_search + 宏)',
    shortLabel: 'B5 ToolSearch+Macro',
    category: 'hybrid',
    summary: '收敛方案基线：pi-durable 原生 createToolSearchExtension() + 5 领域 deferred Extension + 确定性临床工作流宏 + 4 层缓存分离引导。',
    supportsProgressiveDisclosure: true,
    supportsCodeExecution: false,
  },
  {
    id: 'B6-hybrid-codemode',
    track: 'backend',
    label: 'B6: Hybrid 架构 (pi-durable QuickJS Codemode)',
    shortLabel: 'B6 QuickJS Codemode',
    category: 'hybrid',
    summary: '收敛方案增强版：pi-durable 原生 QuickJS CodemodeSandbox 并行编排只读/草稿工具 + 高危写入 callers:["model"] 物理隔离红线。',
    supportsProgressiveDisclosure: true,
    supportsCodeExecution: true,
  },
]

function buildArmMeta(
  armId: BackendArmId,
  initialGuidanceChars: number,
  offeredToolsTurn1: number,
  initialSchemaChars: number,
): ArmMeta {
  const base = BACKEND_ARM_CATALOG.find(a => a.id === armId)!
  return {
    ...base,
    initialGuidanceChars,
    offeredToolsTurn1,
    initialSchemaTokensEst: estimateTokens('x'.repeat(initialSchemaChars + initialGuidanceChars)),
  }
}

/**
 * Boots a real loopback HTTP 2026-07-28 Stateless MCP server for Arm B4.
 */
async function startStatelessMcp2026Server(fixture: OutpatientBenchmarkFixture): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const app = new Hono()

  app.post('/api/mcp', async (c) => {
    const body = await c.req.json() as {
      jsonrpc?: string
      id?: string | number
      method?: string
      params?: Record<string, unknown>
    }
    const id = body.id ?? 1
    const reply = (result: unknown) => c.json({
      jsonrpc: '2.0',
      id,
      _meta: { protocolVersion: '2026-07-28', stateless: true, server: 'clinmesh-his-mcp' },
      result,
    })
    const fail = (code: number, message: string, data?: unknown) => c.json({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })

    if (body.method === 'server/discover') {
      return reply({
        protocolVersion: '2026-07-28',
        capabilities: { tools: { progressive: true }, resources: true, prompts: true },
        operationCount: OUTPATIENT_DOCTOR_OPS.length,
        playbooks: Object.keys(DOMAIN_PLAYBOOKS),
      })
    }

    if (body.method === 'prompts/get') {
      const name = String(body.params?.name ?? '')
      const text = DOMAIN_PLAYBOOKS[name]
      if (!text) return fail(-32602, `Unknown playbook: ${name}. Available: ${Object.keys(DOMAIN_PLAYBOOKS).join(', ')}`)
      return reply({ name, text })
    }

    if (body.method === 'tools/call') {
      const name = String(body.params?.name ?? '')
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>

      if (name === 'clinmesh_search_operations') {
        const matches = searchCatalog(String(args.query ?? ''), {
          mode: typeof args.mode === 'string' ? args.mode : undefined,
          risk: typeof args.risk === 'string' ? args.risk : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 8,
        })
        return reply({ matches, totalCatalogOps: OUTPATIENT_DOCTOR_OPS.length })
      }

      if (name === 'clinmesh_get_operation') {
        const ids = Array.isArray(args.operationIds)
          ? args.operationIds.map(String)
          : typeof args.operationId === 'string'
            ? [args.operationId]
            : []
        const specs = ids.slice(0, 5).map(opId => {
          try {
            const op = getHisOperation(opId)
            return {
              id: op.id,
              mode: op.mode,
              risk: op.risk,
              summary: op.summary,
              annotations: {
                readOnlyHint: op.risk === 'read',
                destructiveHint: op.risk === 'high-risk-write',
                idempotentHint: op.requirements.idempotency === 'required',
              },
              inputSchema: sanitizeJsonSchema(op.input),
            }
          } catch {
            return { id: opId, error: 'Operation not found' }
          }
        })
        return reply({ operations: specs })
      }

      if (name === 'clinmesh_run_operation') {
        const opId = String(args.operationId ?? '')
        const opArgs = args.input ?? {}
        const compact = args.compact !== false
        try {
          const op = getHisOperation(opId)
          const raw = await executeWithDeterministicIdempotency(fixture, op, opArgs)
          const data = compact ? compactOperationOutput(opId, raw) : raw
          return reply({
            operationId: opId,
            risk: op.risk,
            annotations: { readOnlyHint: op.risk === 'read', destructiveHint: op.risk === 'high-risk-write' },
            data,
          })
        } catch (error) {
          return fail(-32000, formatOpError(error))
        }
      }
      return fail(-32601, `Unknown MCP tool: ${name}`)
    }

    return fail(-32601, `Unsupported MCP method: ${String(body.method)}`)
  })

  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: app.fetch,
  })
  await once(server, 'listening')
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('MCP server failed to bind port')
  const url = `http://127.0.0.1:${addr.port}/api/mcp`
  return {
    url,
    close: () => new Promise<void>((res, rej) => {
      server.close(err => (err ? rej(err) : res()))
      if ('closeAllConnections' in server) server.closeAllConnections()
    }),
  }
}

export async function buildBackendArm(
  armId: BackendArmId,
  fixture: OutpatientBenchmarkFixture,
): Promise<BuiltBackendArm> {
  // ─── B1: Flat 73-Op MCP Baseline ──────────────────────────────────────────
  if (armId === 'B1-flat-mcp') {
    let schemaChars = 0
    const tools: ToolRegistration[] = OUTPATIENT_DOCTOR_OPS.map(op => {
      const schema = sanitizeJsonSchema(op.input)
      schemaChars += JSON.stringify(schema).length + op.summary.length + op.id.length + 40
      return defineTool({
        name: opToToolName(op.id),
        description: `[${op.mode}/${op.risk}] ${op.summary}`,
        parameters: schema,
        replay: op.risk === 'read' ? 'safe' : 'unsafe',
        execute: async (args) => {
          try {
            const raw = await executeWithDeterministicIdempotency(fixture, op, args)
            const text = JSON.stringify(raw)
            return { output: [{ type: 'text', text: text.length > 18_000 ? `${text.slice(0, 18_000)}…[truncated]` : text }] }
          } catch (error) {
            return { isError: true, output: [{ type: 'text', text: formatOpError(error) }] }
          }
        },
      })
    })
    const ext = defineExtension({ name: 'clinmesh.flat-mcp', tools })
    const instructions = [
      '你是 ClinMesh 门诊临床助手。请严格依据实时工具返回的数据完成医生任务。',
      '严禁编造或推测系统未展示的诊断（严格遵守病例真值隔离 Reveal Policy）。',
      '回答请结构清晰、简明准确，使用中文。',
    ].join('\n')
    return {
      meta: buildArmMeta(armId, instructions.length, tools.length, schemaChars),
      extensions: [ext],
      instructions,
      cleanup: async () => undefined,
    }
  }

  // ─── B2: Legacy CLI + Full 35KB SKILL.md Baseline ─────────────────────────
  if (armId === 'B2-legacy-cli') {
    const cliParams = {
      type: 'object',
      properties: {
        cliPath: { type: 'string', description: 'CLI 子命令路径，如 "doctor case get" 或 "encounter completion preview"，或填 "--help" 查看命令列表。' },
        inputJson: { type: 'string', description: 'JSON 字符串格式的输入参数（对应 --input-json）。' },
      },
      required: ['cliPath'],
      additionalProperties: false,
    }
    const cliTool = defineTool({
      name: 'clinmesh_cli',
      description: '执行 ClinMesh CLI 命令（传入 cliPath 与 inputJson，返回原始 JSON 输出）。',
      parameters: cliParams,
      replay: 'unsafe',
      execute: async (args) => {
        const rawPath = String((args as Record<string, unknown>).cliPath ?? '').trim().replace(/^clinmesh\s+/, '')
        if (rawPath === '--help' || rawPath === 'help' || rawPath === '') {
          const list = OUTPATIENT_DOCTOR_OPS.map(o => `clinmesh ${o.cliPath.join(' ')} (${o.id}) — ${o.summary}`).join('\n')
          return { output: [{ type: 'text', text: list }] }
        }
        const op = OUTPATIENT_DOCTOR_OPS.find(o => o.cliPath.join(' ') === rawPath || o.id === rawPath)
        if (!op) {
          return {
            isError: true,
            output: [{ type: 'text', text: `Unknown command: ${rawPath}. Run cliPath="--help" to inspect available commands.` }],
          }
        }
        try {
          const parsedInput = (args as Record<string, unknown>).inputJson
            ? JSON.parse(String((args as Record<string, unknown>).inputJson))
            : {}
          const raw = await executeWithDeterministicIdempotency(fixture, op, parsedInput)
          const text = JSON.stringify(raw)
          return { output: [{ type: 'text', text: text.length > 18_000 ? `${text.slice(0, 18_000)}…[truncated]` : text }] }
        } catch (error) {
          return { isError: true, output: [{ type: 'text', text: formatOpError(error) }] }
        }
      },
    })
    const ext = defineExtension({ name: 'clinmesh.legacy-cli', tools: [cliTool] })
    const instructions = [
      '你是 ClinMesh 门诊临床助手，请使用 `clinmesh_cli` 工具执行真实 HIS 命令完成任务。',
      '严禁编造或推测未在可见记录中出现的诊断（严格遵守 Reveal Policy）。',
      '',
      '--- BEGIN clinmesh-shared/SKILL.md ---',
      SHARED_SKILL_MD,
      '--- END clinmesh-shared/SKILL.md ---',
      '',
      '--- BEGIN clinmesh-doctor/SKILL.md ---',
      DOCTOR_SKILL_MD,
      '--- END clinmesh-doctor/SKILL.md ---',
    ].join('\n')
    const schemaChars = JSON.stringify(cliParams).length + 120
    return {
      meta: buildArmMeta(armId, instructions.length, 1, schemaChars),
      extensions: [ext],
      instructions,
      skillReceipt: {
        skillBundle: 'legacy-shared+doctor-monolith',
        schemaVersion: 'legacy-1.0',
        sha256: sha256Short(SHARED_SKILL_MD + DOCTOR_SKILL_MD),
        catalogCount: OUTPATIENT_DOCTOR_OPS.length,
        injectedBytes: Buffer.byteLength(instructions, 'utf8'),
      },
      cleanup: async () => undefined,
    }
  }

  // ─── B3: Multica-Style Agent-First CLI ────────────────────────────────────
  if (armId === 'B3-multica-cli') {
    const cliParams = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: [
            'ClinMesh Agent-First CLI 命令。支持：',
            '- 分组帮助：`help` / `<group> --help` / `<subcommand> --help`（含参数 schema）',
            '- 复合只读命令：`doctor briefing --caseId <id> --encounterId <id>`，`doctor safety-audit --caseId <id> --encounterId <id>`',
            '- 原子命令：`doctor case get`、`catalog clinical get`、`encounter clinical-document draft set` 等',
          ].join('\n'),
        },
        input: { type: 'object', description: '结构化 JSON 参数对象（免手工 shell 转义）。' },
        compact: { type: 'boolean', description: '默认 true：开启 --summary/--compact 紧凑投影裁剪冗余字段。' },
        fields: { type: 'string', description: '可选逗号分隔字段投影（--fields）。' },
        dryRun: { type: 'boolean', description: '可选 --dry-run 校验参数与风险等级但不发送写请求。' },
      },
      required: ['command'],
      additionalProperties: false,
    }

    const groupedHelp = (): string => {
      const groups = new Map<string, HisOperationDefinition[]>()
      for (const op of OUTPATIENT_DOCTOR_OPS) {
        const g = op.cliPath[0]!
        const list = groups.get(g) ?? []
        list.push(op)
        groups.set(g, list)
      }
      const lines = [
        'ClinMesh Agent-First CLI (Multica Pattern)',
        'Compound Macros:',
        '  doctor briefing         (--caseId, --encounterId) 一次获取病例+检验+评分+完诊预览紧凑摘要',
        '  doctor safety-audit     (--caseId, --encounterId) 一次获取完诊门禁+临床质控+评分+指南+医嘱组检查',
        'Command Groups (use "<group> --help" or "<cmd> --help"):',
      ]
      for (const [g, ops] of groups.entries()) {
        lines.push(`  ${g.padEnd(16)} ${ops.length} ops  e.g. ${ops.slice(0, 3).map(o => o.cliPath.join(' ')).join(', ')}`)
      }
      return lines.join('\n')
    }

    const cliTool = defineTool({
      name: 'clinmesh',
      description: 'Multica 风格 Agent-First CLI：内置分组 --help、报错回显 schema、--compact/--fields 裁剪、自动幂等与复合宏命令。',
      parameters: cliParams,
      replay: 'unsafe',
      execute: async (rawArgs) => {
        const args = rawArgs as { command: string; input?: Record<string, unknown>; compact?: boolean; fields?: string; dryRun?: boolean }
        const cmd = args.command.trim().replace(/^clinmesh\s+/, '')
        const compact = args.compact !== false
        const input = args.input ?? {}

        if (cmd === 'help' || cmd === '--help' || cmd === '') {
          return { output: [{ type: 'text', text: groupedHelp() }] }
        }

        // Compound macros (Multica-style high-density CLI commands)
        if (cmd.startsWith('doctor briefing')) {
          const caseId = String(input.caseId ?? cmd.match(/--caseId\s+(\S+)/)?.[1] ?? '')
          const encounterId = String(input.encounterId ?? cmd.match(/--encounterId\s+(\S+)/)?.[1] ?? '')
          if (!caseId) {
            return { isError: true, output: [{ type: 'text', text: 'STDERR: Missing caseId.\nUSAGE: doctor briefing with input { caseId, encounterId }' }] }
          }
          const [caseDetail, scores, completion] = await Promise.all([
            fixture.executeOp('doctor.case.get', { caseId }),
            fixture.executeOp('doctor.case.clinical-scores.read', { caseId }),
            encounterId ? fixture.executeOp('encounter.completion.preview', { encounterId }) : Promise.resolve(null),
          ])
          const out = {
            case: compactOperationOutput('doctor.case.get', caseDetail),
            clinicalScores: compactOperationOutput('doctor.case.clinical-scores.read', scores),
            completionPreview: completion,
          }
          return { output: [{ type: 'text', text: JSON.stringify(applyFieldsAndTail(out, args.fields)) }] }
        }

        if (cmd.startsWith('doctor safety-audit')) {
          const caseId = String(input.caseId ?? cmd.match(/--caseId\s+(\S+)/)?.[1] ?? '')
          const encounterId = String(input.encounterId ?? cmd.match(/--encounterId\s+(\S+)/)?.[1] ?? '')
          if (!caseId || !encounterId) {
            return { isError: true, output: [{ type: 'text', text: 'STDERR: Missing caseId/encounterId.\nUSAGE: doctor safety-audit with input { caseId, encounterId }' }] }
          }
          const [completion, quality, scores, guidelines, orderSets, caseDetail] = await Promise.all([
            fixture.executeOp('encounter.completion.preview', { encounterId }),
            fixture.executeOp('encounter.clinical-quality.read', { encounterId, gate: 'outpatient-completion' }),
            fixture.executeOp('doctor.case.clinical-scores.read', { caseId }),
            fixture.executeOp('doctor.case.guideline-topics.read', { caseId }),
            fixture.executeOp('doctor.case.order-set-drafts.read', { caseId }),
            fixture.executeOp('doctor.case.get', { caseId }),
          ])
          const out = {
            caseSummary: compactOperationOutput('doctor.case.get', caseDetail),
            completionPreview: completion,
            clinicalQuality: quality,
            clinicalScores: compactOperationOutput('doctor.case.clinical-scores.read', scores),
            guidelineTopics: compactOperationOutput('doctor.case.guideline-topics.read', guidelines),
            orderSetDrafts: compactOperationOutput('doctor.case.order-set-drafts.read', orderSets),
          }
          return { output: [{ type: 'text', text: JSON.stringify(applyFieldsAndTail(out, args.fields)) }] }
        }

        // Group or command --help
        if (cmd.endsWith('--help') || cmd.endsWith('-h')) {
          const prefix = cmd.replace(/\s+(--help|-h)$/, '').trim()
          const exactOp = OUTPATIENT_DOCTOR_OPS.find(o => o.cliPath.join(' ') === prefix || o.id === prefix)
          if (exactOp) {
            return {
              output: [{
                type: 'text',
                text: JSON.stringify({
                  command: exactOp.cliPath.join(' '),
                  operationId: exactOp.id,
                  mode: exactOp.mode,
                  risk: exactOp.risk,
                  summary: exactOp.summary,
                  inputSchema: sanitizeJsonSchema(exactOp.input),
                }),
              }],
            }
          }
          const matched = OUTPATIENT_DOCTOR_OPS.filter(o => o.cliPath.join(' ').startsWith(prefix))
          if (matched.length > 0) {
            return {
              output: [{
                type: 'text',
                text: matched.map(o => `${o.cliPath.join(' ')} [${o.risk}] — ${o.summary}`).join('\n'),
              }],
            }
          }
          return { output: [{ type: 'text', text: groupedHelp() }] }
        }

        const op = OUTPATIENT_DOCTOR_OPS.find(o => o.cliPath.join(' ') === cmd || o.id === cmd)
        if (!op) {
          const suggestions = searchCatalog(cmd, { limit: 5 })
          return {
            isError: true,
            output: [{
              type: 'text',
              text: `STDERR: Unknown command "${cmd}".\nClosest valid commands:\n${suggestions.map(s => `  ${s.cli} (${s.id}) req=[${s.requiredArgs.join(',')}]`).join('\n')}`,
            }],
          }
        }

        if (args.dryRun) {
          const check = op.input.safeParse(input)
          return {
            output: [{
              type: 'text',
              text: JSON.stringify({
                dryRun: true,
                operationId: op.id,
                risk: op.risk,
                valid: check.success,
                ...(check.success ? {} : { issues: check.error.issues.slice(0, 5) }),
              }),
            }],
          }
        }

        try {
          const raw = await executeWithDeterministicIdempotency(fixture, op, input)
          const projected = applyFieldsAndTail(compact ? compactOperationOutput(op.id, raw) : raw, args.fields)
          return { output: [{ type: 'text', text: JSON.stringify(projected) }] }
        } catch (error) {
          const schema = sanitizeJsonSchema(op.input)
          return {
            isError: true,
            output: [{
              type: 'text',
              text: `STDERR: ${formatOpError(error)}\nHELP (${op.cliPath.join(' ')}): ${JSON.stringify(schema)}`,
            }],
          }
        }
      },
    })

    const ext = defineExtension({ name: 'clinmesh.multica-cli', tools: [cliTool] })
    const instructions = [
      '你是 ClinMesh 门诊临床助手，使用 Multica 风格 Agent-First CLI 工具 `clinmesh` 操作真实 HIS。',
      '',
      '## 静态速查索引（<2KB，稳定缓存前缀）',
      '- 综合简报：`command="doctor briefing"`, `input={ caseId, encounterId }`（一调汇聚病例+检验+评分+完诊预览）',
      '- 完诊安全核查：`command="doctor safety-audit"`, `input={ caseId, encounterId }`（一调汇聚完诊门禁+质控+评分+指南+医嘱组）',
      '- 查任意命令参数：`command="<cmd> --help"`（写操作出错也会自动回显精确 JSON Schema）',
      '- 门诊完整闭环写入路径：',
      '  1. `catalog clinical get` 查有效诊断与药品目录 ID',
      '  2. `encounter clinical-document draft set` → `encounter clinical-document preview-sign` → `encounter clinical-document sign`',
      '  3. `encounter diagnosis draft set` → `encounter diagnosis confirm`（注意 confirm 后 encounterVersion 递增）',
      '  4. `encounter prescription draft set` + `encounter prescription issue`（或 `encounter medication-conclusion confirm-none`）',
      '  5. `encounter completion preview` → `encounter complete`',
      '- 红线：严禁编造或泄露系统未展示的隐藏病例真值（Reveal Policy）；审计任务禁写操作。',
    ].join('\n')
    const schemaChars = JSON.stringify(cliParams).length + 140
    return {
      meta: buildArmMeta(armId, instructions.length, 1, schemaChars),
      extensions: [ext],
      instructions,
      skillReceipt: {
        skillBundle: 'multica-agent-first-cli-index',
        schemaVersion: '2026.1',
        sha256: sha256Short(instructions),
        catalogCount: OUTPATIENT_DOCTOR_OPS.length,
        injectedBytes: Buffer.byteLength(instructions, 'utf8'),
      },
      cleanup: async () => undefined,
    }
  }

  // ─── B4: 2026 Stateless Progressive MCP over Real HTTP ────────────────────
  if (armId === 'B4-stateless-mcp-2026') {
    const mcpServer = await startStatelessMcp2026Server(fixture)
    let rpcSeq = 0
    const callMcp = async (method: string, params: Record<string, unknown>) => {
      rpcSeq += 1
      const resp = await fetch(mcpServer.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcSeq, method, params }),
      })
      const json = await resp.json() as { result?: unknown; error?: { message: string } }
      if (json.error) throw new Error(json.error.message)
      return json.result
    }

    const pSearch = {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词搜索（如 "case", "scores", "clinical-document", "diagnosis", "prescription", "complete"）。' },
        mode: { type: 'string', enum: ['query', 'draft', 'preview', 'command'] },
        limit: { type: 'integer', minimum: 1, maximum: 15 },
      },
      required: ['query'],
      additionalProperties: false,
    }
    const pGet = {
      type: 'object',
      properties: {
        operationIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: '要获取精确 JSON Schema 与 Tool Annotations 的操作 ID 列表。' },
      },
      required: ['operationIds'],
      additionalProperties: false,
    }
    const pRun = {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: '完整操作 ID（如 doctor.case.get）。' },
        input: { type: 'object', description: '符合该操作 inputSchema 的 JSON 参数对象。' },
        compact: { type: 'boolean', description: '默认 true，启用紧凑临床视图投影。' },
      },
      required: ['operationId', 'input'],
      additionalProperties: false,
    }
    const pPlaybook = {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['outpatient-briefing', 'outpatient-safety-audit', 'outpatient-e2e-write'] },
      },
      required: ['name'],
      additionalProperties: false,
    }

    const tools: ToolRegistration[] = [
      defineTool({
        name: 'mcp_search_operations',
        description: '通过 2026 Stateless MCP 渐进搜索 ClinMesh HIS 操作目录（返回摘要与必填字段）。',
        parameters: pSearch,
        replay: 'safe',
        execute: async (args) => {
          try {
            const res = await callMcp('tools/call', { name: 'clinmesh_search_operations', arguments: args as Record<string, unknown> })
            return { output: [{ type: 'text', text: JSON.stringify(res) }] }
          } catch (e) {
            return { isError: true, output: [{ type: 'text', text: String(e) }] }
          }
        },
      }),
      defineTool({
        name: 'mcp_get_operation',
        description: '按需拉取 1~5 个 HIS 操作的精确 JSON Schema 与 Tool Annotations。',
        parameters: pGet,
        replay: 'safe',
        execute: async (args) => {
          try {
            const res = await callMcp('tools/call', { name: 'clinmesh_get_operation', arguments: args as Record<string, unknown> })
            return { output: [{ type: 'text', text: JSON.stringify(res) }] }
          } catch (e) {
            return { isError: true, output: [{ type: 'text', text: String(e) }] }
          }
        },
      }),
      defineTool({
        name: 'mcp_run_operation',
        description: '通过 HTTP POST /api/mcp 执行任意 HIS 操作（默认 compact=true 返回紧凑临床投影）。',
        parameters: pRun,
        replay: 'unsafe',
        execute: async (args) => {
          try {
            const res = await callMcp('tools/call', { name: 'clinmesh_run_operation', arguments: args as Record<string, unknown> })
            return { output: [{ type: 'text', text: JSON.stringify(res) }] }
          } catch (e) {
            return { isError: true, output: [{ type: 'text', text: String(e) }] }
          }
        },
      }),
      defineTool({
        name: 'mcp_read_playbook',
        description: '读取协议无关的 Clinical Playbook MCP Prompt（简报/安全审计/完诊闭环步骤）。',
        parameters: pPlaybook,
        replay: 'safe',
        execute: async (args) => {
          try {
            const res = await callMcp('prompts/get', args as Record<string, unknown>)
            return { output: [{ type: 'text', text: JSON.stringify(res) }] }
          } catch (e) {
            return { isError: true, output: [{ type: 'text', text: String(e) }] }
          }
        },
      }),
    ]

    const ext = defineExtension({ name: 'clinmesh.mcp2026', tools })
    const instructions = [
      '你是 ClinMesh 门诊临床助手，通过 2026-07-28 无状态渐进式 MCP 网关（POST /api/mcp）执行操作。',
      '工作流：',
      '1. 按需调用 `mcp_read_playbook` 获取任务手册（outpatient-briefing / outpatient-safety-audit / outpatient-e2e-write）。',
      '2. 未知参数时先用 `mcp_search_operations` / `mcp_get_operation` 批量获取精确 Schema（支持一次取最多 5 个）。',
      '3. 可并行发起多个只读 `mcp_run_operation` 调用以减少轮次。',
      '红线：严禁编造或泄露未展示的隐藏病例真值（Reveal Policy）；审计任务禁写操作。',
    ].join('\n')
    const schemaChars = JSON.stringify([pSearch, pGet, pRun, pPlaybook]).length + 420
    return {
      meta: buildArmMeta(armId, instructions.length, tools.length, schemaChars),
      extensions: [ext],
      instructions,
      skillReceipt: {
        skillBundle: 'stateless-mcp-2026-07-28',
        schemaVersion: '2026-07-28',
        sha256: sha256Short(instructions + Object.values(DOMAIN_PLAYBOOKS).join('\n')),
        catalogCount: OUTPATIENT_DOCTOR_OPS.length,
        injectedBytes: Buffer.byteLength(instructions, 'utf8'),
      },
      cleanup: mcpServer.close,
    }
  }

  // ─── Helper: Build 5 Domain Extensions shared by B5 & B6 ──────────────────
  const buildFiveDomainExtensions = (mode: 'tool-search' | 'codemode'): Extension[] => {
    const buckets: Record<string, ToolRegistration[]> = {
      clinical_case: [],
      diagnostics: [],
      therapy: [],
      cds: [],
      finance: [],
    }
    const nsDesc: Record<string, { desc: string; instructions: string }> = {
      clinical_case: {
        desc: '门诊病例详情、病历草稿/签署、接诊完诊与预览',
        instructions: '读病例用 doctor_case_get({ caseId })；完诊检查用 encounter_completion_preview({ encounterId })；病历写入依次 draft_set → sign_preview → sign。',
      },
      diagnostics: {
        desc: '检验/影像/检查/病理申请与报告确认',
        instructions: '读取检验报告可直接从 doctor_case_get 返回的 laboratoryReports 获取。',
      },
      therapy: {
        desc: '诊断草稿/确认、处方草稿/开立、无需用药结论与临床处置',
        instructions: '诊断：encounter_diagnosis_draft_set → encounter_diagnosis_confirm（注意 encounterVersion 变更）；用药：encounter_prescription_draft_set → encounter_prescription_issue 或 confirm_none。',
      },
      cds: {
        desc: '临床评分、指南主题、医嘱组草稿与临床质控门禁',
        instructions: 'doctor_case_clinical_scores_read / guideline_topics_read / order_set_drafts_read 传 { caseId }；encounter_clinical_quality_read 传 { encounterId, gate: "outpatient-completion" }。',
      },
      finance: {
        desc: '临床参考目录（诊断/药品目录）与回执查询',
        instructions: 'catalog_clinical_read({}) 返回有效 diagnoses[] 与 medications[] ID 与规范剂量频次。',
      },
    }

    for (const op of OUTPATIENT_DOCTOR_OPS) {
      const domain = classifyDomain(op)
      const schema = sanitizeJsonSchema(op.input)
      const isHighRisk = HIGH_RISK_WRITE_IDS.has(op.id)
      const callers: readonly ('model' | 'tools')[] | undefined = mode === 'codemode'
        ? (isHighRisk ? ['model'] : ['tools'])
        : undefined
      const tool = defineTool({
        name: opToToolName(op.id),
        description: `[${op.mode}/${op.risk}] ${op.summary}`,
        parameters: schema,
        structuredOutputSchema: { type: 'object' },
        deferred: true,
        ...(callers ? { callers } : {}),
        replay: op.risk === 'read' ? 'safe' : 'unsafe',
        execute: async (args) => {
          try {
            const raw = await executeWithDeterministicIdempotency(fixture, op, args)
            const compact = compactOperationOutput(op.id, raw)
            const structured = (compact !== null && typeof compact === 'object' && !Array.isArray(compact))
              ? compact as Record<string, unknown>
              : { value: compact }
            return {
              output: [{ type: 'text', text: JSON.stringify(structured) }],
              structuredOutput: JSON.parse(JSON.stringify(structured)),
            }
          } catch (error) {
            return { isError: true, output: [{ type: 'text', text: formatOpError(error) }] }
          }
        },
      })
      buckets[domain]!.push(tool)
    }

    return Object.entries(buckets).map(([domain, tools]) =>
      defineExtension({
        name: `clinmesh.${domain}`,
        namespace: {
          name: domain,
          description: nsDesc[domain]!.desc,
          instructions: nsDesc[domain]!.instructions,
        },
        tools,
      }),
    )
  }

  // ─── B5: Hybrid pi-durable tool_search + Clinical Workflow Macros ─────────
  if (armId === 'B5-hybrid-tool-search') {
    const pBriefing = {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        encounterId: { type: 'string' },
      },
      required: ['caseId', 'encounterId'],
      additionalProperties: false,
    }
    const pAudit = {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        encounterId: { type: 'string' },
      },
      required: ['caseId', 'encounterId'],
      additionalProperties: false,
    }
    const pWritePreflight = {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        encounterId: { type: 'string' },
      },
      required: ['caseId', 'encounterId'],
      additionalProperties: false,
    }
    const pPlaybook = {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['outpatient-briefing', 'outpatient-safety-audit', 'outpatient-e2e-write'] },
      },
      required: ['name'],
      additionalProperties: false,
    }

    const macroExt = defineExtension({
      name: 'clinmesh.macros',
      tools: [
        defineTool({
          name: 'macro_clinical_briefing',
          description: '【临床工作流宏】并行读取可见病例、生命体征、全部检验报告、临床评分与完诊预览并返回紧凑摘要。',
          parameters: pBriefing,
          replay: 'safe',
          execute: async (raw) => {
            const { caseId, encounterId } = raw as { caseId: string; encounterId: string }
            const [caseDetail, scores, completion] = await Promise.all([
              fixture.executeOp('doctor.case.get', { caseId }),
              fixture.executeOp('doctor.case.clinical-scores.read', { caseId }),
              fixture.executeOp('encounter.completion.preview', { encounterId }),
            ])
            return {
              output: [{
                type: 'text',
                text: JSON.stringify({
                  case: compactOperationOutput('doctor.case.get', caseDetail),
                  clinicalScores: compactOperationOutput('doctor.case.clinical-scores.read', scores),
                  completionPreview: completion,
                }),
              }],
            }
          },
        }),
        defineTool({
          name: 'macro_safety_completion_audit',
          description: '【临床工作流宏】只读并行核查完诊门禁、临床质控、临床评分、指南主题与医嘱组适用性。',
          parameters: pAudit,
          replay: 'safe',
          execute: async (raw) => {
            const { caseId, encounterId } = raw as { caseId: string; encounterId: string }
            const [caseDetail, completion, quality, scores, guidelines, orderSets] = await Promise.all([
              fixture.executeOp('doctor.case.get', { caseId }),
              fixture.executeOp('encounter.completion.preview', { encounterId }),
              fixture.executeOp('encounter.clinical-quality.read', { encounterId, gate: 'outpatient-completion' }),
              fixture.executeOp('doctor.case.clinical-scores.read', { caseId }),
              fixture.executeOp('doctor.case.guideline-topics.read', { caseId }),
              fixture.executeOp('doctor.case.order-set-drafts.read', { caseId }),
            ])
            return {
              output: [{
                type: 'text',
                text: JSON.stringify({
                  caseSummary: compactOperationOutput('doctor.case.get', caseDetail),
                  completionPreview: completion,
                  clinicalQuality: quality,
                  clinicalScores: compactOperationOutput('doctor.case.clinical-scores.read', scores),
                  guidelineTopics: compactOperationOutput('doctor.case.guideline-topics.read', guidelines),
                  orderSetDrafts: compactOperationOutput('doctor.case.order-set-drafts.read', orderSets),
                }),
              }],
            }
          },
        }),
        defineTool({
          name: 'macro_outpatient_write_preflight',
          description: '【临床工作流宏】一次性读取当前 encounterVersion、病历/诊断/处方草稿版本、完诊阻断项与有效临床目录（诊断+药品ID）。',
          parameters: pWritePreflight,
          replay: 'safe',
          execute: async (raw) => {
            const { caseId, encounterId } = raw as { caseId: string; encounterId: string }
            const [caseDetail, catalog, completion] = await Promise.all([
              fixture.executeOp('doctor.case.get', { caseId }),
              fixture.executeOp('catalog.clinical.read', {}),
              fixture.executeOp('encounter.completion.preview', { encounterId }),
            ])
            return {
              output: [{
                type: 'text',
                text: JSON.stringify({
                  case: compactOperationOutput('doctor.case.get', caseDetail),
                  catalog: compactOperationOutput('catalog.clinical.read', catalog),
                  completionPreview: completion,
                }),
              }],
            }
          },
        }),
        defineTool({
          name: 'read_clinical_playbook',
          description: '按需加载任务级 Clinical Playbook（简报/安全审计/完诊闭环操作顺序与版本流转指南）。',
          parameters: pPlaybook,
          replay: 'safe',
          execute: async (raw) => {
            const { name } = raw as { name: string }
            return { output: [{ type: 'text', text: DOMAIN_PLAYBOOKS[name] ?? 'Unknown playbook' }] }
          },
        }),
      ],
    })

    const toolSearchExt = createToolSearchExtension()
    const domainExts = buildFiveDomainExtensions('tool-search')
    const instructions = [
      '你是 ClinMesh 门诊临床助手（Hybrid Harness: pi-durable tool_search + 临床工作流宏）。',
      '## 静态引导（Layer 0，稳定缓存前缀）',
      '- 高频复合只读任务直接调用确定性宏：`macro_clinical_briefing`、`macro_safety_completion_audit`、`macro_outpatient_write_preflight`。',
      '- 原子写操作（73 项 HIS 能力）全部为 deferred 工具：先用 `tool_search` 一次检索并加载所需写工具，再按 `read_clinical_playbook` 顺序提交。',
      '- 门诊完整写入顺序：`clinical_document_draft_set` → `sign_preview` → `sign` → `diagnosis_draft_set` → `diagnosis_confirm`（递增 encounterVersion）→ `prescription_draft_set` + `prescription_issue`（或 `medication_conclusion_confirm_none`）→ `encounter_complete`。',
      '- 安全红线：严禁编造或泄露系统未展示的隐藏病例真值（Reveal Policy）；审计任务禁写操作。',
    ].join('\n')
    const schemaChars = JSON.stringify([pBriefing, pAudit, pWritePreflight, pPlaybook]).length + 650
    return {
      meta: buildArmMeta(armId, instructions.length, 5, schemaChars), // 4 macro/playbook + 1 tool_search
      extensions: [toolSearchExt, macroExt, ...domainExts],
      instructions,
      skillReceipt: {
        skillBundle: 'hybrid-tool-search-macros-v1',
        schemaVersion: '2026.1',
        sha256: sha256Short(instructions + Object.values(DOMAIN_PLAYBOOKS).join('\n')),
        catalogCount: OUTPATIENT_DOCTOR_OPS.length,
        injectedBytes: Buffer.byteLength(instructions, 'utf8'),
      },
      cleanup: async () => undefined,
    }
  }

  // ─── B6: Hybrid pi-durable QuickJS Codemode + High-Risk Model Red-Line ────
  const sandbox = new CodemodeSandbox()
  const codemodeExt = createCodemodeExtension({
    sandbox,
    models: false,
    inlineBudget: 2400,
  })
  const toolSearchExt = createToolSearchExtension()
  const domainExts = buildFiveDomainExtensions('codemode')

  const playbookExt = defineExtension({
    name: 'clinmesh.playbooks',
    tools: [
      defineTool({
        name: 'read_clinical_playbook',
        description: '按需加载 Clinical Playbook（简报/安全审计/完诊闭环步骤）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: ['outpatient-briefing', 'outpatient-safety-audit', 'outpatient-e2e-write'] },
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
    ],
  })

  const instructions = [
    '你是 ClinMesh 门诊临床助手（Hybrid Harness: pi-durable QuickJS Codemode + 高危提交模型直控红线）。',
    '## 静态引导（Layer 0，稳定缓存前缀）',
    '- **所有只读、草稿、预览工具均在 `codemode` QuickJS 沙箱中可用**：请在一个 `codemode` 脚本中用 `await Promise.all([...])` 并行拉取并过滤所需数据，并用 `return` 返回精炼 JSON！',
    '  - 常用沙箱工具名：`tools.doctor_case_get({ caseId })`、`tools.doctor_case_clinical_scores_read({ caseId })`、`tools.doctor_case_guideline_topics_read({ caseId })`、`tools.doctor_case_order_set_drafts_read({ caseId })`、`tools.encounter_completion_preview({ encounterId })`、`tools.encounter_clinical_quality_read({ encounterId, gate: "outpatient-completion" })`、`tools.catalog_clinical_read({})`、`tools.encounter_clinical_document_draft_set(...)`、`tools.encounter_clinical_document_sign_preview(...)`、`tools.encounter_diagnosis_draft_set(...)`、`tools.encounter_prescription_draft_set(...)`。',
    '  - 不确定某工具参数时，可在沙箱内先调用 `describeTool("工具名")` 或 `searchTools("关键词")`。',
    '- **高危临床提交红线（物理隔离）**：`encounter_clinical_document_sign`、`encounter_diagnosis_confirm`、`encounter_prescription_issue`、`encounter_medication_conclusion_confirm_none`、`encounter_complete` 仅允许模型直接调用（`callers: ["model"]`，沙箱内不可见）。执行完整门诊写入时：先在 `codemode` 内一次准备好目录/草稿/签名预览，再用 `tool_search` 加载高危提交工具并逐项显式提交。',
    '- 严禁编造或泄露系统未展示的隐藏病例真值（Reveal Policy）；审计任务禁写操作。',
  ].join('\n')

  const schemaChars = 1900 // codemode + tool_search + read_clinical_playbook + inlineBudget declarations
  return {
    meta: buildArmMeta(armId, instructions.length, 3, schemaChars), // codemode + tool_search + read_clinical_playbook
    extensions: [codemodeExt, toolSearchExt, playbookExt, ...domainExts],
    instructions,
    skillReceipt: {
      skillBundle: 'hybrid-quickjs-codemode-redline-v1',
      schemaVersion: '2026.1',
      sha256: sha256Short(instructions + Object.values(DOMAIN_PLAYBOOKS).join('\n')),
      catalogCount: OUTPATIENT_DOCTOR_OPS.length,
      injectedBytes: Buffer.byteLength(instructions, 'utf8'),
    },
    cleanup: async () => {
      if ('close' in sandbox && typeof sandbox.close === 'function') {
        await (sandbox as { close: () => Promise<void> }).close().catch(() => undefined)
      }
    },
  }
}
