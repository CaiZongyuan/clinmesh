import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createMemoryHistory } from '@tanstack/react-router'
import { z } from 'zod'
import {
  issueLaboratoryRequestRequestSchema,
  issueImagingRequestRequestSchema,
  issuePathologyRequestRequestSchema,
  saveImagingRequestDraftRequestSchema,
  savePathologyRequestDraftRequestSchema,
  saveLaboratoryRequestDraftRequestSchema,
  type DoctorCaseDetail,
  type ImagingRequest,
  type ImagingServiceSnapshot,
  type PathologyRequest,
  type PathologyServiceSnapshot,
  type LaboratoryReport,
  type LaboratoryRequest,
  type LaboratoryServiceSnapshot,
  type SessionContext,
} from '@clinmesh/contracts/his'
import {
  doctorRecommendationKindSchema, doctorRecommendationStateSchema, generateDoctorRecommendationsRequestSchema,
  type DoctorRecommendationState, type DoctorRecommendationSuggestion,
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
const recommendationsMode = document.documentElement.dataset.fixtureMode === 'recommendations'
const imagingService: ImagingServiceSnapshot = {
  applicability: '成人胸部疾病的评估与随访；不含增强扫描', bodySite: '胸部', code: 'CT-CHEST-PLAIN',
  department: '放射科', examCode: 'chest-ct-plain', id: 'imaging-chest-ct-plain',
  method: '平扫（不使用造影剂）', modality: 'CT', name: '胸部 CT 平扫',
  reportSections: ['technique', 'findings', 'impression'], version: 1,
}
const pathologyService: PathologyServiceSnapshot = {
  applicability: '既往乳腺手术切除标本切片的会诊复核', bodySite: '乳腺', code: 'PATH-BREAST-SLIDE-CONSULT',
  department: '病理科', examCode: 'breast-slide-consultation', id: 'pathology-breast-slide-consultation',
  name: '乳腺切片病理会诊', reportSections: ['specimen', 'microscopy', 'diagnosis', 'immunohistochemistry', 'note'],
  specimenType: '既往手术切除标本的石蜡切片', stain: 'HE', version: 1,
}
const sourceProcedures = [
  { code: '392021009', display: '乳房肿块切除术', performedAt: '2022-04-01T08:00:00+08:00', sourceReference: 'urn:uuid:procedure-0' },
  { code: '392023007', display: '乳腺病灶切除术', performedAt: '2023-01-05T08:00:00+08:00', sourceReference: 'urn:uuid:procedure-1' },
]

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
const recommendationStates = new Map<string, DoctorRecommendationState>()
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
  const recommendation = /^\/api\/his\/v1\/doctor\/cases\/synthetic-case\/recommendations\/([^/]+)(\/actions\/generate)?$/.exec(path)
  if (recommendation !== null) {
    const kind = doctorRecommendationKindSchema.parse(recommendation[1])
    let current = recommendationStates.get(kind)
    if (current === undefined) {
      const common = {
        id: `synthetic-${kind}-recommendation`,
        rationale: '合成检查建议，长中文用于验证来源展开、可编辑草稿与人工正式开立。'.repeat(4),
        supportingInformation: ['合成病例支持信息。'], opposingInformation: [], missingInformation: ['仍须医生核实。'],
        guidelineEvidenceIds: ['synthetic-investigation-guideline'], caseEvidenceIds: ['synthetic-investigation-case-evidence'],
      }
      const items: DoctorRecommendationSuggestion[] = []
      if (recommendationsMode && kind === 'laboratory') items.push({
        ...common, kind, label: service.nameZh, catalogItemId: service.id, indicationCode: 'clinical-evaluation',
      })
      if (recommendationsMode && kind === 'imaging') items.push({
        ...common, kind, label: imagingService.name, serviceId: imagingService.id, indication: '合成建议检查指征，需医生核对。',
      })
      if (recommendationsMode && kind === 'pathology') items.push({
        ...common, kind, label: pathologyService.name, serviceId: pathologyService.id,
        sourceProcedureReference: 'urn:uuid:procedure-1', purpose: '合成建议复核既往手术切片，需医生核对。',
      })
      current = doctorRecommendationStateSchema.parse({
        caseId: detail.caseId, kind, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId,
        inputFingerprint: 'a'.repeat(64), generation: 1, stale: false,
        status: items.length > 0 ? 'ready' : 'missing-evidence', items,
        guidelines: [{ id: 'synthetic-investigation-guideline', documentType: 'official-protocol', title: '合成检查建议来源',
          publisher: '合成发布机构', version: '1', scope: '仅验证浏览器，不作为临床依据。', locator: '合成条款 1',
          url: 'https://example.test/investigation-guideline', sourceHash: 'b'.repeat(64),
          text: '合成来源条款：长中文仅验证检查建议引用、医生草稿与正式开立入口。',
        }],
        caseEvidence: [{ id: 'synthetic-investigation-case-evidence', kind: 'history', label: '合成病例来源',
          text: '合成病例依据：来源与当前病例绑定，不代表已开立检查。',
        }], missingInformation: [],
      })
      recommendationStates.set(kind, current)
    }
    if (recommendation[2] !== undefined) {
      generateDoctorRecommendationsRequestSchema.parse(JSON.parse(String(init?.body)))
      current = { ...current, generation: current.generation + 1 }
      recommendationStates.set(kind, current)
      return command(current)
    }
    return Response.json(current)
  }
  if (path.endsWith('/completion')) return Response.json({
    canComplete: false, encounterId: detail.encounter.id, encounterVersion: '1', items: [],
  })
  if (path.endsWith('/reference-catalogs/laboratory')) {
    const query = url.searchParams.get('query') ?? ''
    const items = directory.filter(item => `${item.nameZh} ${item.nameEn}`.includes(query))
    const page = Number(url.searchParams.get('page') ?? '1')
    return Response.json({ items: items.slice((page - 1) * 20, page * 20), page, pageSize: 20, total: items.length })
  }
  if (path.endsWith('/imaging-services')) return Response.json({ items: recommendationsMode ? [{ available: true, service: imagingService }] : [] })
  if (path.endsWith('/pathology-services')) return Response.json({ items: recommendationsMode ? [{ available: true, service: pathologyService, sourceProcedures }] : [] })
  if (path.endsWith('/laboratory-request/draft') && init?.method === 'PUT') {
    const saved = saveLaboratoryRequestDraftRequestSchema.parse(JSON.parse(String(init.body))).input
    const selectedService = [service, secondService].find(item => item.id === saved.catalogItemId)
    if (selectedService === undefined) throw new Error('Unknown synthetic service')
    state.draft = { catalogItemId: selectedService.id, indicationCode: saved.indicationCode, laboratoryService: selectedService }
    state.draftVersion += 1
    return command({ caseId: detail.caseId, draftVersion: state.draftVersion })
  }
  if (path.endsWith('/laboratory-request/actions/issue')) {
    issueLaboratoryRequestRequestSchema.parse(JSON.parse(String(init?.body)))
    const selectedService = state.draft?.laboratoryService
    if (selectedService === undefined) throw new Error('Missing synthetic draft')
    const issued = request(`${recommendationsMode ? 'laboratory' : 'issued'}-${state.requests.length + 1}`, selectedService, false)
    state.requests = [issued, ...state.requests]
    state.draftVersion += 1
    delete state.draft
    return command({ caseId: detail.caseId, draftVersion: state.draftVersion, request: issued })
  }
  if (path.endsWith('/imaging-request/draft') && init?.method === 'PUT') {
    const saved = saveImagingRequestDraftRequestSchema.parse(JSON.parse(String(init.body))).input
    const imagingState = detail.imagingRequests!
    if (saved.serviceId !== imagingService.id) throw new Error('Unknown synthetic imaging service')
    imagingState.draft = { indication: saved.indication, service: imagingService }
    imagingState.draftVersion += 1
    return command({ caseId: detail.caseId, draftVersion: imagingState.draftVersion })
  }
  if (path.endsWith('/imaging-request/actions/issue')) {
    issueImagingRequestRequestSchema.parse(JSON.parse(String(init?.body)))
    const imagingState = detail.imagingRequests!
    if (imagingState.draft === undefined) throw new Error('Missing synthetic imaging draft')
    const issued: ImagingRequest = {
      ...imagingState.draft, id: 'imaging-1', serviceRequestId: 'service-request-imaging-1', serviceRequestVersion: '1',
      previousReports: [], status: 'issued', taskId: 'task-imaging-1', taskVersion: '1', version: 1,
    }
    imagingState.requests = [issued, ...imagingState.requests]
    imagingState.draftVersion += 1
    delete imagingState.draft
    return command({ caseId: detail.caseId, draftVersion: imagingState.draftVersion, request: issued })
  }
  if (path.endsWith('/pathology-request/draft') && init?.method === 'PUT') {
    const saved = savePathologyRequestDraftRequestSchema.parse(JSON.parse(String(init.body))).input
    const pathologyState = detail.pathologyRequests!
    const sourceProcedure = sourceProcedures.find(item => item.sourceReference === saved.sourceProcedureReference)
    if (saved.serviceId !== pathologyService.id || sourceProcedure === undefined) throw new Error('Unknown synthetic pathology service or procedure')
    pathologyState.draft = { purpose: saved.purpose, service: pathologyService, sourceProcedure }
    pathologyState.draftVersion += 1
    return command({ caseId: detail.caseId, draftVersion: pathologyState.draftVersion })
  }
  if (path.endsWith('/pathology-request/actions/issue')) {
    issuePathologyRequestRequestSchema.parse(JSON.parse(String(init?.body)))
    const pathologyState = detail.pathologyRequests!
    if (pathologyState.draft === undefined) throw new Error('Missing synthetic pathology draft')
    const issued: PathologyRequest = {
      ...pathologyState.draft, id: 'pathology-1', serviceRequestId: 'service-request-pathology-1', serviceRequestVersion: '1',
      previousReports: [], status: 'issued', taskId: 'task-pathology-1', taskVersion: '1', version: 1,
    }
    pathologyState.requests = [issued, ...pathologyState.requests]
    pathologyState.draftVersion += 1
    delete pathologyState.draft
    return command({ caseId: detail.caseId, draftVersion: pathologyState.draftVersion, request: issued })
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
