import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createMemoryHistory } from '@tanstack/react-router'
import { z } from 'zod'
import {
  saveLaboratoryRequestDraftRequestSchema,
  type DoctorCaseDetail,
  type LaboratoryReport,
  type LaboratoryRequest,
  type LaboratoryServiceSnapshot,
  type SessionContext,
} from '@clinmesh/contracts/his'
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
const referenceConcept = {
  code: 'SYN-LAB', display: '合成检验项目', id: 'synthetic-reference', sourceLocator: 'synthetic:test',
  system: 'urn:synthetic:laboratory', version: '1',
}
const service: LaboratoryServiceSnapshot = {
  allowedIndicationCodes: ['clinical-evaluation'], componentServiceIds: [], doctorOrderable: true,
  executingDepartmentId: 'synthetic-laboratory', id: 'synthetic-lab', localCode: 'SYN-LAB',
  nameEn: 'Synthetic complete laboratory panel with extended indicator names',
  nameZh: '合成完整检验组合与扩展指标名称', priceFen: 2500, referenceConcept,
  referenceReleaseId: 'synthetic-release', reportDefinition: {
    conclusionTemplate: '合成检验结论', results: [{
      alternateCodings: [], referenceConcept, referenceRange: { low: 0, high: 10, text: '0–10' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, valueType: 'quantity',
    }],
  }, specimen: { code: 'blood', display: '合成静脉血标本' }, serviceKind: 'laboratory', tatMinutes: 180, version: 1,
}
const secondService: LaboratoryServiceSnapshot = { ...service, id: 'synthetic-lab-second',
  localCode: 'SYN-SECOND', nameZh: '合成第二检验项目', nameEn: 'Synthetic second laboratory test',
  referenceConcept: { ...referenceConcept, id: 'synthetic-second-reference', code: 'SYN-SECOND' } }
const directory = [service, secondService, ...Array.from({ length: 19 }, (_, index) => ({
  ...service, id: `synthetic-directory-${index + 1}`, localCode: `SYN-DIRECTORY-${index + 1}`,
  nameZh: `合成目录项目 ${index + 1}`, nameEn: `Synthetic catalog item ${index + 1}`,
}))]

function report(id: string, conclusion: string, long = false): LaboratoryReport {
  return {
    conclusion, diagnosticReportId: id, diagnosticReportVersion: '1', issuedAt: '2026-10-10T10:00:00+08:00',
    revisionNumber: 1, specimenId: `specimen-${id}`, status: 'final',
    results: Array.from({ length: long ? 36 : 1 }, (_, index) => ({
      code: `SYN-${index}`, display: `合成指标 ${index + 1} Synthetic laboratory indicator ${index + 1}`,
      interpretation: index === 0 ? 'high' : 'normal', observationId: `${id}-observation-${index}`,
      referenceRange: { low: 0, high: 10, text: '0–10 mg/L synthetic reference interval' },
      unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: index === 0 ? 12 : 5,
    })),
  }
}
function request(id: string, selectedService: LaboratoryServiceSnapshot, reported: boolean): LaboratoryRequest {
  return {
    catalogItemId: selectedService.id, id, indicationCode: 'clinical-evaluation', laboratoryService: selectedService,
    previousReports: reported ? [report(`historical-${id}`, `历史合成结论 ${id}`)] : [],
    ...(reported ? { report: report(`report-${id}`, `当前合成结论 ${id}`, id === 'first') } : {}),
    serviceRequestId: `service-request-${id}`, serviceRequestVersion: '1', status: reported ? 'reported' : 'issued',
    taskId: `task-${id}`, taskVersion: '1', version: 1,
  }
}
const detail: DoctorCaseDetail = {
  allergies: [], caseId: 'synthetic-case', consultation: { turns: [], version: 1 },
  encounter: { id: 'synthetic-encounter', status: 'in-progress', versionId: '1' },
  imagingRequests: { draftVersion: 0, requests: [] }, pathologyRequests: { draftVersion: 0, requests: [] },
  laboratoryRequests: {
    draftVersion: 0, reportingSupported: true, requests: document.documentElement.dataset.fixtureMode === 'existing'
      ? [request('first', service, true), request('second', secondService, true)] : [],
  },
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC-1', name: '合成浏览器患者', synthetic: true, versionId: '1' },
  presentation: { chiefComplaint: '合成主诉', summary: '合成浏览器合同', vitalSigns: {
    bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, oxygenSaturationPct: 98,
    pulseBpm: 80, respirationBpm: 18, temperatureC: 37,
  } }, priorFacts: [], status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
}
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const logError = console.error.bind(console)
console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); logError(...values) }
const command = (data: unknown) => Response.json({
  auditId: 'synthetic-audit', data, effects: [], requestId: 'synthetic-command', warnings: [],
})
// 只替换网络边界；本合同不证明 Server Command、授权或审计。
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'http://synthetic.test')
  const path = url.pathname
  const state = detail.laboratoryRequests!
  if (path === '/api/auth/context') return Response.json(session)
  if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [], medications: [], prescriptionConclusionSupported: true })
  if (path === '/api/his/v1/doctor/queue') return Response.json({
    items: [{ caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', patient: detail.patient,
      presentation: detail.presentation, status: detail.status, taskId: detail.taskId, taskVersion: '1' }],
    page: 1, pageSize: 20, total: 1,
  })
  if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(detail)
  if (path.endsWith('/completion')) return Response.json({
    canComplete: false, encounterId: detail.encounter.id, encounterVersion: '1', items: [],
  })
  if (path.endsWith('/reference-catalogs/laboratory')) {
    const query = url.searchParams.get('query') ?? ''
    const items = directory.filter(item => `${item.nameZh} ${item.nameEn}`.includes(query))
    const page = Number(url.searchParams.get('page') ?? '1')
    return Response.json({ items: items.slice((page - 1) * 20, page * 20), page, pageSize: 20, total: items.length })
  }
  if (path.endsWith('/imaging-services')) return Response.json({ items: [] })
  if (path.endsWith('/pathology-services')) return Response.json({ items: [] })
  if (path.endsWith('/laboratory-request/draft') && init?.method === 'PUT') {
    const saved = saveLaboratoryRequestDraftRequestSchema.parse(JSON.parse(String(init.body))).input
    const selectedService = [service, secondService].find(item => item.id === saved.catalogItemId)
    if (selectedService === undefined) throw new Error('Unknown synthetic service')
    state.draft = { catalogItemId: selectedService.id, indicationCode: saved.indicationCode, laboratoryService: selectedService }
    state.draftVersion += 1
    return command({ caseId: detail.caseId, draftVersion: state.draftVersion })
  }
  if (path.endsWith('/laboratory-request/actions/issue')) {
    const selectedService = state.draft?.laboratoryService
    if (selectedService === undefined) throw new Error('Missing synthetic draft')
    const issued = request(`issued-${state.requests.length + 1}`, selectedService, false)
    state.requests = [issued, ...state.requests]
    state.draftVersion += 1
    delete state.draft
    return command({ caseId: detail.caseId, draftVersion: state.draftVersion, request: issued })
  }
  errors.push(`Unexpected browser fixture request: ${init?.method ?? 'GET'} ${path}`)
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Unexpected browser fixture request' } }, { status: 404 })
}
Object.defineProperty(window, 'fetch', { configurable: true, value: fixtureFetch })

