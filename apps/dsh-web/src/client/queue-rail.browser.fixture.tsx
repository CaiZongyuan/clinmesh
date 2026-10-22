import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createMemoryHistory } from '@tanstack/react-router'
import { z } from 'zod'
import type { DoctorCaseDetail, SessionContext } from '@clinmesh/contracts/his'
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import { WebApp } from '../../../web/src/app/web-app.tsx'

function matchedEncounterId(path: string): string {
  const caseId = /encounters\/(encounter-[^/]+)\/completion$/.exec(path)?.[1]
  return caseId ?? cases[0]!.encounter.id
}

// 合同目标：surfaceDisplay.queuePresentation='rail'（DSH 镜像布局的队列回落形态）下，
// 队列不再渲染为左列，改为贴内容区左缘的收起把手；展开后完成患者列表切换。全部数据为合成数据。
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

function detail(caseId: string, patientId: string, identifier: string, name: string): DoctorCaseDetail {
  return {
    registrationNumber: null,
    allergies: [], caseId, consultation: { turns: [], version: 1 },
    consultationRecording: { hasSavedDraft: false, version: 1, paused: false, processedCount: 0,
      remainingCount: 0, failedCount: 0, status: 'idle', failures: [], additions: [] },
    encounter: { id: `encounter-${caseId}`, status: 'in-progress', versionId: '1' },
    imagingRequests: { draftVersion: 0, requests: [] }, pathologyRequests: { draftVersion: 0, requests: [] },
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
    patient: { id: patientId, identifier, name, synthetic: true, versionId: '1' },
    presentation: { chiefComplaint: '合成主诉', summary: '合成浏览器合同', vitalSigns: {
      bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, oxygenSaturationPct: 98,
      pulseBpm: 80, respirationBpm: 18, temperatureC: 37,
    } }, priorFacts: [], status: 'first-visit', taskId: `task-${caseId}`, taskVersion: '1',
  }
}
const cases = [
  detail('synthetic-case', 'synthetic-patient', 'SYNTHETIC-1', '合成浏览器患者'),
  detail('synthetic-case-second', 'synthetic-patient-second', 'SYNTHETIC-2', '合成第二病例患者'),
]
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const logError = console.error.bind(console)
console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); logError(...values) }

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
  if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [], medications: [], prescriptionConclusionSupported: true })
  if (path === '/api/his/v1/doctor/queue') return Response.json({
    items: cases.map(item => ({ registrationNumber: null, caseId: item.caseId, encounterId: item.encounter.id, encounterVersion: '1',
      patient: item.patient, presentation: item.presentation, status: item.status, taskId: item.taskId, taskVersion: '1' })),
    page: 1, pageSize: 20, total: cases.length,
  })
  const matchedCase = cases.find(item => path === `/api/his/v1/doctor/cases/${item.caseId}`)
  if (matchedCase !== undefined) return Response.json(matchedCase)
  if (path.endsWith('/completion')) return Response.json({
    canComplete: false, encounterId: matchedEncounterId(path), encounterVersion: '1', items: [],
  })
  const recommendationKind = /^\/api\/his\/v1\/doctor\/cases\/[^/]+\/recommendations\/(diagnosis|laboratory|imaging|pathology|prescription)$/.exec(path)
  if (recommendationKind !== null) {
    return Response.json(doctorRecommendationStateSchema.parse({
      caseId: cases[0]!.caseId, kind: recommendationKind[1], encounterId: cases[0]!.encounter.id,
      encounterVersion: '1', generation: 1, stale: false, status: 'missing-evidence', items: [], guidelines: [],
    }))
  }
  if (path.endsWith('/document-quality-control/actions/check')) {
    return Response.json({ error: { code: 'MODEL_UNAVAILABLE', message: '本合同不运行病历质控。' } }, { status: 503 })
  }
  errors.push(`Unexpected browser fixture request: ${init?.method ?? 'GET'} ${path}`)
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Unexpected browser fixture request' } }, { status: 404 })
}
Object.defineProperty(window, 'fetch', { configurable: true, value: fixtureFetch })

const host = document.createElement('div')
host.id = 'queue-rail-host'
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
    surfaceDisplay: { fullscreen: false, toggle: () => {}, queuePresentation: 'rail' },
  }} />))
}
window.addEventListener('queue-rail-appearance', event => {
  if (event instanceof CustomEvent) render(appearanceSchema.parse(event.detail))
})
window.addEventListener('queue-rail-errors', () => {
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ errors }))))
})
render({ locale: 'zh-CN', theme: 'light', fontSize: 'standard' })
document.title = btoa(JSON.stringify({ ready: true }))
