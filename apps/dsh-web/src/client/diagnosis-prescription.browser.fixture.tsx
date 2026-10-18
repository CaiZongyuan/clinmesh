import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createMemoryHistory } from '@tanstack/react-router'
import { z } from 'zod'
import {
  confirmDiagnosisRequestSchema,
  issuePrescriptionRequestSchema,
  saveDiagnosisDraftRequestSchema,
  savePrescriptionDraftRequestSchema,
  type DiagnosisDraftEntry,
  type DoctorCaseDetail,
  type PrescriptionDraftItem,
  type SessionContext,
} from '@clinmesh/contracts/his'
import type { ReferenceConcept, ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import {
  confirmDoctorPreparationRequestSchema, doctorRecommendationKindSchema, doctorRecommendationStateSchema, generateDoctorRecommendationsRequestSchema,
  type DoctorRecommendationState, type GuidelineEvidence,
} from '@clinmesh/contracts/doctor-recommendations'
import { WebApp } from '../../../web/src/app/web-app.tsx'

const session: SessionContext = {
  actor: {
    actorId: 'synthetic-doctor', epoch: 'synthetic-epoch', locationId: 'synthetic-clinic',
    organizationId: 'synthetic-hospital', practitionerId: 'synthetic-doctor',
    practitionerRoleId: 'synthetic-doctor-role', roleCode: 'outpatient-doctor',
    scenarioRunId: 'synthetic-run', workspaceId: 'synthetic-workspace',
  },
  availableRoles: [{
    code: 'outpatient-doctor', id: 'synthetic-doctor-role', locationId: 'synthetic-clinic',
    organizationId: 'synthetic-hospital', practitionerId: 'synthetic-doctor', practitionerName: '合成医生',
  }],
  user: { email: 'synthetic-doctor@example.test', id: 'synthetic-doctor', name: '合成医生' },
}
const diagnoses: ReferenceConcept[] = [
  { id: 'synthetic-diagnosis-1', code: 'SYN-D1', display: '合成诊断与需要完整显示的复杂中文名称',
    domain: 'diagnosis', sourceLocator: 'synthetic:test', system: 'urn:synthetic:diagnosis', version: '1', status: 'active' },
  { id: 'synthetic-diagnosis-2', code: 'SYN-D2', display: '合成第二诊断',
    domain: 'diagnosis', sourceLocator: 'synthetic:test', system: 'urn:synthetic:diagnosis', version: '1', status: 'active' },
  { id: 'synthetic-diagnosis-3', code: 'SYN-D3', display: '合成追加诊断',
    domain: 'diagnosis', sourceLocator: 'synthetic:test', system: 'urn:synthetic:diagnosis', version: '1', status: 'active' },
]
const medication: ReferenceMedicationProduct = {
  approvalNumber: '合成批准号', brandName: '合成商品名', code: 'SYN-M1', dosageForm: '片剂',
  genericName: '合成药品与需要完整显示的复杂中文通用名称', id: 'synthetic-product-1',
  manufacturer: '合成制药有限公司与很长的生产企业名称', packageDescription: '10片/盒',
  sourceLocator: 'synthetic:test', status: 'active', strength: '10 mg',
  system: 'urn:synthetic:medication', version: '1',
}
const products = [medication, { ...medication, id: 'synthetic-product-2', code: 'SYN-M2', packageDescription: '20片/盒' },
  { ...medication, id: 'synthetic-product-3', code: 'SYN-M3', genericName: '合成第二药品', packageDescription: '30片/盒' }]
const recommendationsMode = document.documentElement.dataset.fixtureMode === 'recommendations'
const recommendationGuidelines: GuidelineEvidence[] = [
  ...(['national-standard', 'official-protocol', 'guideline'] as const).map(documentType => ({
    id: `synthetic-${documentType}`, documentType, title: `合成浏览器来源分类 ${documentType}`,
    publisher: '合成发布机构', version: '1', scope: '仅验证浏览器来源分类，不提供临床依据。',
    locator: '合成条款 1', text: '合成来源分类合同文字。', url: `https://example.test/${documentType}`,
    sourceHash: 'a'.repeat(64),
  })),
  {
    id: 'ws-t-872-2025-initial-assessment', documentType: 'health-standard',
    title: 'WS/T 872—2025 基层医疗卫生机构高血压防治管理标准', publisher: '国家卫生健康委员会',
    version: 'WS/T 872—2025', locator: '第 7 节，印刷第 2 页',
    scope: '基层医疗卫生机构成人高血压管理；不能从本标准推导具体药品剂量或固定疗程。',
    text: '符合高血压诊断的患者，应进行首次评估，询问病史、进行体格检查和血尿常规、生化及心电图检测。',
    url: 'https://www.nhc.gov.cn/fzs/c100048/202509/2f3f7cce449145f8b361e70b3ed4ae9a/files/WS%20T%20872%E2%80%942025-20250930105429913.pdf',
    sourceHash: '4c099a4a656b72d6524c7acd05359da10b4dd861def402b80acd94a307d410d6',
  },
  {
    id: 'viatris-norvasc-adult-hypertension-dose', documentType: 'product-information',
    title: '苯磺酸氨氯地平片（络活喜）说明书', publisher: '晖致制药（大连）有限公司',
    version: '2026-10-13 核验版本', locator: '“用法用量—成人”，印刷第 3 页',
    scope: '需核对既有方案、年龄、体型、虚弱与肝功能；本合成药品并非此具体产品，不套用包装或固定疗程与数量。',
    text: '通常本品治疗高血压的起始剂量为5 mg，每日一次，最大剂量为10 mg，每日一次。\n身材小、虚弱、老年、或伴肝功能不全患者，起始剂量为2.5 mg，每日一次；此剂量也可为本品联合其它抗高血压药物治疗的剂量。',
    url: 'https://www.viatris.cn/-/media/project/viatris-sites/product-document/02norvasc.pdf',
    sourceHash: '6421355efdba7552efc1d814295f8dcff186dfbb44805af6d78c6673199e5689',
  },
]
function diagnosisReference(concept: ReferenceConcept) {
  return { id: concept.id, code: concept.code, display: concept.display, sourceLocator: concept.sourceLocator,
    system: concept.system, version: concept.version }
}
const initialEntries: DiagnosisDraftEntry[] = diagnoses.slice(0, 2).map((concept, index) => ({
  catalogItemId: concept.id, role: index === 0 ? 'primary' : 'secondary',
  note: '合成临床备注，长中文文字与多个检查依据应完整展示。'.repeat(8),
  referenceConcept: diagnosisReference(concept),
}))
const initialItems: PrescriptionDraftItem[] = [products[1]!, products[2]!].map(product => ({
  catalogItemId: product.id, courseDays: 3, doseText: '每次一片，合成剂量说明', frequencyCode: '每日两次',
  quantity: 1, referenceProduct: product,
}))
const detail: DoctorCaseDetail = {
  allergies: [], caseId: 'synthetic-case', consultation: { turns: [], version: 1 },
  consultationRecording: { hasSavedDraft: false, version: 1, paused: false, processedCount: 0,
    remainingCount: 0, failedCount: 0, status: 'idle', failures: [], additions: [] },
  encounter: { id: 'synthetic-encounter', status: 'in-progress', versionId: '1' },
  imagingRequests: { draftVersion: 0, requests: [] }, pathologyRequests: { draftVersion: 0, requests: [] },
  laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC-1', name: '合成浏览器患者', synthetic: true, versionId: '1' },
  presentation: { chiefComplaint: '合成主诉', summary: '合成浏览器合同', vitalSigns: {
    bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, oxygenSaturationPct: 98,
    pulseBpm: 80, respirationBpm: 18, temperatureC: 37,
  } }, priorFacts: [], status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
}
function confirm(entries: DiagnosisDraftEntry[], revisionNumber: number) {
  return {
    confirmedAt: '2026-10-10T10:00:00+08:00', id: `synthetic-confirmation-${revisionNumber}`,
    provenanceId: `synthetic-provenance-${revisionNumber}`, revisionNumber,
    entries: entries.map((entry, index) => {
      const concept = diagnoses.find(item => item.id === entry.catalogItemId)!
      return { ...entry, code: concept.code, display: concept.display, system: concept.system,
        conditionId: `synthetic-condition-${revisionNumber}-${index}`, conditionVersion: '1' }
    }),
  }
}
function issue(items: PrescriptionDraftItem[]) {
  return {
    authoredAt: '2026-10-10T10:00:00+08:00', authoredByPractitionerRoleId: 'synthetic-doctor-role',
    id: 'synthetic-prescription', number: 'SYN-RX-1', status: 'signed' as const, version: 1,
    items: items.map((item, index) => ({ ...item, display: products.find(product => product.id === item.catalogItemId)!.genericName,
      medicationRequestId: `synthetic-medication-request-${index}`, medicationRequestVersion: '1' })),
  }
}
if (document.documentElement.dataset.fixtureMode === 'existing') {
  detail.diagnosis = { draftVersion: 2, confirmation: confirm(initialEntries, 1) }
  detail.medicationConclusion = { draftVersion: 2, prescription: issue(initialItems) }
}
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const command = (data: unknown) => Response.json({
  auditId: 'synthetic-audit', data, effects: [], requestId: 'synthetic-command', warnings: [],
})
let failNextConfirmation = false
window.addEventListener('diagnosis-prescription-fail-confirmation', () => { failNextConfirmation = true })
const recommendationStates = new Map<string, DoctorRecommendationState>()
let updateRecommendationEvidence = false
window.addEventListener('diagnosis-prescription-change-evidence', () => { updateRecommendationEvidence = true })
// 只替换网络边界；本合同不证明 Server Command、授权或审计。
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'http://synthetic.test')
  const path = url.pathname
  if (path.endsWith('/recording-events')) {
    if (url.searchParams.has('since')) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); init?.signal?.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, 10_000)
      if (init?.signal?.aborted) finish()
      else init?.signal?.addEventListener('abort', finish, { once: true })
    })
    return Response.json({ revision: '0'.repeat(64) })
  }
  if (path === '/api/auth/context') return Response.json(session)
  if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [],
    medications: recommendationsMode ? [{
      id: medication.id, nameZh: medication.genericName, nameEn: 'Synthetic browser medication', version: 1,
      allowedCombinationIds: [], allowedDoseTexts: ['5 mg', '10 mg'], allowedFrequencyCodes: ['QD', 'BID'],
      allowedCourseDays: [3, 7], allowedQuantities: [1, 2],
      defaultDoseText: '10 mg', defaultFrequencyCode: 'BID', defaultCourseDays: 3, defaultQuantity: 1,
    }] : [], prescriptionConclusionSupported: true })
  if (path === '/api/his/v1/doctor/queue') return Response.json({
    items: [{ caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', patient: detail.patient,
      presentation: detail.presentation, status: detail.status, taskId: detail.taskId, taskVersion: '1' }],
    page: 1, pageSize: 20, total: 1,
  })
  if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(detail)
  if (path.endsWith('/document-quality-control/actions/check')) {
    return Response.json({ error: { code: 'MODEL_UNAVAILABLE', message: '本合同不运行病历质控。' } }, { status: 503 })
  }
  const preparedConfirmation = /^\/api\/his\/v1\/doctor\/cases\/synthetic-case\/recommendations\/(diagnosis|prescription)\/actions\/confirm$/.exec(path)
  if (preparedConfirmation !== null) {
    if (failNextConfirmation) {
      failNextConfirmation = false
      return Response.json({ error: { code: 'MODEL_UNAVAILABLE', message: '合成提交失败，未开具。' } }, { status: 503 })
    }
    const { input: saved } = confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body)))
    const kind = doctorRecommendationKindSchema.parse(preparedConfirmation[1])
    let draftVersion: number
    let recordIds: string[]
    if (kind === 'diagnosis') {
      const entries = saved.selections.map(item => {
        if (item.kind !== 'diagnosis') throw new Error('Unexpected prepared diagnosis kind')
        return { catalogItemId: item.catalogItemId, role: item.role, ...(item.note === undefined ? {} : { note: item.note }) }
      })
      const confirmation = confirm(entries, (detail.diagnosis?.confirmation?.revisionNumber ?? 0) + 1)
      draftVersion = (detail.diagnosis?.draftVersion ?? 0) + 2
      detail.diagnosis = { confirmation, draftVersion }
      recordIds = confirmation.entries.map(item => item.conditionId)
    } else {
      const items = saved.selections.map(item => {
        if (item.kind !== 'prescription') throw new Error('Unexpected prepared prescription kind')
        return { catalogItemId: item.catalogItemId, doseText: item.doseText, frequencyCode: item.frequencyCode,
          courseDays: item.courseDays, quantity: item.quantity }
      })
      const prescription = issue(items)
      draftVersion = (detail.medicationConclusion?.draftVersion ?? 0) + 2
      detail.medicationConclusion = { prescription, draftVersion }
      recordIds = [prescription.id]
    }
    return command({ kind, draftVersion, encounterVersion: detail.encounter.versionId, recordIds })
  }
  const recommendation = /^\/api\/his\/v1\/doctor\/cases\/synthetic-case\/recommendations\/([^/]+)(\/actions\/generate)?$/.exec(path)
  if (recommendation !== null) {
    const kind = doctorRecommendationKindSchema.parse(recommendation[1])
    let state = recommendationStates.get(kind)
    if (state === undefined) {
      const common = {
        rationale: '合成浏览器建议，长中文仅验证病例来源、草稿保护与医生正式确认接线。'.repeat(4),
        supportingInformation: ['合成支持信息，仅验证展示。'], opposingInformation: ['尚未核实合成检查结果。'],
        missingInformation: ['仍需医生核实，不代表已确诊或已开具。'],
        guidelineEvidenceIds: recommendationGuidelines.map(source => source.id), caseEvidenceIds: ['synthetic-case-evidence-1'],
      }
      state = doctorRecommendationStateSchema.parse({
        caseId: detail.caseId, kind, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId,
        inputFingerprint: 'b'.repeat(64), generation: 1, stale: false,
        status: recommendationsMode && (kind === 'diagnosis' || kind === 'prescription') ? 'ready' : 'missing-evidence',
        items: !recommendationsMode ? [] : kind === 'diagnosis' ? diagnoses.slice(0, 2).map((concept, index) => ({
          ...common, id: `synthetic-recommendation-diagnosis-${index}`, kind, label: concept.display,
          catalogItemId: concept.id, role: index === 0 ? 'primary' : 'secondary', referenceConcept: diagnosisReference(concept),
          ...(index === 0 ? {} : { guidelineEvidenceIds: ['synthetic-guideline'], caseEvidenceIds: ['synthetic-case-evidence-2'] }),
        })) : kind === 'prescription' ? [{
          ...common, id: 'synthetic-recommendation-prescription', kind, label: medication.genericName,
          catalogItemId: medication.id, doseText: '5 mg', frequencyCode: 'QD', courseDays: null, quantity: null,
        }] : [],
        guidelines: recommendationGuidelines,
        caseEvidence: [
          { id: 'synthetic-case-evidence-1', kind: 'presentation', label: '合成病例来源一', text: '合成病例第一条依据：仅验证来源展开与页面接线。' },
          { id: 'synthetic-case-evidence-2', kind: 'presentation', label: '合成病例来源二', text: '合成病例第二条依据：需要医生继续核实。' },
        ], missingInformation: [],
      })
      recommendationStates.set(kind, state)
    }
    if (recommendation[2] !== undefined) {
      generateDoctorRecommendationsRequestSchema.parse(JSON.parse(String(init?.body)))
      state = { ...state, generation: state.generation + 1 }
      if (kind === 'diagnosis' && updateRecommendationEvidence) {
        updateRecommendationEvidence = false
        state = { ...state, inputFingerprint: 'c'.repeat(64), caseEvidence: state.caseEvidence.map(source => source.id === 'synthetic-case-evidence-2'
          ? { ...source, text: '合成新报告已发布，需重新核对之前移除的第二诊断。' } : source) }
      }
      recommendationStates.set(kind, state)
      return command(state)
    }
    return Response.json(state)
  }
  if (path.endsWith('/completion')) return Response.json({
    canComplete: false, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId, items: [],
  })
  if (path === '/api/his/v1/reference-catalogs/diagnoses' || path === '/api/his/v1/reference-catalogs/medications') {
    const query = url.searchParams.get('query') ?? ''
    const directory = path.endsWith('/diagnoses') ? diagnoses : products
    const items = directory.filter(item => ('display' in item ? item.display : `${item.genericName} ${item.manufacturer}`).includes(query))
    return Response.json({ items, page: 1, pageSize: 20, total: items.length, releaseId: 'synthetic-release' })
  }
  if (path.endsWith('/diagnosis/draft')) {
    const saved = saveDiagnosisDraftRequestSchema.parse(JSON.parse(String(init?.body))).input
    const draftVersion = (detail.diagnosis?.draftVersion ?? 0) + 1
    detail.diagnosis = { ...detail.diagnosis, draftVersion, draft: { entries: saved.entries.map(entry => ({
      ...entry, referenceConcept: diagnosisReference(diagnoses.find(item => item.id === entry.catalogItemId)!),
    })) } }
    return command({ draftVersion })
  }
  if (path.endsWith('/diagnosis/actions/confirm')) {
    confirmDiagnosisRequestSchema.parse(JSON.parse(String(init?.body)))
    const confirmation = confirm(detail.diagnosis!.draft!.entries, (detail.diagnosis!.confirmation?.revisionNumber ?? 0) + 1)
    const diagnosisVersion = detail.diagnosis!.draftVersion + 1
    detail.diagnosis = { confirmation, draftVersion: diagnosisVersion }
    return command({ confirmation, diagnosisVersion, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId })
  }
  if (path.endsWith('/prescription/draft') && init?.method === 'PUT') {
    const saved = savePrescriptionDraftRequestSchema.parse(JSON.parse(String(init.body))).input
    const draftVersion = (detail.medicationConclusion?.draftVersion ?? 0) + 1
    detail.medicationConclusion = { draftVersion, draft: { items: saved.items.map(item => ({ ...item,
      ...(recommendationsMode ? {} : { referenceProduct: products.find(product => product.id === item.catalogItemId)! }),
    })) } }
    return command({ draftVersion })
  }
  if (path.endsWith('/prescription/actions/issue')) {
    issuePrescriptionRequestSchema.parse(JSON.parse(String(init?.body)))
    const prescription = issue(detail.medicationConclusion!.draft!.items)
    const draftVersion = detail.medicationConclusion!.draftVersion + 1
    detail.medicationConclusion = { draftVersion, prescription }
    return command({ draftVersion, prescription })
  }
  errors.push(`Unexpected browser fixture request: ${init?.method ?? 'GET'} ${path}`)
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Unexpected browser fixture request' } }, { status: 404 })
}
Object.defineProperty(window, 'fetch', { configurable: true, value: fixtureFetch })
const host = document.createElement('div')
host.id = 'diagnosis-prescription-host'
host.style.cssText = 'width:1280px;height:900px;container-type:inline-size;container-name:dsh-react-surface-content;contain:strict'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
const styles = document.createElement('style')
styles.textContent = document.querySelector('style[data-fixture]')?.textContent ?? ''
const container = document.createElement('div')
container.style.cssText = 'height:100%;min-width:0'
shadow.append(styles, container)
const root = createRoot(container)
const history = createMemoryHistory({ initialEntries: ['/consultation'] })
const appearanceSchema = z.object({ locale: z.enum(['zh-CN', 'en-US']), theme: z.enum(['light', 'dark']),
  fontSize: z.enum(['standard', 'larger', 'large']) })
function render(appearance: z.infer<typeof appearanceSchema>) {
  flushSync(() => root.render(<WebApp history={history} runtime={{
    mode: 'surface', surfaceLocale: appearance.locale, surfaceColorScheme: appearance.theme,
    surfaceFontSize: appearance.fontSize,
  }} />))
}
window.addEventListener('diagnosis-prescription-appearance', event => {
  if (event instanceof CustomEvent) render(appearanceSchema.parse(event.detail))
})
window.addEventListener('diagnosis-prescription-errors', () => {
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ errors }))))
})
render({ locale: 'zh-CN', theme: 'light', fontSize: 'standard' })
document.title = btoa(JSON.stringify({ ready: true }))