const host = document.createElement('div')
host.id = 'investigation-host'
host.style.cssText = 'width:1280px;height:900px;container-type:inline-size;container-name:dsh-react-surface-content'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
const styles = document.createElement('style')
styles.textContent = document.querySelector('style[data-fixture]')?.textContent ?? ''
const container = document.createElement('div')
container.style.cssText = 'height:100%;min-width:0'
shadow.append(styles, container)
const root = createRoot(container)
const history = createMemoryHistory({ initialEntries: ['/consultation'] })
const appearanceSchema = z.object({
  locale: z.enum(['zh-CN', 'en-US']), theme: z.enum(['light', 'dark']),
  fontSize: z.enum(['standard', 'larger', 'large']),
})
function render(appearance: z.infer<typeof appearanceSchema>) {
  flushSync(() => root.render(<WebApp history={history} runtime={{
    mode: 'surface', surfaceLocale: appearance.locale, surfaceColorScheme: appearance.theme,
    surfaceFontSize: appearance.fontSize,
  }} />))
}
window.addEventListener('investigation-appearance', event => {
  if (event instanceof CustomEvent) render(appearanceSchema.parse(event.detail))
})
window.addEventListener('investigation-release-report', () => {
  for (const item of detail.laboratoryRequests!.requests) {
    if (item.status !== 'issued') continue
    item.status = 'reported'
    item.report = report(`report-${item.id}`, `当前合成结论 ${item.id}`, true)
    item.previousReports = [report(`historical-${item.id}`, `历史合成结论 ${item.id}`)]
  }
})
window.addEventListener('investigation-errors', () => {
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ errors }))))
})
render({ locale: 'zh-CN', theme: 'light', fontSize: 'standard' })
document.title = btoa(JSON.stringify({ ready: true }))
