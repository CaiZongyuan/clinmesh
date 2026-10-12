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
// 只替换网络边界；本合同不证明 Server Command、授权或审计。
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'http://synthetic.test')
  const path = url.pathname
  if (path === '/api/auth/context') return Response.json(session)
  if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [], medications: [], prescriptionConclusionSupported: true })
  if (path === '/api/his/v1/doctor/queue') return Response.json({
    items: [{ caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', patient: detail.patient,
      presentation: detail.presentation, status: detail.status, taskId: detail.taskId, taskVersion: '1' }],
    page: 1, pageSize: 20, total: 1,
  })
  if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(detail)
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
      referenceProduct: products.find(product => product.id === item.catalogItemId)!,
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
