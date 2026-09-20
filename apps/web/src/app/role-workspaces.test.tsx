// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type {
  DiagnosisDraftEntry,
  DiagnosisState,
  DoctorCaseDetail,
  DoctorCompletedCaseDetail,
  DoctorCompletedCaseList,
  LaboratoryRequest,
  SessionContext,
} from '@clinmesh/contracts/his'
import type {
  ScenarioGenerationRequest,
  SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import { agentToolsForContext } from '@clinmesh/contracts/agent'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DoctorWorkspace } from './doctor-workspace.tsx'
import { useSyntheticPatientLibraryViewStore } from './synthetic-patient-library-view-store.ts'
import { WebApp } from './web-app.tsx'
import { agentActionTarget } from './agent-action-targets.ts'
import type { WebSurfaceAgentController, WebSurfaceAgentTool } from './web-runtime.tsx'

const forbiddenChineseClinicalUiTerms = /Agent|评分|仿真|Scenario|Epoch/i
const forbiddenEnglishClinicalUiTerms = /Agent|scor(?:e|ing)|simulation|Scenario|Epoch/i
const translationWarning = {
  code: 'TRANSLATION_GAP' as const,
  gapCount: 1,
  gaps: [{
    code: 'missing-code',
    path: 'code.coding[0]',
    resourceId: 'observation-1',
    resourceType: 'Observation',
    sourceDisplay: 'Untranslated display',
    system: 'http://loinc.org',
    version: null,
  }],
  message: 'The Synthea Bundle contains untranslated clinical displays' as const,
  truncated: false,
}

const doctorTriage = {
  acuityCode: 'level-3',
  bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
  chiefComplaint: '发热伴咽痛两天',
  oxygenSaturationPct: 98,
  pulseBpm: 102,
  respirationBpm: 20,
  temperatureC: 38.2,
}

const doctorPresentation = {
  chiefComplaint: '发热伴咽痛两天',
  summary: '发热伴咽痛两天',
  vitalSigns: {
    bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
    oxygenSaturationPct: 98,
    pulseBpm: 102,
    respirationBpm: 20,
    temperatureC: 38.2,
  },
}

const structuredClinicalDocument = {
  assessment: '考虑急性上呼吸道感染，暂未见重症征象。',
  auxiliaryExamination: '甲型流感抗原阳性，血常规未见危急值。',
  chiefComplaint: '发热伴咽痛两天。',
  disposition: '门诊随诊，完善检验后复评。',
  followUp: '持续高热或呼吸困难时立即复诊。',
  historyOfPresentIllness: '患者两天前出现发热和咽痛，最高体温 38.7 °C。',
  physicalExamination: '咽部充血，双肺呼吸音清，未闻及干湿啰音。',
  priorMedicalHistory: '既往体健，无重大慢性病史。',
}

const revisedStructuredClinicalDocument = {
  assessment: '检验支持甲型流感，当前生命体征稳定。',
  auxiliaryExamination: '甲型流感抗原阳性，复核血常规无危急值。',
  chiefComplaint: '发热伴咽痛两天。',
  disposition: '门诊抗病毒及对症治疗。',
  followUp: '三日内门诊复查；呼吸困难时立即就诊。',
  historyOfPresentIllness: '患者两天前出现发热和咽痛，甲型流感抗原阳性。',
  physicalExamination: '咽部充血，双肺呼吸音清，血氧饱和度 98%。',
  priorMedicalHistory: '既往体健，无重大慢性病史。',
}

const virtualPatientPresentation = {
  chiefComplaint: '发热、咽痛 1 天。',
  summary: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛。',
  vitalSigns: {
    bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
    oxygenSaturationPct: 98,
    pulseBpm: 96,
    respirationBpm: 20,
    temperatureC: 38.6,
  },
}

const administratorSession = {
  actor: {
    actorId: 'actor-administrator',
    epoch: 'epoch-1',
    locationId: 'location-administrator',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerRoleId: 'practitioner-role-administrator',
    roleCode: 'administrator',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'administrator',
    id: 'practitioner-role-administrator',
    locationId: 'location-administrator',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerName: '合成管理员',
  }, {
    code: 'registrar',
    id: 'practitioner-role-registrar',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerName: '合成挂号员',
  }],
  user: {
    email: 'admin@demo.clinmesh.local',
    id: 'user-administrator',
    name: '合成管理员',
  },
}

const registrarSession = {
  actor: {
    actorId: 'actor-registrar',
    epoch: 'epoch-1',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerRoleId: 'practitioner-role-registrar',
    roleCode: 'registrar',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'registrar',
    id: 'practitioner-role-registrar',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerName: '合成挂号员',
  }],
  user: {
    email: 'registrar@demo.clinmesh.local',
    id: 'user-registrar',
    name: '合成挂号员',
  },
}

const triageNurseSession = {
  actor: {
    actorId: 'actor-triage-nurse',
    epoch: 'epoch-1',
    locationId: 'location-triage',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-triage-nurse',
    practitionerRoleId: 'practitioner-role-triage-nurse',
    roleCode: 'triage-nurse',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'triage-nurse',
    id: 'practitioner-role-triage-nurse',
    locationId: 'location-triage',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-triage-nurse',
    practitionerName: '合成分诊护士',
  }],
  user: {
    email: 'triage@demo.clinmesh.local',
    id: 'user-triage-nurse',
    name: '合成分诊护士',
  },
}

const doctorSession: SessionContext = {
  actor: {
    actorId: 'actor-outpatient-doctor',
    epoch: 'epoch-1',
    locationId: 'location-clinic',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-outpatient-doctor',
    practitionerRoleId: 'practitioner-role-outpatient-doctor',
    roleCode: 'outpatient-doctor',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'outpatient-doctor',
    id: 'practitioner-role-outpatient-doctor',
    locationId: 'location-clinic',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-outpatient-doctor',
    practitionerName: '合成门诊医生',
  }],
  user: {
    email: 'doctor@demo.clinmesh.local',
    id: 'user-outpatient-doctor',
    name: '合成门诊医生',
  },
}

const administratorAsDoctorSession: SessionContext = {
  actor: {
    ...doctorSession.actor,
    actorId: 'actor-administrator',
    roleCode: 'outpatient-doctor',
  },
  availableRoles: [
    { ...administratorSession.availableRoles[0]!, code: 'administrator' },
    { ...doctorSession.availableRoles[0]!, code: 'outpatient-doctor' },
  ],
  user: administratorSession.user,
}

const cashierSession = {
  actor: {
    actorId: 'actor-cashier',
    epoch: 'epoch-1',
    locationId: 'location-cashier',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-cashier',
    practitionerRoleId: 'practitioner-role-cashier',
    roleCode: 'cashier',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'cashier',
    id: 'practitioner-role-cashier',
    locationId: 'location-cashier',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-cashier',
    practitionerName: '合成收费员',
  }],
  user: {
    email: 'cashier@demo.clinmesh.local',
    id: 'user-cashier',
    name: '合成收费员',
  },
}

const pharmacistSession = {
  actor: {
    actorId: 'actor-pharmacist',
    epoch: 'epoch-1',
    locationId: 'location-pharmacist',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-pharmacist',
    practitionerRoleId: 'practitioner-role-pharmacist',
    roleCode: 'pharmacist',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'pharmacist',
    id: 'practitioner-role-pharmacist',
    locationId: 'location-pharmacist',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-pharmacist',
    practitionerName: '合成药师',
  }],
  user: {
    email: 'pharmacist@demo.clinmesh.local',
    id: 'user-pharmacist',
    name: '合成药师',
  },
}

function commandResponse<Data>(data: Data) {
  return {
    auditId: 'audit-1',
    data,
    effects: [],
    requestId: 'request-1',
    warnings: [],
  }
}

function pagination(total: number) {
  return { page: 1, pageSize: 20, total }
}

function doctorSurfaceAgentResponse(
  path: string,
  init?: RequestInit,
): Response | undefined {
  if (path === '/api/agent/v1/page-contexts') {
    const request = JSON.parse(String(init?.body)) as {
      claim: Record<string, unknown>
      dshSessionId: string
    }
    const issuedAt = new Date()
    return Response.json({
      snapshot: {
        actor: {
          actorId: doctorSession.actor.actorId,
          practitionerRoleId: doctorSession.actor.practitionerRoleId,
          roleCode: doctorSession.actor.roleCode,
        },
        allowedOperationIds: agentToolsForContext('outpatient-doctor', 'consultation')
          .map(tool => tool.operationId),
        claim: request.claim,
        dshSessionId: request.dshSessionId,
        expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
        id: `context-${String(request.claim.viewRevision)}`,
        issuedAt: issuedAt.toISOString(),
        scopeKey: 'clinmesh:outpatient-doctor:consultation',
        version: 1,
        workspace: {
          epoch: doctorSession.actor.epoch,
          id: doctorSession.actor.workspaceId,
          scenarioRunId: doctorSession.actor.scenarioRunId,
        },
      },
      token: 'context-token-with-at-least-32-characters',
    }, { status: 201 })
  }
  if (path === '/clinmesh-agent-proof') {
    return Response.json({ data: { proof: 'proof-with-at-least-32-characters' } })
  }
  if (path === '/api/agent/v1/tool-calls') {
    const request = JSON.parse(String(init?.body)) as { operationId: string }
    return Response.json({
      callId: 'doctor-agent-call-1',
      context: {
        actor: {
          actorId: doctorSession.actor.actorId,
          practitionerRoleId: doctorSession.actor.practitionerRoleId,
          roleCode: doctorSession.actor.roleCode,
        },
        allowedOperationIds: [request.operationId],
        claim: {
          ui: { status: 'ready' },
          version: 1,
          viewId: 'consultation',
          viewRevision: 'authorized-doctor-agent-call',
        },
        dshSessionId: 'dsh-session-1',
        expiresAt: '2026-09-01T00:05:00.000Z',
        id: 'context-authorized-doctor-agent-call',
        issuedAt: '2026-09-01T00:00:00.000Z',
        scopeKey: 'clinmesh:outpatient-doctor:consultation',
        version: 1,
        workspace: {
          epoch: doctorSession.actor.epoch,
          id: doctorSession.actor.workspaceId,
          scenarioRunId: doctorSession.actor.scenarioRunId,
        },
      },
      dshSessionId: 'dsh-session-1',
      operationId: request.operationId,
      ...(request.operationId.endsWith('.propose') ? { proposalId: 'doctor-proposal-1' } : {}),
      receiptToken: 'receipt-token-with-at-least-32-characters',
      status: 'authorized',
    }, { status: 201 })
  }
  if (path === '/api/agent/v1/tool-calls/review') {
    const request = JSON.parse(String(init?.body)) as { decision: 'approved' | 'rejected' }
    return Response.json({
      decidedAt: '2026-09-01T00:00:01.000Z',
      decision: request.decision,
      proposalId: 'doctor-proposal-1',
    })
  }
  if (path === '/api/agent/v1/tool-calls/result') {
    return Response.json({ status: 'completed' })
  }
  return undefined
}

function boundAgentToolInput(
  tool: WebSurfaceAgentTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const parameters = tool.parameters as {
    properties?: Record<string, { const?: unknown }>
  }
  return {
    contextId: parameters.properties?.contextId?.const,
    scopeKey: parameters.properties?.scopeKey?.const,
    ...input,
  }
}

function createMediaQueryList(media: string): MediaQueryList {
  return {
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    matches: false,
    media,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }
}

function stubScenarioDataWorkspace(options: {
  briefJobFails?: boolean
  briefJobDelayMs?: number
  generationJobFails?: boolean
  generationJobDelayMs?: number
  onGenerate?: (request: ScenarioGenerationRequest) => void
  onCaseStart?: () => void
  onTruthRead?: () => void
  onReset?: (clearPatientLibrary: boolean) => void
  profileAvailable?: boolean
  profileUpdateConflict?: boolean
  providerModules?: string[]
  secondProfileAvailable?: boolean
  syntheaAvailable?: boolean
  translationWarning?: boolean
} = {}) {
  let generated = false
  let briefGenerated = false
  let caseStarted = false
  let briefJobReads = 0
  let jobReads = 0
  let profile: SyntheticPatientProfile = {
    createdAt: '2026-08-26T09:00:00+08:00',
    demographics: {
      birthDate: '1988-03-16',
      gender: 'female',
    },
    identity: {
      address: '江苏省苏州市张家港市合成路 123 号（合成地址）',
      displayName: '林晓',
      email: 'cmsyn001@example.test',
      insuranceDisplay: '模拟城镇职工医保',
      mrn: 'CMSYN000001',
      nationalId: '320582198803160028',
      phone: '13800001234',
    },
    profileId: 'synthetic-patient-profile-001',
    revision: 1,
    source: {
      batchId: 'synthea-batch-001',
      batchName: 'Synthea 中文患者批次',
      format: 'fhir-r4-bundle' as const,
      generation: {
        moduleMode: 'all',
        modules: [],
        ordinal: 0,
        seeds: { clinical: 20260824, population: 20260824 },
        timeRange: { end: '2026-08-24', start: '2025-08-24' },
        timeZone: 'Asia/Shanghai' as const,
      },
      hash: 'b'.repeat(64),
      patientId: 'synthea-patient-001',
      providerId: 'synthea' as const,
      raw: { entry: [], resourceType: 'Bundle', type: 'collection' },
      ...(options.translationWarning === true ? { translationWarning } : {}),
    },
    updatedAt: '2026-08-26T09:00:00+08:00',
    workspaceId: 'workspace-demo',
  }
  const caseId = 'synthetic-case-001'
  const secondCaseId = 'synthetic-case-002'
  const secondProfileId = 'synthetic-patient-profile-002'
  const publicProfile = () => ({
    birthDate: profile.demographics.birthDate,
    case: {
      activeBriefRevision: briefGenerated ? 1 : null,
      caseId,
      caseType: 'new-problem' as const,
      createdAt: profile.createdAt,
      profileId: profile.profileId,
      profileRevision: 1,
      revision: caseStarted ? 3 : briefGenerated ? 2 : 1,
      sourceHash: profile.source.hash,
      status: caseStarted ? 'started' as const : briefGenerated ? 'brief-ready' as const : 'brief-pending' as const,
      updatedAt: profile.updatedAt,
      visibleHistoryCount: 2,
      workspaceId: profile.workspaceId,
    },
    createdAt: profile.createdAt,
    gender: profile.demographics.gender,
    identity: profile.identity,
    profileId: profile.profileId,
    revision: profile.revision,
    source: {
      batchId: profile.source.batchId,
      batchName: profile.source.batchName,
      format: profile.source.format,
      hash: profile.source.hash,
      ...(profile.source.translationWarning === undefined
        ? {}
        : { translationWarning: profile.source.translationWarning }),
      patientId: profile.source.patientId,
      providerId: profile.source.providerId,
    },
    updatedAt: profile.updatedAt,
    workspaceId: profile.workspaceId,
  })
  const secondPublicProfile = () => {
    const first = publicProfile()
    return {
      ...first,
      case: {
        ...first.case,
        caseId: secondCaseId,
        profileId: secondProfileId,
      },
      identity: {
        ...first.identity,
        displayName: '第二位合成患者',
        mrn: 'CMSYN000002',
      },
      profileId: secondProfileId,
    }
  }
  generated = options.profileAvailable === true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(administratorSession)
    if (url.pathname === '/api/sim/v1/scenario-runs/current') {
      return Response.json({
        clinicalReview: null,
        epoch: 'epoch-1',
        initialStateHash: '0123456789abcdef',
        kind: 'candidate',
        scenarioId: 'candidate-fever-outpatient-v1',
        scenarioRunId: 'scenario-run-1',
        seed: 20260824,
        status: 'active',
        virtualTime: '2026-08-24T09:00:00+08:00',
        workspaceId: 'workspace-demo',
      })
    }
    if (url.pathname === '/api/sim/v1/scenario-providers') {
      return Response.json({
        items: [{
          available: options.syntheaAvailable === true,
          maxPopulation: 10,
          modules: options.providerModules ?? ['cardiovascular/hypertension', 'metabolic/diabetes'],
          providerId: 'synthea',
          providerName: 'Synthea',
          ...(options.syntheaAvailable === true
            ? {}
            : { unavailableReason: '未配置 Synthea Provider' }),
        }],
      })
    }
    if (url.pathname === '/api/sim/v1/synthetic-patients') {
      const firstSummary = {
        activeVisit: false,
        batchId: profile.source.batchId,
        batchName: profile.source.batchName,
        birthDate: profile.demographics.birthDate,
        createdAt: profile.createdAt,
        gender: profile.demographics.gender,
        historyCount: 2,
        mrn: profile.identity.mrn,
        name: profile.identity.displayName,
        profileId: profile.profileId,
        providerId: 'synthea',
        revision: profile.revision,
        updatedAt: profile.updatedAt,
      }
      const summaries = [firstSummary]
      if (options.secondProfileAvailable === true) {
        summaries.push({
          ...firstSummary,
          mrn: 'CMSYN000002',
          name: '第二位合成患者',
          profileId: secondProfileId,
        })
      }
      return Response.json({
        items: generated ? summaries : [],
        page: 1,
        pageSize: 20,
        total: generated ? summaries.length : 0,
      })
    }
    if (url.pathname === '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset') {
      const body = JSON.parse(String(init?.body))
      options.onReset?.(body.clearPatientLibrary === true)
      if (body.clearPatientLibrary === true) generated = false
      return Response.json(commandResponse({
        clinicalReview: null, epoch: 'epoch-2', initialStateHash: '0123456789abcdef',
        kind: 'candidate', scenarioId: 'candidate-fever-outpatient-v1', scenarioRunId: 'scenario-run-2',
        seed: 20260824, status: 'active', virtualTime: '2026-08-24T09:00:00+08:00', workspaceId: 'workspace-demo',
      }))
    }
    if (url.pathname === `/api/sim/v1/admin/synthetic-cases/${caseId}/truth`) {
      options.onTruthRead?.()
      return Response.json({
        caseId,
        indexEncounterReference: 'urn:uuid:index-encounter',
        items: [{ sourceReference: 'urn:uuid:index-condition', resource: {
          id: 'index-condition', resourceType: 'Condition', code: { text: '本次合成疾病' },
          encounter: { reference: 'Encounter/index-encounter' },
        } }, { sourceReference: 'urn:uuid:index-observation', resource: {
          id: 'index-observation', resourceType: 'Observation', code: { text: '本次收缩压' },
          valueQuantity: { value: 162, unit: 'mmHg' },
        } }, { sourceReference: 'urn:uuid:index-encounter', resource: {
          id: 'index-encounter', resourceType: 'Encounter',
        } }, { sourceReference: 'urn:uuid:older-condition', resource: {
          id: 'older-condition', resourceType: 'Condition', code: { text: '关联的既往疾病' },
          encounter: { reference: 'Encounter/older-encounter' },
        } }],
      })
    }
    if (url.pathname === `/api/sim/v1/synthetic-cases/${caseId}/history/detail`) {
      const sourceReference = url.searchParams.get('sourceReference')
      if (sourceReference !== 'urn:uuid:prior-condition') {
        return Response.json({ error: { code: 'CASE_NOT_FOUND', message: 'Not found' } }, { status: 404 })
      }
      return Response.json({
        caseId,
        resource: {
          code: { coding: [{ code: '386661006', display: '发热', system: 'http://snomed.info/sct' }] },
          id: 'prior-condition',
          resourceType: 'Condition',
        },
        sourceKind: 'synthea-r4-external',
        sourceReference,
      })
    }
    if (url.pathname === `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-jobs`) {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({})
      return Response.json(commandResponse({
        caseId,
        createdAt: '2026-08-30T08:00:00+08:00',
        error: null,
        finishedAt: null,
        jobId: 'patient-brief-job-001',
        resultRevision: null,
        startedAt: null,
        status: 'queued',
        updatedAt: '2026-08-30T08:00:00+08:00',
        workspaceId: 'workspace-demo',
      }))
    }
    if (url.pathname === '/api/sim/v1/patient-persona-jobs/patient-brief-job-001') {
      await new Promise(resolve => setTimeout(resolve, options.briefJobDelayMs ?? 0))
      briefJobReads += 1
      const failed = options.briefJobFails === true
      const succeeded = !failed && briefJobReads > 1
      if (succeeded) briefGenerated = true
      return Response.json({
        caseId,
        createdAt: '2026-08-30T08:00:00+08:00',
        error: failed ? { code: 'BRIEF_GENERATION_FAILED', message: '患者档案服务暂时不可用' } : null,
        finishedAt: failed || succeeded ? '2026-08-30T08:00:01+08:00' : null,
        jobId: 'patient-brief-job-001',
        resultRevision: succeeded ? 1 : null,
        startedAt: '2026-08-30T08:00:00+08:00',
        status: failed ? 'failed' : succeeded ? 'succeeded' : 'running',
        updatedAt: failed || succeeded ? '2026-08-30T08:00:01+08:00' : '2026-08-30T08:00:00+08:00',
        workspaceId: 'workspace-demo',
      })
    }
    if (url.pathname === `/api/sim/v1/synthetic-cases/${caseId}/patient-persona-revisions`) {
      return Response.json({
        activeRevision: briefGenerated ? 1 : null,
        items: briefGenerated ? [{
          caseId,
          content: {
            chiefComplaint: '反复头晕一周',
            knownHistorySummary: '既往有高血压病史。',
            openingStatement: '医生您好，我最近总是头晕。',
            symptomTopics: [{
              answerPoints: ['一周前开始。'],
              id: 'dizziness-onset',
              name: '头晕经过',
            }],
          },
          createdAt: '2026-08-30T08:00:01+08:00',
          inputHash: 'a'.repeat(64),
          model: 'fake-brief-model',
          outputHash: 'b'.repeat(64),
          promptHash: 'c'.repeat(64),
          promptVersion: 'patient-persona-v1',
          revision: 1,
          workspaceId: 'workspace-demo',
        }] : [],
      })
    }
    if (url.pathname === `/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`) {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        activeBriefRevision: 1,
        departmentId: 'department-general-medicine',
        expectedCaseRevision: 2,
        locationId: 'location-outpatient',
        visitDate: '2026-08-24',
        visitTypeId: 'visit-type-general',
      })
      caseStarted = true
      options.onCaseStart?.()
      return Response.json(commandResponse({
        encounterId: 'encounter-case-001',
        outpatientCaseId: 'outpatient-case-001',
        patientId: 'patient-case-001',
        queueTaskId: 'task-case-001',
        registrationId: 'registration-case-001',
        status: 'awaiting-triage',
        syntheticCaseId: caseId,
      }))
    }
    if (
      url.pathname === `/api/sim/v1/synthetic-cases/${caseId}/history`
      || url.pathname === `/api/sim/v1/synthetic-cases/${secondCaseId}/history`
    ) {
      return Response.json({
        items: [{
          businessDate: '2026-07-01',
          items: [{
            clinicalDate: '2026-07-01T08:00:00+08:00',
            resourceType: 'Condition',
            sourceReference: 'urn:uuid:prior-condition',
            title: '发热',
          }, {
            clinicalDate: '2026-07-01T08:10:00+08:00',
            resourceType: 'Observation',
            sourceReference: 'urn:uuid:prior-observation',
            title: '体温',
          }],
        }],
        page: 1,
        pageSize: 20,
        total: 1,
      })
    }
    if (url.pathname === `/api/sim/v1/synthetic-patients/${profile.profileId}` && init?.method === 'PUT') {
      if (options.profileUpdateConflict === true) {
        return Response.json({
          error: {
            code: 'PROFILE_VERSION_CONFLICT',
            message: '该合成患者档案已被其他管理员修改。',
          },
        }, { status: 409 })
      }
      const body = JSON.parse(String(init.body)) as { expectedRevision: number; input: typeof profile.identity }
      profile = { ...profile, identity: body.input, revision: body.expectedRevision + 1 }
      return Response.json(commandResponse(publicProfile()))
    }
    if (url.pathname === `/api/sim/v1/synthetic-patients/${profile.profileId}`) {
      return Response.json(publicProfile())
    }
    if (url.pathname === `/api/sim/v1/synthetic-patients/${secondProfileId}`) {
      return Response.json(secondPublicProfile())
    }
    if (url.pathname === '/api/his/v1/catalogs/registration') {
      return Response.json({
        departments: [{ id: 'department-general-medicine', nameEn: 'General Medicine', nameZh: '全科医学科', version: 1 }],
        locations: [{ id: 'location-outpatient', nameEn: 'Outpatient', nameZh: '门诊一层', version: 1 }],
        virtualDate: '2026-08-24',
        visitTypes: [{ id: 'visit-type-general', nameEn: 'General', nameZh: '普通门诊', priceFen: 1000, version: 1 }],
      })
    }
    if (url.pathname === '/api/sim/v1/scenario-generation-jobs' && init?.method === 'POST') {
      options.onGenerate?.(JSON.parse(String(init.body)) as ScenarioGenerationRequest)
      return Response.json(commandResponse({
        caseIds: [],
        createdAt: '2026-08-26T09:00:00+08:00',
        error: null,
        finishedAt: null,
        jobId: 'scenario-generation-job-001',
        profileIds: [],
        request: {
          modules: ['fever'],
          name: '发热门诊样本',
          population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
          providerId: 'synthea',
          seeds: { clinical: 7331, population: 4242 },
          timeRange: { end: '2026-08-01', start: '2020-01-01' },
          timeZone: 'Asia/Shanghai',
        },
        startedAt: null,
        status: 'queued',
        updatedAt: '2026-08-26T09:00:00+08:00',
        workspaceId: 'workspace-demo',
      }))
    }
    if (url.pathname === '/api/sim/v1/scenario-generation-jobs/scenario-generation-job-001') {
      await new Promise(resolve => setTimeout(resolve, options.generationJobDelayMs ?? 0))
      jobReads += 1
      const failed = options.generationJobFails === true
      const succeeded = !failed && jobReads > 1
      if (succeeded) generated = true
      return Response.json({
        caseIds: succeeded ? [caseId] : [],
        createdAt: '2026-08-26T09:00:00+08:00',
        error: failed ? { code: 'PROVIDER_FAILED', message: 'Synthea 服务暂时不可用' } : null,
        finishedAt: failed || succeeded ? '2026-08-26T09:00:02+08:00' : null,
        jobId: 'scenario-generation-job-001',
        profileIds: succeeded ? [profile.profileId] : [],
        request: {
          modules: ['fever'],
          name: '发热门诊样本',
          population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
          providerId: 'synthea',
          seeds: { clinical: 7331, population: 4242 },
          timeRange: { end: '2026-08-01', start: '2020-01-01' },
          timeZone: 'Asia/Shanghai',
        },
        startedAt: '2026-08-26T09:00:01+08:00',
        status: failed ? 'failed' : succeeded ? 'succeeded' : 'running',
        updatedAt: failed || succeeded ? '2026-08-26T09:00:02+08:00' : '2026-08-26T09:00:01+08:00',
        workspaceId: 'workspace-demo',
      })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
}

function stubEmptyRegistrarWorkspace() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/auth/context') return Response.json(registrarSession)
    if (path === '/api/his/v1/catalogs/registration') {
      return Response.json({ departments: [], locations: [], virtualDate: '2026-08-24', visitTypes: [] })
    }
    if (path === '/api/his/v1/registration/synthetic-cases') {
      return Response.json({ items: [], ...pagination(0) })
    }
    if (path === '/api/his/v1/registrations') {
      return Response.json({ items: [], ...pagination(0) })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
}

function stubEmptyDoctorWorkspace() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/auth/context') return Response.json(doctorSession)
    if (path === '/api/his/v1/catalogs/clinical') {
      return Response.json({
        laboratory: [],
        medications: [],
        prescriptionConclusionSupported: true,
      })
    }
    if (path === '/api/his/v1/doctor/queue') {
      return Response.json({ items: [], ...pagination(0) })
    }
    if (path === '/api/agent/v1/page-contexts') {
      const request = JSON.parse(String(init?.body)) as {
        claim: Record<string, unknown>
        dshSessionId: string
      }
      const issuedAt = new Date()
      return Response.json({
        snapshot: {
          version: 1,
          id: 'context-doctor-empty',
          claim: request.claim,
          actor: {
            actorId: doctorSession.actor.actorId,
            practitionerRoleId: doctorSession.actor.practitionerRoleId,
            roleCode: doctorSession.actor.roleCode,
          },
          workspace: {
            id: doctorSession.actor.workspaceId,
            epoch: doctorSession.actor.epoch,
            scenarioRunId: doctorSession.actor.scenarioRunId,
          },
          allowedOperationIds: agentToolsForContext('outpatient-doctor', 'consultation')
            .map(tool => tool.operationId),
          dshSessionId: request.dshSessionId,
          scopeKey: 'clinmesh:doctor:consultation',
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
        },
        token: 'context-token-with-at-least-32-characters',
      }, { status: 201 })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
}

function stubLaboratoryReportPolling(reportingSupported: boolean) {
  let reportReady = false
  let detailRequests = 0
  const patient = {
    birthDate: '1988-03-16',
    gender: 'female',
    id: 'patient-virtual-1',
    identifier: 'CM-SYN-VP-001',
    name: '合成候选患者林晓',
    synthetic: true,
    versionId: '1',
  }
  const report = {
    conclusion: 'C 反应蛋白升高。',
    diagnosticReportId: 'diagnostic-report-crp-1',
    diagnosticReportVersion: '1',
    issuedAt: '2026-08-24T09:00:00+08:00',
    revisionNumber: 1,
    results: [{
      code: '1988-5',
      display: 'C 反应蛋白',
      interpretation: 'high',
      observationId: 'observation-crp-1',
      referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
      unit: {
        code: 'mg/L',
        display: 'mg/L',
        system: 'http://unitsofmeasure.org',
      },
      value: 18.6,
    }],
    specimenId: 'specimen-crp-1',
    status: 'final',
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
    if (url.pathname === '/api/his/v1/catalogs/clinical') {
      return Response.json({
        laboratory: [{
          allowedIndicationCodes: ['fever'],
          contraindicatedAllergyCodes: [],
          id: 'lab-crp',
          nameEn: 'C-reactive protein',
          nameZh: 'C 反应蛋白',
          priceFen: 4300,
          version: 1,
        }],
        medications: [],
        prescriptionConclusionSupported: true,
      })
    }
    if (url.pathname === '/api/his/v1/doctor/queue') {
      return Response.json({
        items: [{
          caseId: 'case-virtual-1',
          encounterId: 'encounter-virtual-1',
          encounterVersion: '1',
          patient,
          presentation: virtualPatientPresentation,
          status: 'first-visit',
          taskId: 'task-doctor-virtual-1',
          taskVersion: '1',
        }],
        ...pagination(1),
      })
    }
    if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-1') {
      detailRequests += 1
      return Response.json({
        allergies: [],
        caseId: 'case-virtual-1',
        consultation: { turns: [], version: 1 },
        encounter: { id: 'encounter-virtual-1', status: 'in-progress', versionId: '1' },
        laboratoryRequests: {
          draftVersion: 0,
          reportingSupported,
          requests: [{
            catalogItemId: 'lab-crp',
            id: 'laboratory-request-crp-1',
            indicationCode: 'fever',
            previousReports: [],
            ...(reportReady ? { report } : {}),
            serviceRequestId: 'service-request-crp-1',
            serviceRequestVersion: reportReady ? '2' : '1',
            status: reportReady ? 'reported' : 'in-progress',
            taskId: 'task-crp-1',
            taskVersion: reportReady ? '4' : '3',
            version: reportReady ? 4 : 3,
          }],
        },
        patient,
        presentation: virtualPatientPresentation,
        priorFacts: [],
        status: 'first-visit',
        taskId: 'task-doctor-virtual-1',
        taskVersion: '1',
      })
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
  return {
    detailRequestCount: () => detailRequests,
    makeReportReady: () => {
      reportReady = true
    },
  }
}

function stubDoctorCompletedCaseLibrary(options: {
  activeDetail?: DoctorCaseDetail
  detail?: DoctorCompletedCaseDetail
  list: DoctorCompletedCaseList
  onListRequest?: (url: URL) => void
  onRequest?: (
    url: URL,
    init?: RequestInit,
  ) => Promise<Response | undefined> | Response | undefined
  session?: SessionContext
}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(options.session ?? doctorSession)
    const response = await options.onRequest?.(url, init)
    if (response !== undefined) return response
    if (url.pathname === '/api/his/v1/doctor/queue') {
      return Response.json({ items: [], ...pagination(0) })
    }
    if (url.pathname === '/api/his/v1/catalogs/clinical') {
      return Response.json({
        diagnoses: [{
          code: 'J10.1',
          id: 'diagnosis-influenza-a',
          nameEn: 'Influenza with other respiratory manifestations',
          nameZh: '流感伴其他呼吸道表现',
          system: 'http://hl7.org/fhir/sid/icd-10',
          version: 1,
        }],
        laboratory: [],
        medications: [],
        prescriptionConclusionSupported: true,
      })
    }
    if (url.pathname === '/api/his/v1/doctor/completed-cases') {
      options.onListRequest?.(url)
      return Response.json(options.list)
    }
    if (
      options.detail !== undefined
      && url.pathname === `/api/his/v1/doctor/completed-cases/${options.detail.caseId}`
    ) {
      return Response.json(options.detail)
    }
    if (
      options.activeDetail !== undefined
      && url.pathname === `/api/his/v1/doctor/cases/${options.activeDetail.caseId}`
    ) {
      return Response.json(options.activeDetail)
    }
    throw new Error(`Unexpected request: ${url.pathname}`)
  }))
}

describe('role workspaces', () => {
  beforeEach(() => {
    localStorage.clear()
    useSyntheticPatientLibraryViewStore.getState().reset()
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows only synthetic data and confirms the selected reset scope', async () => {
    const resets: boolean[] = []
    stubScenarioDataWorkspace({ profileAvailable: true, onReset: clear => resets.push(clear) })
    const user = userEvent.setup()
    render(<WebApp />)
    expect(await screen.findByRole('heading', { name: '合成患者库' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '工作台总览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '载入标准数据' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '检验服务配置' })).toBeNull()
    await waitFor(() => expect(window.location.pathname).toBe('/scenario-data'))
    const reset = screen.getByRole('button', { name: '重置数据' })
    await waitFor(() => expect(reset.hasAttribute('disabled')).toBe(false))
    reset.focus()
    expect(await screen.findByRole('tooltip')).toBeTruthy()
    await user.hover(reset)
    await user.click(reset)
    const dialog = await screen.findByRole('alertdialog', { name: '确认重置数据' })
    expect(resets).toEqual([])
    expect(within(dialog).getByRole('checkbox', { name: '同时清空合成患者库' }).getAttribute('aria-checked')).toBe('false')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(resets).toEqual([])
    await user.click(reset)
    const confirmation = await screen.findByRole('alertdialog', { name: '确认重置数据' })
    await user.click(within(confirmation).getByRole('checkbox', { name: '同时清空合成患者库' }))
    expect(within(confirmation).getByText(/来源病史、患者档案和本次病例真值/)).toBeTruthy()
    await user.click(within(confirmation).getByRole('button', { name: '确认重置' }))
    await waitFor(() => expect(resets).toEqual([true]))
    expect(await screen.findByText('还没有合成患者')).toBeTruthy()
  })

  it('does not expose synthetic data management to a non-administrator role', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubEmptyRegistrarWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('当前暂无门诊挂号。')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '模拟数据' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '模拟数据' })).toBeNull()
  })

  it('localizes patient library counts and preserves an open generation draft on host language changes', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, syntheaAvailable: false })
    const user = userEvent.setup()
    const rendered = render(<WebApp runtime={{ mode: 'surface', surfaceLocale: 'en-US' }} />)
    expect(await screen.findByText('1 patient')).toBeTruthy()
    expect(screen.getAllByText('38 years').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Generate patients' }))
    const dialog = await screen.findByRole('dialog', { name: 'Generate patients' })
    expect(within(dialog).getByText('Synthea Provider is not configured')).toBeTruthy()
    const count = within(dialog).getByRole('spinbutton', { name: 'Patient count' })
    await user.clear(count)
    await user.type(count, '3')
    if (!(count instanceof HTMLInputElement)) throw new Error('Expected a patient count input')
    expect(count.value).toBe('3')
    rendered.rerender(<WebApp runtime={{ mode: 'surface', surfaceLocale: 'zh-CN' }} />)
    expect(await screen.findByRole('dialog', { name: '生成患者' })).toBe(dialog)
    expect(within(dialog).getByRole('spinbutton', { name: '患者人数' })).toBe(count)
    expect(count.value).toBe('3')
  })

  it('uses the persistent synthetic patient library as the only production data workspace', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, syntheaAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '合成患者库' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成患者' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '数据生成服务' })).toBeNull()
    expect(screen.queryByRole('tab', { name: '高级病例编排' })).toBeNull()
    expect(screen.queryByRole('button', { name: '安装运行' })).toBeNull()
    expect(document.body.textContent).not.toContain('映射')
    await user.click(screen.getByRole('button', { name: '生成患者' }))
    const generationSheet = await screen.findByRole('dialog', { name: '生成患者' })
    expect(within(generationSheet).getByText('全部 Synthea 模块')).toBeTruthy()
    expect(within(generationSheet).getByRole('spinbutton', { name: '患者人数' }).getAttribute('max')).toBe('10')
    const filter = within(generationSheet).getByRole('checkbox', { name: '限制 Synthea 模块' })
    expect(filter.getAttribute('aria-checked')).toBe('false')
    await user.click(filter)
    expect(within(generationSheet).getByRole('checkbox', { name: 'cardiovascular/hypertension' }).getAttribute('aria-checked')).toBe('true')
    expect(within(generationSheet).getByRole('checkbox', { name: 'metabolic/diabetes' })).toBeTruthy()
  })

  it('publishes Provider and generation status Tools from the synthetic patient library', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, syntheaAvailable: true })
    const applicationFetch = vi.mocked(fetch).getMockImplementation()
    if (applicationFetch === undefined) throw new Error('Synthetic patient library stub is unavailable')
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/agent/v1/page-contexts') {
        const request = JSON.parse(String(init?.body)) as {
          claim: Record<string, unknown>
          dshSessionId: string
        }
        const issuedAt = new Date()
        return Response.json({
          snapshot: {
            actor: {
              actorId: administratorSession.actor.actorId,
              practitionerRoleId: administratorSession.actor.practitionerRoleId,
              roleCode: administratorSession.actor.roleCode,
            },
            allowedOperationIds: agentToolsForContext('administrator', 'scenarioData')
              .map(tool => tool.operationId),
            claim: request.claim,
            dshSessionId: request.dshSessionId,
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
            id: 'context-admin-synthetic-patient-library',
            issuedAt: issuedAt.toISOString(),
            scopeKey: 'clinmesh:administrator:scenario-data',
            version: 1,
            workspace: {
              epoch: administratorSession.actor.epoch,
              id: administratorSession.actor.workspaceId,
              scenarioRunId: administratorSession.actor.scenarioRunId,
            },
          },
          token: 'context-token-with-at-least-32-characters',
        }, { status: 201 })
      }
      return applicationFetch(input, init)
    })
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }

    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    await waitFor(() => expect(registration?.tools.map(tool => tool.name)).toEqual([
      'clinmesh_read_current_context',
      'clinmesh_navigate',
      'clinmesh_focus_panel',
      'clinmesh_read_scenario_status',
      'clinmesh_read_scenario_providers',
      'clinmesh_read_generation_status',
      'clinmesh_prepare_scenario_reset',
    ]))
  })

  it('keeps module filtering disabled when Synthea reports no modules', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ providerModules: [], syntheaAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await user.click((await screen.findAllByRole('button', { name: '生成患者' }))[0]!)
    const generationSheet = await screen.findByRole('dialog', { name: '生成患者' })
    const moduleFilter = within(generationSheet).getByRole('checkbox', { name: '限制 Synthea 模块' })
    await user.click(moduleFilter)
    expect(moduleFilter.getAttribute('aria-checked')).toBe('false')
    expect(within(generationSheet).queryByText('Synthea modules')).toBeNull()
  })

  it('randomizes both seeds whenever the generation sheet opens and submits the visible values', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let randomCalls = 0
    vi.spyOn(Math, 'random').mockImplementation(() => ((randomCalls += 1) % 100) / 100)
    let submitted: ScenarioGenerationRequest | undefined
    stubScenarioDataWorkspace({
      onGenerate: request => { submitted = request },
      syntheaAvailable: true,
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click((await screen.findAllByRole('button', { name: '生成患者' }))[0]!)
    let sheet = await screen.findByRole('dialog', { name: '生成患者' })
    await user.click(within(sheet).getByText('高级设置'))
    const firstPopulation = Number(within(sheet).getByRole<HTMLInputElement>(
      'spinbutton',
      { name: '人口 seed' },
    ).value)
    const firstClinical = Number(within(sheet).getByRole<HTMLInputElement>(
      'spinbutton',
      { name: '临床 seed' },
    ).value)
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '生成患者' })).toBeNull())

    await user.click(screen.getAllByRole('button', { name: '生成患者' })[0]!)
    sheet = await screen.findByRole('dialog', { name: '生成患者' })
    await user.click(within(sheet).getByText('高级设置'))
    const population = Number(within(sheet).getByRole<HTMLInputElement>(
      'spinbutton',
      { name: '人口 seed' },
    ).value)
    const clinical = Number(within(sheet).getByRole<HTMLInputElement>(
      'spinbutton',
      { name: '临床 seed' },
    ).value)

    expect({ clinical, population }).not.toEqual({
      clinical: firstClinical,
      population: firstPopulation,
    })
    await user.click(within(sheet).getByRole('button', { name: '生成患者' }))
    await waitFor(() => expect(submitted?.seeds).toEqual({ clinical, population }))
  })

  it('reports each Synthea patient generation state instead of leaving it unknown', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ generationJobDelayMs: 250, syntheaAvailable: true })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click((await screen.findAllByRole('button', { name: '生成患者' }))[0]!)
    const sheet = await screen.findByRole('dialog', { name: '生成患者' })
    await user.click(within(sheet).getByRole('button', { name: '生成患者' }))

    expect(await screen.findByRole('status', { name: '患者生成排队中' })).toBeTruthy()
    expect(await screen.findByRole(
      'status',
      { name: '患者生成中' },
      { timeout: 2_500 },
    )).toBeTruthy()
    await user.click(screen.getByRole('link', { name: '设置' }))
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe('/scenario-data'))
    expect(await screen.findByRole('status', { name: '患者生成中' })).toBeTruthy()
    expect(await screen.findByRole(
      'status',
      { name: '患者档案与病例已生成' },
      { timeout: 2_500 },
    )).toBeTruthy()
  })

  it('reports a failed Synthea patient generation with its error', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ generationJobFails: true, syntheaAvailable: true })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click((await screen.findAllByRole('button', { name: '生成患者' }))[0]!)
    const sheet = await screen.findByRole('dialog', { name: '生成患者' })
    await user.click(within(sheet).getByRole('button', { name: '生成患者' }))

    expect(await screen.findByRole('alert', { name: '患者生成失败' })).toBeTruthy()
    expect(screen.getByText('Synthea 服务暂时不可用')).toBeTruthy()
  })

  it('keeps profiles usable while exposing untranslated clinical displays for review', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, translationWarning: true })
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByText('翻译待确认 1')).toBeTruthy()
    expect(screen.queryByText('患者生成失败')).toBeNull()
    await user.click(screen.getByText('数据来源'))
    expect(await screen.findByText('1 个临床名称保留英文')).toBeTruthy()
    expect(screen.getByText('Untranslated display')).toBeTruthy()
    expect(screen.getByText(/Observation\/observation-1.*code\.coding\[0\]/)).toBeTruthy()
  })

  it('edits a persistent profile and keeps its visible source history', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    expect(await screen.findByText('CMSYN000001')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '纵向健康记录' })).toBeNull()
    await user.click(await screen.findByRole('button', { name: '编辑档案' }))
    const editSheet = await screen.findByRole('dialog', { name: '编辑档案' })
    const name = within(editSheet).getByRole('textbox', { name: '展示姓名' })
    await user.clear(name)
    await user.type(name, '合成患者新姓名')
    await user.click(within(editSheet).getByRole('button', { name: '保存档案' }))
    expect((await screen.findAllByText('合成患者新姓名')).length).toBeGreaterThan(0)

    await user.click(await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ }))
    await user.click(await screen.findByRole('button', { name: /发热.*Condition/ }))
    expect(await screen.findByText(/prior-condition/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('index-condition')
  })

  it('loads administrator case truth only when expanded and collapses it for another patient', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let reads = 0
    stubScenarioDataWorkspace({ profileAvailable: true, secondProfileAvailable: true, onTruthRead: () => { reads += 1 } })
    const user = userEvent.setup()
    render(<WebApp />)

    const toggle = await screen.findByText('本次病例真值')
    expect(toggle.closest('details')?.open).toBe(false)
    expect(reads).toBe(0)
    expect(screen.queryByText('本次合成疾病')).toBeNull()
    await user.click(toggle)
    expect(await screen.findByRole('heading', { name: '本次合成疾病' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '关联的既往疾病' })).toBeNull()
    expect(screen.getByText('关联的既往疾病').closest('details')?.open).toBe(false)
    expect(reads).toBe(1)
    const related = screen.getByText('本次收缩压')
    await user.click(related)
    expect(await screen.findByText('162 mmHg')).toBeTruthy()
    await user.click(related)
    expect(screen.queryByText('162 mmHg')).toBeNull()
    expect(toggle.closest('details')?.open).toBe(true)
    const raw = screen.getAllByText('原始 JSON')[0]!
    await user.click(raw)
    await user.click(raw)
    expect(toggle.closest('details')?.open).toBe(true)
    await user.click(toggle)
    expect(screen.queryByText('本次合成疾病')).toBeNull()
    await user.click(screen.getByRole('button', { name: /第二位合成患者.*CMSYN000002/ }))
    expect(await screen.findByRole('heading', { name: '第二位合成患者' })).toBeTruthy()
    expect(screen.getByText('本次病例真值').closest('details')?.open).toBe(false)
    expect(reads).toBe(1)
  })

  it('combines the patient brief, titled history and readable resource details', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('button', { name: '生成患者档案' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '来源' })).toBeNull()
    const date = await screen.findByRole('button', { name: /2026-07-01.*发热.*体温.*2 条记录/ })
    await user.click(date)
    await user.click(screen.getByRole('button', { name: /发热.*Condition/ }))
    const detail = await screen.findByRole('region', { name: '历史记录详情' })
    expect(await within(detail).findByText('发热')).toBeTruthy()
    expect(within(detail).getByText('诊断')).toBeTruthy()
    expect(within(detail).getByText('原始 JSON').closest('details')?.open).toBe(false)
    expect(screen.getByText('数据来源').closest('details')?.open).toBe(false)
  })

  it('expands and collapses source history events by business date', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    const dateColumn = await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ })
    expect(dateColumn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /发热.*Condition/ })).toBeNull()

    await user.click(dateColumn)
    expect(dateColumn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /发热.*Condition/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /体温.*Observation/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /发热.*Condition/ }))
    expect(await screen.findByText(/prior-condition/)).toBeTruthy()

    await user.click(dateColumn)
    expect(dateColumn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /发热.*Condition/ })).toBeNull()
  })

  it('aligns the right-side resource detail with the selected history row', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ }))
    const historyList = screen.getByRole('group', { name: '来源历史' })
    const condition = screen.getByRole('button', { name: /发热.*Condition/ })
    const observation = screen.getByRole('button', { name: /体温.*Observation/ })
    vi.spyOn(historyList, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    vi.spyOn(condition, 'getBoundingClientRect').mockReturnValue({ top: 180 } as DOMRect)
    vi.spyOn(observation, 'getBoundingClientRect').mockReturnValue({ top: 236 } as DOMRect)

    await user.click(condition)
    const detail = await screen.findByRole('region', { name: '历史记录详情' })
    expect(detail.style.getPropertyValue('--source-history-detail-offset')).toBe('80px')

    await user.click(observation)
    expect(detail.style.getPropertyValue('--source-history-detail-offset')).toBe('136px')
  })

  it('starts another patient source history with every date collapsed', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, secondProfileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    const firstDateColumn = await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ })
    await user.click(firstDateColumn)
    expect(firstDateColumn.getAttribute('aria-expanded')).toBe('true')

    await user.click(screen.getByRole('button', { name: /第二位合成患者/ }))
    expect(await screen.findByRole('heading', { name: '第二位合成患者' })).toBeTruthy()
    const secondDateColumn = await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ })
    expect(secondDateColumn.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a profile edit conflict visible in the patient library', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, profileUpdateConflict: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: '编辑档案' }))
    const editSheet = await screen.findByRole('dialog', { name: '编辑档案' })
    await user.click(within(editSheet).getByRole('button', { name: '保存档案' }))

    expect(await within(editSheet).findByText('保存失败')).toBeTruthy()
    expect(within(editSheet).getByText('该合成患者档案已被其他管理员修改。')).toBeTruthy()
  })

  it('opens only an allowlisted visible R4 source resource', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: /2026-07-01.*2 条记录/ }))
    await user.click(await screen.findByRole('button', { name: /发热.*Condition/ }))

    expect(await screen.findByText(/"resourceType": "Condition"/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('index-condition')
  })

  it('generates a Patient Persona explicitly from the synthetic patient library', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let caseStarts = 0
    stubScenarioDataWorkspace({
      briefJobDelayMs: 250,
      onCaseStart: () => { caseStarts += 1 },
      profileAvailable: true,
      syntheaAvailable: true,
    })
    const user = userEvent.setup()

    render(<WebApp />)

    await screen.findByRole('button', { name: '生成患者档案' })
    expect(await screen.findByText('尚未生成患者档案')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '生成患者档案' }))

    expect(await screen.findByRole('status', { name: '患者档案排队中' })).toBeTruthy()
    expect(await screen.findByRole(
      'status',
      { name: '患者档案生成中' },
      { timeout: 2_500 },
    )).toBeTruthy()
    await user.click(screen.getByText('数据来源'))
    await screen.findByRole('button', { name: '生成患者档案' })
    expect(await screen.findByRole('status', { name: '患者档案生成中' })).toBeTruthy()
    expect(await screen.findByRole(
      'status',
      { name: '患者档案已完成' },
      { timeout: 2_500 },
    )).toBeTruthy()
    expect(await screen.findByText('反复头晕一周')).toBeTruthy()
    expect(screen.getByText('医生您好，我最近总是头晕。')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '开始门诊就诊' }))
    const visitSheet = await screen.findByRole('dialog', { name: '开始门诊就诊' })
    await user.click(within(visitSheet).getByRole('button', { name: '开始门诊就诊' }))
    await waitFor(() => expect(caseStarts).toBe(1))
  })

  it('does not carry an active Patient Persona job into another patient', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({
      briefJobDelayMs: 2_500,
      profileAvailable: true,
      secondProfileAvailable: true,
      syntheaAvailable: true,
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: /第二位合成患者.*CMSYN000002/ }))
    expect(await screen.findByRole('heading', { name: '第二位合成患者' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /林晓.*CMSYN000001/ }))
    expect(await screen.findByRole('heading', { name: '林晓' })).toBeTruthy()
    await screen.findByRole('button', { name: '生成患者档案' })
    await user.click(screen.getByRole('button', { name: '生成患者档案' }))
    expect(await screen.findByRole(
      'status',
      { name: '患者档案生成中' },
      { timeout: 3_500 },
    )).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /第二位合成患者.*CMSYN000002/ }))
    expect(await screen.findByRole('heading', { name: '第二位合成患者' })).toBeTruthy()
    await screen.findByRole('button', { name: '生成患者档案' })
    expect(screen.queryByRole('status', { name: '患者档案生成中' })).toBeNull()

    await user.click(screen.getByRole('button', { name: /林晓.*CMSYN000001/ }))
    expect(await screen.findByRole('heading', { name: '林晓' })).toBeTruthy()
    await screen.findByRole('button', { name: '生成患者档案' })
    expect(await screen.findByRole('status', { name: '患者档案生成中' })).toBeTruthy()
  })

  it('reports a failed Patient Persona generation with its error', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({
      briefJobFails: true,
      profileAvailable: true,
      syntheaAvailable: true,
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await screen.findByRole('button', { name: '生成患者档案' })
    await user.click(screen.getByRole('button', { name: '生成患者档案' }))

    expect(await screen.findByRole('alert', { name: '患者档案生成失败' })).toBeTruthy()
    expect(screen.getByText('患者档案服务暂时不可用')).toBeTruthy()
  })

  it('uses clinical operator language for the registrar empty state', async () => {
    stubEmptyRegistrarWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('当前暂无门诊挂号。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenChineseClinicalUiTerms)
  })

  it('uses clinical operator language for the English registrar empty state', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'light',
    }))
    stubEmptyRegistrarWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('No outpatient registrations are currently available.')).toBeTruthy()
    expect(screen.getByRole('main').textContent).not.toMatch(forbiddenEnglishClinicalUiTerms)
  })

  it('publishes registrar Synthetic Case search, selection, and review Tools', async () => {
    let started = false
    const caseSearches: string[] = []
    const reviewedDecisions: string[] = []
    const completedOperations: string[] = []
    const readyCase = {
      activeBriefRevision: 2,
      birthDate: '1970-01-01',
      caseId: 'synthetic-case-agent-001',
      caseRevision: 3,
      caseType: 'follow-up',
      gender: 'female',
      mrn: 'CMSYNAGENT001',
      name: '张琴',
      profileRevision: 1,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const path = url.pathname
      if (path === '/api/auth/context') return Response.json(registrarSession)
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{ id: 'department-general-medicine', nameEn: 'General Medicine', nameZh: '全科医学科', version: 1 }],
          locations: [{ id: 'location-outpatient', nameEn: 'Outpatient clinic', nameZh: '门诊诊区', version: 1 }],
          virtualDate: '2026-09-03',
          visitTypes: [{ id: 'visit-general', nameEn: 'General outpatient', nameZh: '普通门诊', priceFen: 2000, version: 1 }],
        })
      }
      if (path === '/api/his/v1/registration/synthetic-cases') {
        caseSearches.push(url.searchParams.get('search') ?? '')
        return Response.json({
          items: started ? [] : [readyCase],
          ...pagination(started ? 0 : 1),
        })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (path === '/api/agent/v1/page-contexts') {
        const request = JSON.parse(String(init?.body)) as {
          claim: Record<string, unknown>
          dshSessionId: string
        }
        const issuedAt = new Date()
        return Response.json({
          snapshot: {
            actor: {
              actorId: registrarSession.actor.actorId,
              practitionerRoleId: registrarSession.actor.practitionerRoleId,
              roleCode: registrarSession.actor.roleCode,
            },
            allowedOperationIds: agentToolsForContext('registrar', 'registration')
              .map(tool => tool.operationId),
            claim: request.claim,
            dshSessionId: request.dshSessionId,
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
            id: `context-${String(request.claim.viewRevision)}`,
            issuedAt: issuedAt.toISOString(),
            scopeKey: 'clinmesh:registrar:registration',
            version: 1,
            workspace: {
              epoch: registrarSession.actor.epoch,
              id: registrarSession.actor.workspaceId,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
          },
          token: 'context-token-with-at-least-32-characters',
        }, { status: 201 })
      }
      if (path === '/clinmesh-agent-proof') {
        return Response.json({ data: { proof: 'proof-with-at-least-32-characters' } })
      }
      if (path === '/api/agent/v1/tool-calls') {
        const request = JSON.parse(String(init?.body)) as { operationId: string }
        const issuedAt = new Date()
        return Response.json({
          callId: `call-${request.operationId}`,
          context: {
            actor: {
              actorId: registrarSession.actor.actorId,
              practitionerRoleId: registrarSession.actor.practitionerRoleId,
              roleCode: registrarSession.actor.roleCode,
            },
            allowedOperationIds: [request.operationId],
            claim: {
              ui: { status: 'ready' },
              version: 1,
              viewId: 'registration',
              viewRevision: `authorized-${request.operationId}`,
            },
            dshSessionId: 'dsh-session-1',
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
            id: `context-authorized-${request.operationId}`,
            issuedAt: issuedAt.toISOString(),
            scopeKey: 'clinmesh:registrar:registration',
            version: 1,
            workspace: {
              epoch: registrarSession.actor.epoch,
              id: registrarSession.actor.workspaceId,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
          },
          dshSessionId: 'dsh-session-1',
          operationId: request.operationId,
          ...(request.operationId.endsWith('.propose')
            ? { proposalId: 'registrar-synthetic-case-proposal' }
            : {}),
          receiptToken: 'receipt-token-with-at-least-32-characters',
          status: 'authorized',
        }, { status: 201 })
      }
      if (path === '/api/agent/v1/tool-calls/review') {
        const request = JSON.parse(String(init?.body)) as { decision: string }
        reviewedDecisions.push(request.decision)
        return Response.json({
          decidedAt: '2026-09-03T09:00:01.000Z',
          decision: request.decision,
          proposalId: 'registrar-synthetic-case-proposal',
        })
      }
      if (path === '/api/agent/v1/tool-calls/result') {
        const request = JSON.parse(String(init?.body)) as { ok: boolean }
        completedOperations.push(request.ok ? 'completed' : 'failed')
        return Response.json({ status: 'completed' })
      }
      if (path === '/api/his/v1/synthetic-cases/synthetic-case-agent-001/actions/start-outpatient-visit') {
        expect(reviewedDecisions).toEqual(['approved'])
        started = true
        return Response.json(commandResponse({
          encounterId: 'encounter-agent-001',
          outpatientCaseId: 'outpatient-case-agent-001',
          patientId: 'patient-agent-001',
          queueTaskId: 'task-triage-agent-001',
          registrationId: 'registration-agent-001',
          status: 'awaiting-triage',
          syntheticCaseId: readyCase.caseId,
        }))
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }

    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    await waitFor(() => expect(registration?.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        'clinmesh_search_registration_cases',
        'clinmesh_select_registration_case',
      ]),
    ))
    expect(registration?.tools.map(tool => tool.name))
      .not.toContain('clinmesh_prepare_start_registration_case')

    const signal = new AbortController().signal
    const searchTool = registration?.tools.find(tool => tool.name === 'clinmesh_search_registration_cases')
    if (searchTool === undefined) throw new Error('Synthetic Case search Tool is unavailable')
    await searchTool.execute(boundAgentToolInput(searchTool, { query: readyCase.mrn }), signal)
    expect(caseSearches).toContain(readyCase.mrn)
    const selectTool = registration?.tools.find(tool => tool.name === 'clinmesh_select_registration_case')
    if (selectTool === undefined) throw new Error('Synthetic Case selection Tool is unavailable')
    await selectTool.execute(boundAgentToolInput(selectTool, { caseId: readyCase.caseId }), signal)
    await waitFor(() => expect(registration?.tools.map(tool => tool.name))
      .toContain('clinmesh_prepare_start_registration_case'))
    const proposal = registration?.tools.find(
      tool => tool.name === 'clinmesh_prepare_start_registration_case',
    )
    if (proposal === undefined) throw new Error('Synthetic Case proposal Tool is unavailable')
    expect(JSON.parse(String(await proposal.execute(boundAgentToolInput(proposal, {}), signal))))
      .toMatchObject({ data: { status: 'awaiting-human-review' }, ok: true })
    const review = await screen.findByRole('alertdialog', { name: '挂号信息' })
    await userEvent.click(within(review).getByRole('button', { name: '确认挂号' }))
    await waitFor(() => {
      expect(started).toBe(true)
      expect(completedOperations).toContain('completed')
    })
  })

  it('starts a ready Synthetic Case from the default registrar queue and refreshes both queues', async () => {
    let started = false
    let waitingReads = 0
    let registrationReads = 0
    const readyCase = {
      activeBriefRevision: 2,
      birthDate: '1970-01-01',
      caseId: 'synthetic-case-001',
      caseRevision: 3,
      caseType: 'follow-up',
      gender: 'female',
      mrn: 'CMSYN000001',
      name: '张琴',
      profileRevision: 1,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{ id: 'department-general-medicine', nameEn: 'General Medicine', nameZh: '全科医学科', version: 1 }],
          locations: [{ id: 'location-outpatient', nameEn: 'Outpatient clinic', nameZh: '门诊诊区', version: 1 }],
          virtualDate: '2026-09-03',
          visitTypes: [{ id: 'visit-general', nameEn: 'General outpatient', nameZh: '普通门诊', priceFen: 2000, version: 1 }],
        })
      }
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        waitingReads += 1
        return Response.json({ items: started ? [] : [readyCase], ...pagination(started ? 0 : 1) })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        registrationReads += 1
        return Response.json(started ? {
          items: [{
            arrivedAt: '2026-09-03T09:00:00+08:00',
            caseId: 'outpatient-case-001',
            encounterId: 'encounter-001',
            encounterVersion: '1',
            patient: {
              birthDate: readyCase.birthDate,
              gender: readyCase.gender,
              id: 'patient-001',
              identifier: readyCase.mrn,
              name: readyCase.name,
              synthetic: true,
              versionId: '1',
            },
            registrationId: 'registration-001',
            registrationNumber: 'CM-OP-20260903-0001',
            registrationStatus: 'registered',
            status: 'awaiting-triage',
            taskId: 'task-triage-001',
            taskVersion: '1',
          }],
          ...pagination(1),
        } : { items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/synthetic-cases/synthetic-case-001/actions/start-outpatient-visit') {
        expect(JSON.parse(String(init?.body))).toEqual({
          activeBriefRevision: 2,
          departmentId: 'department-general-medicine',
          expectedCaseRevision: 3,
          locationId: 'location-outpatient',
          visitDate: '2026-09-03',
          visitTypeId: 'visit-general',
        })
        started = true
        return Response.json(commandResponse({
          encounterId: 'encounter-001',
          outpatientCaseId: 'outpatient-case-001',
          patientId: 'patient-001',
          queueTaskId: 'task-triage-001',
          registrationId: 'registration-001',
          status: 'awaiting-triage',
          syntheticCaseId: readyCase.caseId,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()

    render(<WebApp />)

    expect(await screen.findByRole('tab', { name: '待挂号病例' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '临时患者建档' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '新建合成患者' })).toBeNull()
    const selectCase = await screen.findByRole('button', { name: '选择病例 张琴' })
    expect(selectCase.textContent).toContain('选择')
    expect(selectCase.getAttribute('aria-pressed')).toBe('false')
    await user.click(selectCase)
    const selectedCase = screen.getByRole('button', { name: '已选择病例 张琴' })
    expect(selectedCase.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByTitle('张琴')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消选择' })).toBeTruthy()
    const confirmRegistration = screen.getByRole('button', { name: '确认挂号' })
    expect(confirmRegistration.hasAttribute('disabled')).toBe(false)
    await user.click(selectedCase)
    expect(screen.getByRole('button', { name: '选择病例 张琴' }).getAttribute('aria-pressed'))
      .toBe('false')
    expect(confirmRegistration.hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: '选择病例 张琴' }))
    expect(confirmRegistration.hasAttribute('disabled')).toBe(false)
    await user.click(confirmRegistration)

    expect(await screen.findByText('CM-OP-20260903-0001')).toBeTruthy()
    await waitFor(() => {
      expect(waitingReads).toBeGreaterThan(1)
      expect(registrationReads).toBeGreaterThan(1)
    })
    expect(screen.queryByRole('button', { name: '选择病例 张琴' })).toBeNull()
  })

  it('clears a stale Synthetic Case selection and refreshes queues after a start conflict', async () => {
    let caseTaken = false
    let startRequests = 0
    let waitingReads = 0
    let registrationReads = 0
    const readyCase = {
      activeBriefRevision: 1,
      birthDate: '1982-04-12',
      caseId: 'synthetic-case-conflict-001',
      caseRevision: 2,
      caseType: 'new-problem',
      gender: 'male',
      mrn: 'CMSYNCONFLICT01',
      name: '并发病例患者',
      profileRevision: 1,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{ id: 'department-general-medicine', nameEn: 'General Medicine', nameZh: '全科医学科', version: 1 }],
          locations: [{ id: 'location-outpatient', nameEn: 'Outpatient clinic', nameZh: '门诊诊区', version: 1 }],
          virtualDate: '2026-09-03',
          visitTypes: [{ id: 'visit-general', nameEn: 'General outpatient', nameZh: '普通门诊', priceFen: 2000, version: 1 }],
        })
      }
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        waitingReads += 1
        return Response.json({
          items: caseTaken ? [] : [readyCase],
          ...pagination(caseTaken ? 0 : 1),
        })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        registrationReads += 1
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname.includes('/actions/start-outpatient-visit')) {
        startRequests += 1
        caseTaken = true
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            message: 'The Synthetic Case changed while starting',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: `选择病例 ${readyCase.name}` }))
    const confirm = screen.getByRole('button', { name: '确认挂号' })
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
    await user.click(confirm)

    await waitFor(() => {
      expect(startRequests).toBe(1)
      expect(waitingReads).toBeGreaterThan(1)
      expect(registrationReads).toBeGreaterThan(1)
      expect(screen.queryByText(`已选择：${readyCase.name}`)).toBeNull()
    }, { timeout: 3_000 })
    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认挂号' }).hasAttribute('disabled')).toBe(true)
  })

  it('creates a synthetic patient and registers the selected patient from server catalogs', async () => {
    let registered = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{
            id: 'department-general-medicine',
            nameEn: 'General Medicine',
            nameZh: '全科医学科',
            version: 1,
          }],
          locations: [{
            id: 'location-fever-clinic',
            nameEn: 'Fever clinic',
            nameZh: '发热门诊',
            version: 1,
          }],
          virtualDate: '2026-08-24',
          visitTypes: [{
            id: 'visit-general',
            nameEn: 'General outpatient registration',
            nameZh: '普通门诊挂号费',
            priceFen: 2000,
            version: 1,
          }],
        })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        return Response.json(registered ? {
          items: [{
            arrivedAt: '2026-08-24T09:00:00+08:00',
            caseId: 'case-1',
            encounterId: 'encounter-1',
            encounterVersion: '1',
            patient,
            registrationId: 'registration-1',
            registrationNumber: 'CM-OP-20260824-0001',
            registrationStatus: 'registered',
            status: 'awaiting-triage',
            taskId: 'task-triage-1',
            taskVersion: '1',
          }],
          ...pagination(1),
        } : { items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/patients' && init?.method === 'POST') {
        return Response.json(commandResponse({ patient }))
      }
      if (url.pathname === '/api/his/v1/registrations/actions/register') {
        registered = true
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body.expectedVersions).toEqual({ 'Patient/patient-1': '1' })
        expect(body.input).toEqual({
          departmentId: 'department-general-medicine',
          locationId: 'location-fever-clinic',
          patientId: 'patient-1',
          visitDate: '2026-08-24',
          visitTypeId: 'visit-general',
        })
        return Response.json(commandResponse({
          accountId: 'account-1',
          chargeItemId: 'charge-registration-1',
          encounterId: 'encounter-1',
          patientId: 'patient-1',
          queueTaskId: 'task-triage-1',
          registrationId: 'registration-1',
          status: 'awaiting-triage',
          totalFen: 2000,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await screen.findByText('普通门诊挂号费 · ¥20.00')
    await user.click(screen.getByRole('tab', { name: '临时患者建档' }))
    expect((await screen.findByRole('combobox', { name: '性别' })).textContent).toContain('男')
    expect((await screen.findByRole('combobox', { name: '科室' })).textContent).toContain('全科医学科')
    expect(screen.getByRole('combobox', { name: '号别' }).textContent).toContain('普通门诊挂号费 · ¥20.00')
    expect(screen.getByRole('combobox', { name: '就诊地点' }).textContent).toContain('发热门诊')
    await user.type(screen.getByLabelText('姓名'), '合成患者周明')
    await user.type(screen.getByLabelText('临时患者标识'), 'CM-SYN-001')
    await user.click(screen.getByRole('button', { name: '创建临时患者' }))

    expect(await screen.findByTitle('合成患者周明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消选择' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认挂号' }))

    expect(await screen.findByText('挂号完成')).toBeTruthy()
    expect(await screen.findByText('CM-OP-20260824-0001')).toBeTruthy()
  })

  it('exposes patient-search loading and service errors at the Web seam', async () => {
    window.history.replaceState(null, '', '/registration')
    let resolvePatientSearch: (response: Response) => void = () => undefined
    const patientSearch = new Promise<Response>((resolve) => {
      resolvePatientSearch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], locations: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/patients') return patientSearch
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '检索患者' }))
    await user.type(await screen.findByLabelText('姓名、门诊号或合成标识'), 'CM-SYN-404')
    await user.click(screen.getByRole('button', { name: '搜索' }))

    expect(await screen.findByRole('status', { name: '正在检索患者' })).toBeTruthy()

    await act(async () => {
      resolvePatientSearch(Response.json({
        error: { code: 'SERVICE_UNAVAILABLE', message: '患者目录暂时不可用' },
      }, { status: 503 }))
    })
    expect(await screen.findByText('患者检索不可用')).toBeTruthy()
    expect(screen.getByText('服务暂时无法完成请求，请稍后重试。')).toBeTruthy()
  })

  it('distinguishes a registration conflict from a generic operation failure', async () => {
    window.history.replaceState(null, '', '/registration')
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-conflict',
      identifier: 'CM-SYN-CONFLICT',
      name: '合成并发患者',
      synthetic: true,
      versionId: '3',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{
            id: 'department-general-medicine',
            nameEn: 'General Medicine',
            nameZh: '全科医学科',
            version: 1,
          }],
          locations: [{
            id: 'location-fever-clinic',
            nameEn: 'Fever clinic',
            nameZh: '发热门诊',
            version: 1,
          }],
          virtualDate: '2026-08-24',
          visitTypes: [{
            id: 'visit-general',
            nameEn: 'General outpatient registration',
            nameZh: '普通门诊挂号费',
            priceFen: 2000,
            version: 1,
          }],
        })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/patients') {
        return Response.json({ items: [patient], ...pagination(1) })
      }
      if (url.pathname === '/api/his/v1/registrations/actions/register') {
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            message: 'The patient already has an active outpatient case',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '检索患者' }))
    await user.type(await screen.findByLabelText('姓名、门诊号或合成标识'), patient.identifier)
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.click(await screen.findByRole('button', { name: `选择患者 ${patient.name}` }))
    await user.click(screen.getByRole('button', { name: '确认挂号' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByText('当前业务状态或前置条件不满足，请核对病例信息后重试。')).toBeTruthy()
  })

  it('keeps a long Chinese patient name available through search and selection', async () => {
    window.history.replaceState(null, '', '/registration')
    const longName = '合成患者用于验证窄视口下超长中文姓名仍可被完整识别与选择'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], locations: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/patients') {
        return Response.json({
          items: [{
            id: 'patient-long-name',
            identifier: 'CM-SYN-LONG-NAME',
            name: longName,
            synthetic: true,
            versionId: '1',
          }],
          ...pagination(1),
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '检索患者' }))
    await user.type(await screen.findByLabelText('姓名、门诊号或合成标识'), 'CM-SYN-LONG-NAME')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.click(await screen.findByRole('button', { name: `选择患者 ${longName}` }))

    expect(await screen.findByTitle(longName)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryByTitle(longName)).toBeNull()
    expect(screen.getByRole('button', { name: '确认挂号' }).hasAttribute('disabled')).toBe(true)
  })

  it('navigates the registration queue to the requested server page', async () => {
    const requestedPages: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
      if (url.pathname === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{
            id: 'department-general-medicine',
            nameEn: 'General Medicine',
            nameZh: '全科医学科',
            version: 1,
          }],
          locations: [{
            id: 'location-fever-clinic',
            nameEn: 'Fever clinic',
            nameZh: '发热门诊',
            version: 1,
          }],
          virtualDate: '2026-08-24',
          visitTypes: [{
            id: 'visit-general',
            nameEn: 'General outpatient registration',
            nameZh: '普通门诊挂号费',
            priceFen: 2000,
            version: 1,
          }],
        })
      }
      if (url.pathname === '/api/his/v1/registrations') {
        const page = Number(url.searchParams.get('page') ?? '1')
        requestedPages.push(page)
        const sequence = page === 1 ? '0001' : '0021'
        return Response.json({
          items: [{
            arrivedAt: '2026-08-24T09:00:00+08:00',
            caseId: `case-${sequence}`,
            encounterId: `encounter-${sequence}`,
            encounterVersion: '1',
            patient: {
              id: `patient-${sequence}`,
              identifier: `CM-SYN-${sequence}`,
              name: `合成分页患者${sequence}`,
              synthetic: true,
              versionId: '1',
            },
            registrationId: `registration-${sequence}`,
            registrationNumber: `CM-OP-20260824-${sequence}`,
            registrationStatus: 'registered',
            status: 'awaiting-triage',
            taskId: `task-${sequence}`,
            taskVersion: '1',
          }],
          page,
          pageSize: 20,
          total: 21,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    render(<WebApp />)
    expect(await screen.findByText('CM-OP-20260824-0001')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('CM-OP-20260824-0021')).toBeTruthy()
    expect(requestedPages).toContain(2)
  })

  it('records structured triage and moves the case to the completed queue', async () => {
    let triaged = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const queueItem = {
      arrivedAt: '2026-08-24T09:00:00+08:00',
      caseId: 'case-1',
      department: {
        id: 'department-general-medicine',
        nameEn: 'General Medicine',
        nameZh: '全科医学科',
      },
      encounterId: 'encounter-1',
      encounterVersion: triaged ? '2' : '1',
      location: {
        id: 'location-fever-clinic',
        nameEn: 'Fever clinic',
        nameZh: '门诊诊疗区',
      },
      patient,
      registrationNumber: 'CM-OP-20260824-0001',
      riskFlags: [{ code: 'PENICILLIN', display: '青霉素过敏' }],
      status: triaged ? 'awaiting-doctor' : 'awaiting-triage',
      taskId: 'task-triage-1',
      taskVersion: triaged ? '2' : '1',
      visitType: {
        id: 'visit-general',
        nameEn: 'General outpatient registration',
        nameZh: '普通门诊挂号费',
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(triageNurseSession)
      if (url.pathname === '/api/his/v1/triage/queue') {
        const status = url.searchParams.get('status') ?? 'pending'
        const hasItem = status === (triaged ? 'completed' : 'pending')
        return Response.json({
          items: hasItem ? [queueItem] : [],
          ...pagination(hasItem ? 1 : 0),
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/record-triage') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body.expectedVersions).toEqual({
          'Encounter/encounter-1': '1',
          'Task/task-triage-1': '1',
        })
        expect(body.input).toEqual({
          acuityCode: 'level-3',
          bloodPressure: { diastolicMmHg: 78, systolicMmHg: 118 },
          chiefComplaint: '发热伴咽痛两天',
          oxygenSaturationPct: 98,
          pulseBpm: 92,
          respirationBpm: 18,
          temperatureC: 38.2,
        })
        triaged = true
        return Response.json(commandResponse({
          doctorTaskId: 'task-doctor-1',
          encounterId: 'encounter-1',
          encounterVersion: '2',
          observationId: 'observation-triage-1',
          status: 'awaiting-doctor',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('tab', { name: '待分诊' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '已分诊' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '异常' })).toBeTruthy()
    expect(await screen.findByRole('listitem', { name: '选择病例 合成患者周明' })).toBeTruthy()
    expect(screen.getByText('全科医学科')).toBeTruthy()
    expect(screen.getByText('门诊诊疗区')).toBeTruthy()
    expect(screen.getByText('普通门诊挂号费')).toBeTruthy()
    expect(screen.getByText('青霉素过敏')).toBeTruthy()
    expect(screen.getByText('到达时间')).toBeTruthy()
    expect(screen.queryByText('department-general-medicine')).toBeNull()
    expect(screen.queryByText('location-fever-clinic')).toBeNull()
    expect(screen.queryByText('visit-general')).toBeNull()
    expect(screen.getByRole('combobox', { name: '分诊级别' }).textContent).toContain('三级 · 急症')

    await user.type(screen.getByLabelText('主诉'), '发热伴咽痛两天')
    await user.clear(screen.getByLabelText('体温（°C）'))
    await user.type(screen.getByLabelText('体温（°C）'), '38.2')
    await user.click(screen.getByRole('button', { name: '完成分诊' }))

    expect(await screen.findByText('分诊完成')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '已分诊' }))
    expect(await screen.findByRole('listitem', { name: '选择病例 合成患者周明' })).toBeTruthy()
  })

  it.each([true, false])('restores dialogue and editable records with recorded triage=%s', async hasTriage => {
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    let consultationVersion = 2
    const opening = {
      id: 'opening', kind: 'text', messageText: '昨天傍晚开始发热，最高量到 38.7 °C。',
      personaRevision: 1, recordedAt: '2026-08-24T09:00:00+08:00', reportReference: null,
      sequence: 1, source: 'persona-opening', speaker: 'patient',
    }
    let turns: Array<Omit<typeof opening, 'personaRevision'> & { personaRevision: number | null }> = [opening]
    let releaseAnswer: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-direct',
            encounterId: 'encounter-direct',
            encounterVersion: '1',
            patient,
            presentation: hasTriage ? virtualPatientPresentation : null,
            status: 'first-visit',
            taskId: 'task-doctor-direct',
            taskVersion: '1',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-direct') {
        return Response.json({
          allergies: [],
          caseId: 'case-direct',
          consultation: { turns, version: consultationVersion },
          encounter: { id: 'encounter-direct', status: 'in-progress', versionId: '1' },
          patient,
          presentation: hasTriage ? virtualPatientPresentation : null,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-direct',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-direct/actions/ask-consultation-question') {
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('idempotency-key')).toBeTruthy()
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: {
            'Encounter/encounter-direct': '1',
            'Task/task-doctor-direct': '1',
          },
          input: {
            expectedConsultationVersion: 2,
            message: '除了发热，还有哪里不舒服？',
          },
        })
        const doctorTurn = {
          ...opening, id: 'doctor-turn', messageText: '除了发热，还有哪里不舒服？',
          personaRevision: null, sequence: 2, source: 'doctor-typed', speaker: 'doctor',
        }
        consultationVersion = 3
        turns = [...turns, doctorTurn]
        return new Promise<Response>(resolve => {
          releaseAnswer = () => {
            const patientTurn = {
              ...opening, id: 'patient-turn', messageText: '咽痛，吞咽时更明显，没有气促。',
              sequence: 3, source: 'patient-agent',
            }
            consultationVersion = 4
            turns = [...turns, patientTurn]
            resolve(Response.json(commandResponse({ caseId: 'case-direct', consultationVersion, doctorTurn, patientTurn })))
          }
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    const contextRail = await screen.findByRole('complementary', { name: '病例上下文' })
    expect(within(contextRail).queryByText('昨天傍晚开始发热，最高量到 38.7 °C。')).toBeNull()
    if (!hasTriage) expect(within(contextRail).getAllByText('未记录分诊信息').length).toBeGreaterThan(0)
    await user.click(await screen.findByRole('tab', { name: '问诊记录' }))
    const consultationRegion = screen.getByRole('region', { name: '问诊记录' })
    expect(within(consultationRegion).getByText('昨天傍晚开始发热，最高量到 38.7 °C。')).toBeTruthy()
    await user.type(within(consultationRegion).getByRole('textbox', { name: '向患者提问' }), '除了发热，还有哪里不舒服？')
    await user.click(within(consultationRegion).getByRole('button', { name: '向患者提问' }))

    const pendingButton = await screen.findByRole('button', { name: '正在等待患者回答' })
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true)
    expect(within(consultationRegion).getByText('除了发热，还有哪里不舒服？')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('患者正在输入')
    await act(async () => releaseAnswer?.())
    expect(await screen.findByText('咽痛，吞咽时更明显，没有气促。')).toBeTruthy()
    expect(screen.getByText('昨天傍晚开始发热，最高量到 38.7 °C。')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    const record = await screen.findByRole('region', { name: '结构化病历' })
    expect(record).toBeTruthy()
    if (!hasTriage) {
      expect((within(record).getByLabelText('主诉') as HTMLTextAreaElement).value).toBe('')
      expect((within(record).getByLabelText('查体') as HTMLTextAreaElement).value).toBe('')
    }
    expect(screen.queryByText('咽痛，吞咽时更明显，没有气促。')).toBeNull()
    await user.click(screen.getByRole('tab', { name: '问诊记录' }))
    expect(await screen.findByText('咽痛，吞咽时更明显，没有气促。')).toBeTruthy()
  })

  it('keeps the Consultation Record visible when a question version conflicts', async () => {
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    const question = { code: 'symptom-onset', text: '什么时候开始发热？' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-direct',
            encounterId: 'encounter-direct',
            encounterVersion: '1',
            patient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-direct',
            taskVersion: '1',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-direct') {
        return Response.json({
          allergies: [],
          caseId: 'case-direct',
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-direct', status: 'in-progress', versionId: '1' },
          patient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-direct',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-direct/actions/ask-consultation-question') {
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            message: 'The Consultation Record version has changed',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '问诊记录' }))
    await user.type(await screen.findByRole('textbox', { name: '向患者提问' }), question.text)
    await user.click(screen.getByRole('button', { name: '向患者提问' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByText('当前业务状态或前置条件不满足，请核对病例信息后重试。')).toBeTruthy()
    expect(screen.getByText('暂无问诊记录')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '向患者提问' })).toBeTruthy()
  })

  it.each(['human', 'agent'])('clears the send error after retry succeeds and allows the next doctor message via %s', async sender => {
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => { if (registration === value) registration = undefined }
      },
    }
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    const question = { code: 'symptom-onset', text: '什么时候开始发热？' }
    let failed = false
    let recovered = false
    const doctorTurn = { id: 'doctor-turn', kind: 'text', messageText: question.text, personaRevision: null,
      recordedAt: '2026-09-16T09:00:00+08:00', reportReference: null, sequence: 1, source: 'doctor-typed', speaker: 'doctor' }
    const patientTurn = { ...doctorTurn, id: 'patient-turn', messageText: '昨天傍晚开始的。', personaRevision: 1, sequence: 2, source: 'patient-agent', speaker: 'patient' }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const agentResponse = doctorSurfaceAgentResponse(url.pathname, init)
      if (agentResponse !== undefined) return agentResponse
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-direct',
            encounterId: 'encounter-direct',
            encounterVersion: '1',
            patient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-direct',
            taskVersion: '1',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-direct') {
        return Response.json({
          allergies: [],
          caseId: 'case-direct',
          clinicalDocument: {
            draft: { ...structuredClinicalDocument, updatedAt: '2026-09-20T08:00:00Z', version: 1 },
            signed: [],
          },
          consultation: { turns: recovered ? [doctorTurn, patientTurn] : failed ? [doctorTurn] : [], version: recovered ? 3 : failed ? 2 : 1 },
          encounter: { id: 'encounter-direct', status: 'in-progress', versionId: '1' },
          patient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-direct',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-direct/actions/retry-consultation-reply') {
        recovered = true
        return Response.json(commandResponse({ caseId: 'case-direct', consultationVersion: 3, patientTurn }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-direct/actions/ask-consultation-question') {
        failed = true
        return Response.json({
          error: {
            code: 'CONSULTATION_REPLY_UNAVAILABLE',
            message: 'Patient reply temporarily unavailable',
          },
        }, { status: 503 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(sender === 'agent' ? <WebApp runtime={{
      mode: 'surface', surfaceAgent, surfaceAgentStatus: 'active', surfaceSessionId: 'dsh-session-1',
    }} /> : <WebApp />)

    await user.click(await screen.findByRole('tab', { name: '问诊记录' }))
    if (sender === 'human') {
      await user.type(await screen.findByRole('textbox', { name: '向患者提问' }), question.text)
      await user.click(screen.getByRole('button', { name: '向患者提问' }))
      await user.click(await screen.findByRole('button', { name: '重试患者回答' }))
    } else {
      await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_ask_virtual_patient')).toBe(true))
      expect(registration?.tools.some(tool => tool.name === 'clinmesh_retry_patient_reply')).toBe(false)
      const ask = registration!.tools.find(tool => tool.name === 'clinmesh_ask_virtual_patient')!
      await act(async () => {
        await expect(ask.execute(boundAgentToolInput(ask, { message: question.text }), new AbortController().signal)).rejects.toThrow()
      })
      await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_retry_patient_reply')).toBe(true))
      expect(registration?.tools.some(tool => tool.name === 'clinmesh_ask_virtual_patient')).toBe(false)
      const retry = registration!.tools.find(tool => tool.name === 'clinmesh_retry_patient_reply')!
      await act(async () => {
        await retry.execute(boundAgentToolInput(retry, {}), new AbortController().signal)
      })
      await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_ask_virtual_patient')).toBe(true))
      expect(registration?.tools.some(tool => tool.name === 'clinmesh_retry_patient_reply')).toBe(false)
    }
    expect(await screen.findByText('昨天傍晚开始的。')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('textbox', { name: '向患者提问' }) as HTMLTextAreaElement).disabled).toBe(false)
  })

  it.each([false, true])('keeps ask registered after a successful reply and sends a second round with persisted document=%s', async persistedDocument => {
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => { if (registration === value) registration = undefined }
      },
    }
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    const question = { code: 'symptom-onset', text: '什么时候开始发热？' }
    let rounds = 0
    const versions: number[] = []
    let releaseQueue: (() => void) | undefined
    let queueGate: Promise<void> | undefined
    const doctorTurn = { id: 'doctor-turn', kind: 'text', messageText: question.text, personaRevision: null,
      recordedAt: '2026-09-16T09:00:00+08:00', reportReference: null, sequence: 1, source: 'doctor-typed', speaker: 'doctor' }
    const patientTurn = { ...doctorTurn, id: 'patient-turn', messageText: '昨天傍晚开始的。', personaRevision: 1, sequence: 2, source: 'patient-agent', speaker: 'patient' }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const agentResponse = doctorSurfaceAgentResponse(url.pathname, init)
      if (agentResponse !== undefined) return agentResponse
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        await queueGate
        return Response.json({
          items: [{
            caseId: 'case-direct',
            encounterId: 'encounter-direct',
            encounterVersion: '1',
            patient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-direct',
            taskVersion: '1',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-direct') {
        return Response.json({
          allergies: [],
          caseId: 'case-direct',
          clinicalDocument: persistedDocument ? {
            draft: { ...structuredClinicalDocument, updatedAt: '2026-09-20T08:00:00Z', version: 1 },
            signed: [],
          } : undefined,
          consultation: { turns: rounds > 0 ? [doctorTurn, patientTurn] : [], version: 1 + rounds * 2 },
          encounter: { id: 'encounter-direct', status: 'in-progress', versionId: '1' },
          patient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-direct',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-direct/actions/ask-consultation-question') {
        const body = JSON.parse(String(init?.body))
        versions.push(body.input.expectedConsultationVersion)
        rounds += 1
        queueGate = new Promise<void>(resolve => { releaseQueue = resolve })
        return Response.json(commandResponse({ caseId: 'case-direct', consultationVersion: 1 + rounds * 2, doctorTurn, patientTurn }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    render(<WebApp runtime={{
      mode: 'surface', surfaceAgent, surfaceAgentStatus: 'active', surfaceSessionId: 'dsh-session-1',
    }} />)
    await userEvent.setup().click(await screen.findByRole('tab', { name: '问诊记录' }))
    for (let round = 0; round < 2; round += 1) {
      await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_ask_virtual_patient')).toBe(true))
      const ask = registration!.tools.find(tool => tool.name === 'clinmesh_ask_virtual_patient')!
      let execution: ReturnType<WebSurfaceAgentTool['execute']> | undefined
      act(() => {
        execution = ask.execute(boundAgentToolInput(ask, { message: question.text }), new AbortController().signal)
      })
      await waitFor(() => expect(releaseQueue).toBeDefined())
      await waitFor(() => expect(screen.getByText('昨天傍晚开始的。')).toBeTruthy())
      expect((screen.getByRole('textbox', { name: '向患者提问' }) as HTMLTextAreaElement).disabled).toBe(true)
      await act(async () => { releaseQueue?.(); releaseQueue = undefined; await execution })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
      expect((screen.getByRole('textbox', { name: '向患者提问' }) as HTMLTextAreaElement).disabled).toBe(false)
      await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_ask_virtual_patient')).toBe(true))
    }
    expect(versions).toEqual([1, 3])
  })

  it('shows the doctor queue without the retired Virtual Patient entry point', async () => {
    stubEmptyDoctorWorkspace()

    render(<WebApp />)

    await screen.findAllByText('当前没有在诊病例')
    await userEvent.setup().click(await screen.findByRole('tab', { name: '待诊' }))
    expect(await screen.findAllByText('当前无待诊病例')).toBeTruthy()
    expect(screen.getByText('已完成的交接会从当前队列移除。')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /候选患者/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(forbiddenChineseClinicalUiTerms)
  })

  it.each([false, true])('switches every doctor section through authorized Tools with shadow DOM=%s', async shadow => {
    window.history.replaceState(null, '', '/consultation')
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => { if (registration === value) registration = undefined }
      },
    }
    const patient = {
      id: 'patient-1', identifier: 'CM-SYN-001', name: '合成测试患者',
      birthDate: '1988-03-16', gender: 'female', synthetic: true, versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const agentResponse = doctorSurfaceAgentResponse(path, init)
      if (agentResponse !== undefined) return agentResponse
      if (path === '/api/auth/context') return Response.json(doctorSession)
      if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [], medications: [], prescriptionConclusionSupported: true })
      if (path === '/api/his/v1/doctor/queue') return Response.json({
        items: [{ caseId: 'case-1', encounterId: 'encounter-1', encounterVersion: '1',
          patient, presentation: doctorPresentation, status: 'first-visit', taskId: 'task-1', taskVersion: '1' }],
        ...pagination(1),
      })
      if (path === '/api/his/v1/doctor/cases/case-1') return Response.json({
        allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
        encounter: { id: 'encounter-1', status: 'in-progress', versionId: '1' },
        patient, presentation: doctorPresentation, priorFacts: [], status: 'first-visit',
        taskId: 'task-1', taskVersion: '1',
      })
      throw new Error(`Unexpected request: ${path}`)
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const container = document.createElement('div')
    const root = shadow ? host.attachShadow({ mode: 'open' }) : host
    root.append(container)
    const view = render(<WebApp runtime={{
      mode: 'surface', surfaceAgent, surfaceAgentStatus: 'active', surfaceSessionId: 'dsh-session-1',
    }} />, { container })
    const queries = within(container)
    try {
      await queries.findByRole('tab', { name: '病历记录' })
      for (const { section, label } of [
        { section: 'consultation', label: '问诊记录' }, { section: 'record', label: '病历记录' },
        { section: 'diagnosis', label: '诊断' }, { section: 'prescription', label: '处方' },
        { section: 'laboratory', label: '检验' },
      ]) {
        await waitFor(() => expect(registration?.tools.some(tool => tool.name === 'clinmesh_select_doctor_section')).toBe(true))
        const tool = registration!.tools.find(tool => tool.name === 'clinmesh_select_doctor_section')!
        await act(async () => {
          await tool.execute(boundAgentToolInput(tool, { section }), new AbortController().signal)
        })
        await waitFor(() => expect(queries.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true'))
        expect(queries.getByRole('tabpanel', { name: label }).getAttribute('data-agent-section')).toBe(section)
      }
    } finally {
      view.unmount()
      host.remove()
    }
  })

  it.each([false, true])('discovers another queue patient and switches through authorized Tools with shadow DOM=%s', async shadow => {
    window.history.replaceState(null, '', '/consultation')
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => { if (registration === value) registration = undefined }
      },
    }
    const patient = {
      id: 'patient-1', identifier: 'CM-SYN-001', name: '合成测试患者',
      birthDate: '1988-03-16', gender: 'female', synthetic: true, versionId: '1',
    }
    const queueItems = [1, 2].map(index => ({
      caseId: 'case-' + index, encounterId: 'encounter-' + index, encounterVersion: '1',
      patient: { ...patient, id: 'patient-' + index, name: '合成测试患者' + index },
      presentation: doctorPresentation, status: index === 1 ? 'first-visit' : 'awaiting-doctor', taskId: 'task-' + index, taskVersion: '1',
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const agentResponse = doctorSurfaceAgentResponse(path, init)
      if (agentResponse !== undefined) return agentResponse
      if (path === '/api/auth/context') return Response.json(doctorSession)
      if (path === '/api/his/v1/catalogs/clinical') return Response.json({ laboratory: [], medications: [], prescriptionConclusionSupported: true })
      if (path === '/api/his/v1/doctor/queue') {
        const queueView = new URL(String(input), 'http://localhost').searchParams.get('view')
        const items = queueView === 'active' ? [queueItems[0]] : queueView === 'waiting' ? [queueItems[1]] : queueItems
        return Response.json({ items, ...pagination(items.length) })
      }
      const item = queueItems.find(item => path === '/api/his/v1/doctor/cases/' + item.caseId)
      if (item) return Response.json({
        ...item, allergies: [], consultation: { turns: [], version: 1 },
        encounter: { id: item.encounterId, status: 'in-progress', versionId: '1' }, priorFacts: [],
      })
      throw new Error(`Unexpected request: ${path}`)
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const container = document.createElement('div')
    const root = shadow ? host.attachShadow({ mode: 'open' }) : host
    root.append(container)
    const view = render(<WebApp runtime={{
      mode: 'surface', surfaceAgent, surfaceAgentStatus: 'active', surfaceSessionId: 'dsh-session-1',
    }} />, { container })
    const queries = within(container)
    try {
      await queries.findByRole('tab', { name: '病历记录' })
      const call = async (name: string, input = {}) => {
        await waitFor(() => expect(registration?.tools.some(tool => tool.name === name)).toBe(true))
        const tool = registration!.tools.find(tool => tool.name === name)!
        let result = ''
        await act(async () => { result = await tool.execute(boundAgentToolInput(tool, input), new AbortController().signal) })
        return JSON.parse(result).data
      }
      const context = await call('clinmesh_read_current_context')
      for (const tool of registration!.tools) expect(tool.description.length, tool.name).toBeLessThanOrEqual(512)
      expect(context.pageState.queue).toMatchObject({ items: queueItems, ...pagination(2) })
      const doctor = await call('clinmesh_read_doctor_context')
      expect(doctor.queue).toEqual(context.pageState.queue)
      expect(doctor.caseId).toBe('case-1')
      const target = doctor.queue.items.find((item: { patient: { name: string } }) => item.patient.name === '合成测试患者2')
      expect(target).toBeDefined()
      await expect(call('clinmesh_select_doctor_case', { caseId: 'outside-current-page' })).rejects.toThrow('Case is not in the current doctor queue')
      await call('clinmesh_select_doctor_case', { caseId: target.caseId })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
      const selected = await call('clinmesh_read_doctor_context')
      expect(selected.caseId).toBe('case-2')
      expect(selected.patient.name).toBe('合成测试患者2')
      expect(selected.queue.items).toEqual(queueItems)
      expect(queries.getByRole('tab', { name: '待诊' }).getAttribute('aria-selected')).toBe('true')
    } finally {
      view.unmount()
      host.remove()
    }
  })

  it('narrows an empty doctor page to common Tools while validating every grant', async () => {
    stubEmptyDoctorWorkspace()
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }

    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    const expected = [
      'clinmesh_read_current_context',
      'clinmesh_navigate',
      'clinmesh_focus_panel',
    ]
    await waitFor(() => expect(registration?.tools.map(tool => tool.name)).toEqual(expected))
  })

  it('uses clinical operator language for the English doctor empty state', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'light',
    }))
    stubEmptyDoctorWorkspace()

    render(<WebApp />)

    await screen.findAllByText('No cases in care')
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Waiting' }))
    expect(await screen.findAllByText('No cases awaiting consultation')).toBeTruthy()
    expect(screen.getByText('Completed handoffs leave the active queue.')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /Candidate patients/ })).toBeNull()
    expect(screen.getByRole('main').textContent).not.toMatch(forbiddenEnglishClinicalUiTerms)
  })


  it('hydrates an Agent laboratory draft from the case catalog without reverse autosave', async () => {
    window.history.replaceState(null, '', '/consultation')
    const laboratoryQueries: Array<string | null> = []
    const referenceConcept = {
      code: '58410-2',
      display: '血常规组合',
      id: 'loinc:synthetic:58410-2',
      sourceLocator: 'concepts[3]',
      system: 'http://loinc.org',
      version: '2.83',
    }
    const laboratoryService = {
      allowedIndicationCodes: ['clinical-evaluation'],
      componentServiceIds: ['hospital-laboratory-service-wbc'],
      doctorOrderable: true as const,
      executingDepartmentId: 'department-laboratory',
      id: 'hospital-laboratory-service-cbc',
      localCode: 'CM-LAB-58410-2',
      nameEn: 'Complete blood count',
      nameZh: '血常规',
      priceFen: 2500,
      referenceConcept,
      referenceReleaseId: 'reference-http-test-v1',
      reportDefinition: {
        conclusionTemplate: '血常规结果已完成。',
        results: [{
          referenceConcept: {
            code: '6690-2',
            display: '白细胞计数',
            id: 'loinc:synthetic:6690-2',
            sourceLocator: 'concepts[4]',
            system: 'http://loinc.org',
            version: '2.83',
          },
          referenceRange: { high: 10, low: 4, text: '4.0-10.0 x10^9/L' },
          unit: {
            code: '10*9/L',
            display: '10*9/L',
            system: 'http://unitsofmeasure.org' as const,
          },
          valueType: 'quantity' as const,
        }],
      },
      specimen: { code: 'LP7057-5', display: '血液' },
      serviceKind: 'laboratory' as const,
      tatMinutes: 20,
      version: 1,
    }
    const agentReferenceConcept = {
      code: '1988-5',
      display: 'C 反应蛋白',
      id: 'loinc:synthetic:1988-5',
      sourceLocator: 'concepts[5]',
      system: 'http://loinc.org',
      version: '2.83',
    }
    const agentLaboratoryService = {
      ...laboratoryService,
      componentServiceIds: [],
      id: 'hospital-laboratory-service-crp',
      localCode: 'CM-LAB-1988-5',
      nameEn: 'C-reactive protein',
      nameZh: 'C 反应蛋白',
      priceFen: 4300,
      referenceConcept: agentReferenceConcept,
      reportDefinition: {
        conclusionTemplate: 'C 反应蛋白结果已完成。',
        results: [{
          referenceConcept: agentReferenceConcept,
          referenceRange: { high: 8, low: 0, text: '0-8 mg/L' },
          unit: {
            code: 'mg/L',
            display: 'mg/L',
            system: 'http://unitsofmeasure.org' as const,
          },
          valueType: 'quantity' as const,
        }],
      },
      specimen: { code: 'LP7567-4', display: '血清' },
    }
    let draft: {
      catalogItemId: string
      indicationCode: string
      laboratoryService: typeof laboratoryService
      referenceConcept: typeof referenceConcept
    } | undefined
    let draftVersion = 0
    let draftSaves = 0
    let persistedDraftContextId: string | undefined
    let request: {
      catalogItemId: string
      id: string
      indicationCode: string
      laboratoryService: typeof laboratoryService
      previousReports: []
      referenceConcept: typeof referenceConcept
      serviceRequestId: string
      serviceRequestVersion: string
      status: 'issued'
      taskId: string
      taskVersion: string
      version: number
    } | undefined
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-virtual-1',
      identifier: 'CM-SYN-VP-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/agent/v1/page-contexts' && draftVersion === 1) {
        const request = JSON.parse(String(init?.body)) as { claim: { viewRevision: string } }
        persistedDraftContextId = `context-${request.claim.viewRevision}`
      }
      const agentResponse = doctorSurfaceAgentResponse(url.pathname, init)
      if (agentResponse !== undefined) return agentResponse
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-1/reference-catalogs/laboratory') {
        laboratoryQueries.push(url.searchParams.get('query'))
        return Response.json({
          items: [laboratoryService, agentLaboratoryService],
          page: 1,
          pageSize: 20,
          total: 2,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-virtual-1',
            encounterId: 'encounter-virtual-1',
            encounterVersion: '1',
            patient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-virtual-1',
            taskVersion: '1',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-virtual-1',
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-virtual-1', status: 'in-progress', versionId: '1' },
          laboratoryRequests: {
            ...(draft === undefined ? {} : { draft }),
            draftVersion,
            reportingSupported: true,
            requests: request === undefined ? [] : [request],
          },
          patient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-virtual-1',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-virtual-1/laboratory-request/draft') {
        draftSaves += 1
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: {
            catalogItemId: string
            expectedDraftVersion: number
            indicationCode: string
          }
        }
        expect(init?.method).toBe('PUT')
        expect(body.expectedVersions).toEqual({ 'Encounter/encounter-virtual-1': '1' })
        expect(body.input.expectedDraftVersion).toBe(draftVersion)
        const selectedService = [laboratoryService, agentLaboratoryService].find(candidate => (
          candidate.id === body.input.catalogItemId
        ))
        if (selectedService === undefined) throw new Error('Hospital Laboratory Service was not found')
        draft = {
          catalogItemId: body.input.catalogItemId,
          indicationCode: body.input.indicationCode,
          laboratoryService: selectedService,
          referenceConcept: selectedService.referenceConcept,
        }
        draftVersion += 1
        return Response.json(commandResponse({ caseId: 'case-virtual-1', draftVersion }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-virtual-1/laboratory-request/actions/issue') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: { expectedDraftVersion: number }
        }
        expect(body.expectedVersions).toEqual({ 'Encounter/encounter-virtual-1': '1' })
        expect(body.input.expectedDraftVersion).toBe(draftVersion)
        const issuedDraft = draft
        if (issuedDraft === undefined) throw new Error('Laboratory draft was not found')
        draft = undefined
        draftVersion += 1
        request = {
          catalogItemId: issuedDraft.catalogItemId,
          id: 'laboratory-request-crp-1',
          indicationCode: issuedDraft.indicationCode,
          laboratoryService: issuedDraft.laboratoryService,
          previousReports: [],
          referenceConcept: issuedDraft.referenceConcept,
          serviceRequestId: 'service-request-crp-1',
          serviceRequestVersion: '1',
          status: 'issued',
          taskId: 'task-laboratory-crp-1',
          taskVersion: '1',
          version: 1,
        }
        return Response.json(commandResponse({
          caseId: 'case-virtual-1',
          draftVersion,
          request,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    await user.click(await screen.findByRole('tab', { name: '检验' }))
    const requestRegion = await screen.findByRole('region', { name: '检验申请' })
    const resultsRegion = screen.getByRole('region', { name: '检验结果' })
    expect(screen.queryByRole('tab', { name: '检验检查' })).toBeNull()
    expect(within(resultsRegion).getByText('暂无检验申请或结果')).toBeTruthy()
    await user.click(within(requestRegion).getByRole('button', { name: '选择检验项目' }))
    const laboratoryDialog = await screen.findByRole('dialog', { name: '选择检验项目' })
    await user.type(within(laboratoryDialog).getByLabelText('搜索检验目录'), '血常')
    await user.click(within(laboratoryDialog).getByRole('button', { name: '执行检验目录搜索' }))
    await waitFor(() => expect(laboratoryQueries).toContain('血常'))
    expect(within(laboratoryDialog).queryByText('当前病例')).toBeNull()
    expect(within(laboratoryDialog).queryByText('当前病例不可生成')).toBeNull()
    expect(within(laboratoryDialog).queryByText('可开立')).toBeNull()
    expect(within(laboratoryDialog).queryByText('体温')).toBeNull()
    await user.click(await within(laboratoryDialog).findByRole('button', {
      name: '选择 血常规 58410-2',
    }))
    await user.click(within(laboratoryDialog).getByRole('button', { name: '确定选择' }))
    expect(await screen.findByText('血常规')).toBeTruthy()
    expect(within(requestRegion).queryByRole('combobox', { name: '检验适应证' })).toBeNull()
    expect(within(requestRegion).getByText('临床评估')).toBeTruthy()
    expect(within(requestRegion).queryByRole('button', { name: '保存检验草稿' })).toBeNull()
    expect(await screen.findByText('草稿已自动保存')).toBeTruthy()
    const savedRequestRegion = screen.getByRole('region', { name: '检验申请' })
    expect(within(savedRequestRegion).getByText('草稿已自动保存')).toBeTruthy()
    await waitFor(() => {
      const tool = registration?.tools.find(candidate => (
        candidate.name === 'clinmesh_fill_laboratory_draft'
      ))
      expect(tool).toBeDefined()
      expect(boundAgentToolInput(tool!, {}).contextId).toBe(persistedDraftContextId)
    })
    const fillLaboratory = registration!.tools.find(candidate => (
      candidate.name === 'clinmesh_fill_laboratory_draft'
    ))!
    expect((fillLaboratory.parameters as {
      properties: Record<string, unknown>
    }).properties.catalogItemId).toEqual({ type: 'string' })
    await act(async () => {
      await fillLaboratory.execute(boundAgentToolInput(fillLaboratory, {
        catalogItemId: agentLaboratoryService.id,
        indicationCode: 'clinical-evaluation',
      }), new AbortController().signal)
    })
    expect(await screen.findByText(agentReferenceConcept.display)).toBeTruthy()
    await act(async () => new Promise(resolve => setTimeout(resolve, 900)))
    expect(draft).toMatchObject({ catalogItemId: agentLaboratoryService.id })
    expect(draftSaves).toBe(2)
    const hydratedRequestRegion = screen.getByRole('region', { name: '检验申请' })
    await user.click(within(hydratedRequestRegion).getByRole('button', { name: '开具检验申请' }))

    expect(await screen.findByRole('cell', { name: agentReferenceConcept.display })).toBeTruthy()
    const issuedResultsRegion = screen.getByRole('region', { name: '检验结果' })
    expect(within(issuedResultsRegion).getByRole('cell', { name: agentReferenceConcept.display })).toBeTruthy()
    expect(within(issuedResultsRegion).getByText('已开具')).toBeTruthy()
    const contextRail = screen.getByRole('complementary', { name: '病例上下文' })
    expect(within(contextRail).getByRole('heading', { name: '检验概况' })).toBeTruthy()
    expect(within(contextRail).getByText('1 项申请')).toBeTruthy()
    expect(within(contextRail).getByText('暂无待阅报告')).toBeTruthy()
  })

  it('shows laboratory request statuses and exposes only valid correction actions', async () => {
    window.history.replaceState(null, '', '/consultation')
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    let cancellationRequests = 0
    let draftDeletionRequests = 0
    let draft: { catalogItemId: string; indicationCode: string } | undefined = {
      catalogItemId: 'lab-cbc',
      indicationCode: 'fever',
    }
    let draftVersion = 1
    const request = (
      status: 'accepted' | 'acknowledged' | 'cancelled' | 'generation-failed' | 'in-progress' | 'issued' | 'reported',
      index: number,
    ): LaboratoryRequest => ({
      catalogItemId: index % 2 === 0 ? 'lab-cbc' : 'lab-crp',
      id: `laboratory-request-${index}`,
      indicationCode: 'fever',
      previousReports: [],
      serviceRequestId: `service-request-${index}`,
      serviceRequestVersion: '1',
      status,
      taskId: `task-laboratory-${index}`,
      taskVersion: status === 'issued' ? '1' : status === 'generation-failed' ? '4' : '2',
      version: status === 'issued' ? 1 : status === 'generation-failed' ? 4 : 2,
    })
    const reportedRequest: LaboratoryRequest = {
      ...request('reported', 4),
      report: {
        conclusion: '白细胞计数升高，其余血常规指标在参考范围内。',
        diagnosticReportId: 'diagnostic-report-cbc-1',
        diagnosticReportVersion: '1',
        issuedAt: '2026-08-24T09:00:00+08:00',
        revisionNumber: 1,
        results: [{
          code: '6690-2',
          display: '白细胞计数',
          interpretation: 'high',
          observationId: 'observation-wbc-1',
          referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5 x10^9/L' },
          unit: {
            code: '10*9/L',
            display: '10^9/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 11.2,
        }, {
          code: '718-7',
          display: '血红蛋白',
          interpretation: 'normal',
          observationId: 'observation-hgb-1',
          referenceRange: { high: 150, low: 115, text: '115-150 g/L' },
          unit: {
            code: 'g/L',
            display: 'g/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 135,
        }],
        specimenId: 'specimen-cbc-1',
        status: 'final',
      },
    }
    const acknowledgedRequest: LaboratoryRequest = {
      ...request('acknowledged', 5),
      previousReports: [{
        conclusion: 'C 反应蛋白升高。',
        diagnosticReportId: 'diagnostic-report-crp-previous',
        diagnosticReportVersion: '1',
        issuedAt: '2026-08-24T08:55:00+08:00',
        revisionNumber: 1,
        results: [{
          code: '1988-5',
          display: 'C 反应蛋白',
          interpretation: 'high',
          observationId: 'observation-crp-previous',
          referenceRange: { high: 8, low: 3, text: '3-8 mg/L' },
          unit: {
            code: 'mg/L',
            display: 'mg/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 12,
        }],
        specimenId: 'specimen-crp-1',
        status: 'final',
      }],
      report: {
        acknowledgement: {
          acknowledgedAt: '2026-08-24T09:05:00+08:00',
          acknowledgedBy: 'practitioner-outpatient-doctor',
          id: 'acknowledgement-crp-1',
        },
        conclusion: '复核后 C 反应蛋白正常。',
        diagnosticReportId: 'diagnostic-report-crp-1',
        diagnosticReportVersion: '1',
        issuedAt: '2026-08-24T09:00:00+08:00',
        revisionNumber: 2,
        revisionOfDiagnosticReportId: 'diagnostic-report-crp-previous',
        revisionReason: '复核仪器原始数据。',
        results: [{
          code: '1988-5',
          display: 'C 反应蛋白',
          interpretation: 'normal',
          observationId: 'observation-crp-1',
          referenceRange: { high: 8, low: 3, text: '3-8 mg/L' },
          unit: {
            code: 'mg/L',
            display: 'mg/L',
            system: 'http://unitsofmeasure.org',
          },
          value: 6,
        }],
        specimenId: 'specimen-crp-1',
        status: 'final',
      },
    }
    const generationFailedRequest: LaboratoryRequest = {
      ...request('generation-failed', 7),
      generationError: {
        code: 'INVESTIGATION_OUTPUT_INVALID',
        message: '模型判读与参考范围冲突',
      },
    }
    const unsupportedGenerationRequest: LaboratoryRequest = {
      ...request('generation-failed', 8),
      generationError: {
        code: 'INVESTIGATION_UNSUPPORTED',
        message: 'The requested investigation cannot be generated by the structured Investigation Agent',
      },
    }
    let requests: LaboratoryRequest[] = [
      request('issued', 1),
      request('accepted', 2),
      request('in-progress', 3),
      reportedRequest,
      acknowledgedRequest,
      request('cancelled', 6),
      generationFailedRequest,
      unsupportedGenerationRequest,
    ]
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-virtual-1',
      identifier: 'CM-SYN-VP-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    const otherPatient = {
      birthDate: '1979-11-08',
      gender: 'male',
      id: 'patient-virtual-2',
      identifier: 'CM-SYN-VP-002',
      name: '合成候选患者周远',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const agentResponse = doctorSurfaceAgentResponse(url.pathname, init)
      if (agentResponse !== undefined) return agentResponse
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [{
            allowedIndicationCodes: ['fever'],
            contraindicatedAllergyCodes: [],
            id: 'lab-cbc',
            nameEn: 'Complete blood count',
            nameZh: '血常规',
            priceFen: 2500,
            version: 1,
          }, {
            allowedIndicationCodes: ['fever'],
            contraindicatedAllergyCodes: [],
            id: 'lab-crp',
            nameEn: 'C-reactive protein',
            nameZh: 'C 反应蛋白',
            priceFen: 4300,
            version: 1,
          }],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-virtual-1',
            encounterId: 'encounter-virtual-1',
            encounterVersion: '1',
            patient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-virtual-1',
            taskVersion: '1',
          }, {
            caseId: 'case-virtual-2',
            encounterId: 'encounter-virtual-2',
            encounterVersion: '1',
            patient: otherPatient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-virtual-2',
            taskVersion: '1',
          }],
          ...pagination(2),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-virtual-1',
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-virtual-1', status: 'in-progress', versionId: '1' },
          laboratoryRequests: {
            ...(draft === undefined ? {} : { draft }),
            draftVersion,
            reportingSupported: true,
            requests,
          },
          patient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-virtual-1',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-2') {
        return Response.json({
          allergies: [],
          caseId: 'case-virtual-2',
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-virtual-2', status: 'in-progress', versionId: '1' },
          laboratoryRequests: {
            draftVersion: 2,
            reportingSupported: true,
            requests: [],
          },
          patient: otherPatient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-virtual-2',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/laboratory-requests/laboratory-request-1/actions/cancel') {
        cancellationRequests += 1
        const body = JSON.parse(String(init?.body)) as unknown
        expect(body).toEqual({
          expectedVersions: {
            'ServiceRequest/service-request-1': '1',
            'Task/task-laboratory-1': '1',
          },
          input: { expectedRequestVersion: 1, reasonCode: 'no-longer-needed' },
        })
        if (cancellationRequests === 1) {
          return Response.json({
            error: {
              code: 'LABORATORY_REQUEST_NOT_CANCELLABLE',
              conflict: {
                currentStatus: 'accepted',
                currentVersion: '2',
                owner: 'laboratory-request',
                resource: 'LaboratoryRequest/laboratory-request-1',
              },
              message: 'The laboratory request cannot be cancelled from status "accepted"',
            },
          }, { status: 409 })
        }
        const issuedRequest = requests.find(request => request.id === 'laboratory-request-1')
        if (issuedRequest === undefined) throw new Error('Issued laboratory request was not found')
        const cancelled = {
          ...issuedRequest,
          serviceRequestVersion: '2',
          status: 'cancelled' as const,
          taskVersion: '2',
          version: 2,
        }
        requests = requests.map(request => request.id === cancelled.id ? cancelled : request)
        return Response.json(commandResponse({ request: cancelled }))
      }
      if (url.pathname === '/api/his/v1/laboratory-requests/laboratory-request-4/reports/diagnostic-report-cbc-1/actions/acknowledge') {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'DiagnosticReport/diagnostic-report-cbc-1': '1' },
          input: { expectedRequestVersion: 2 },
        })
        const current = requests.find(request => request.id === 'laboratory-request-4')
        if (current?.report === undefined) throw new Error('Reported laboratory request was not found')
        const acknowledged = {
          ...current,
          report: {
            ...current.report,
            acknowledgement: {
              acknowledgedAt: '2026-08-24T09:06:00+08:00',
              acknowledgedBy: 'practitioner-outpatient-doctor',
              id: 'acknowledgement-cbc-1',
            },
          },
          status: 'acknowledged' as const,
          version: 3,
        }
        requests = requests.map(request => request.id === acknowledged.id ? acknowledged : request)
        return Response.json(commandResponse({
          acknowledgementId: acknowledged.report.acknowledgement.id,
          acknowledgedAt: acknowledged.report.acknowledgement.acknowledgedAt,
          acknowledgedBy: acknowledged.report.acknowledgement.acknowledgedBy,
          diagnosticReportId: acknowledged.report.diagnosticReportId,
          requestId: acknowledged.id,
          requestVersion: acknowledged.version,
          status: acknowledged.status,
        }))
      }
      if (url.pathname === '/api/his/v1/laboratory-requests/laboratory-request-7/actions/retry-generation') {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Task/task-laboratory-7': '4' },
          input: { expectedRequestVersion: 4 },
        })
        const retried = {
          ...generationFailedRequest,
          generationError: undefined,
          status: 'in-progress' as const,
          taskVersion: '5',
          version: 5,
        }
        const { generationError: _removed, ...withoutError } = retried
        requests = requests.map(request => request.id === withoutError.id ? withoutError : request)
        return Response.json(commandResponse({ request: withoutError }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-virtual-1/laboratory-request/draft') {
        draftDeletionRequests += 1
        expect(init?.method).toBe('DELETE')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-virtual-1': '1' },
          input: { expectedDraftVersion: 1 },
        })
        draft = undefined
        draftVersion = 2
        return Response.json(commandResponse({ caseId: 'case-virtual-1', draftVersion }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('已开具')).toBeTruthy()
    for (const label of ['已受理', '执行中', '已报告', '已取消']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByText('医生已阅')).toHaveLength(2)
    expect(screen.getByText('等待检验结果')).toBeTruthy()
    expect(screen.getAllByText('结果生成失败')).toHaveLength(2)
    expect(screen.getByText('该病例缺少此检验的合成结果底账，无法生成结果。')).toBeTruthy()
    expect(screen.getByText('生成结果未通过校验，请重试。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重试结果生成 血常规/ })).toBeNull()
    expect(screen.getByRole('button', { name: /重试结果生成 C 反应蛋白/ })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /重试结果生成 C 反应蛋白/ }))
    await waitFor(() => expect(screen.queryByText('生成结果未通过校验，请重试。')).toBeNull())
    expect(screen.queryByRole('button', { name: /重试结果生成 血常规/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /重试结果生成 C 反应蛋白/ })).toBeNull()
    expect(screen.getByText('白细胞计数升高，其余血常规指标在参考范围内。')).toBeTruthy()
    expect(screen.getByRole('cell', { name: /11\.2 10\^9\/L/ })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '3.5-9.5 x10^9/L' })).toBeTruthy()
    expect(screen.getAllByText('偏高')).toHaveLength(2)
    expect(screen.getAllByText('正常')).toHaveLength(2)
    expect(screen.getByText('第 2 版（当前）')).toBeTruthy()
    expect(screen.getByText('第 1 版（已替代）')).toBeTruthy()
    expect(screen.getByText('C 反应蛋白升高。')).toBeTruthy()
    expect(screen.getByText('复核后 C 反应蛋白正常。')).toBeTruthy()
    const acknowledgeButton = screen.getByRole('button', { name: '确认已阅 血常规' })
    await user.click(acknowledgeButton)
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认已阅 血常规' })).toBeNull())
    const cancelButtons = screen.getAllByRole('button', { name: /取消检验申请/ })
    expect(cancelButtons).toHaveLength(1)
    expect(cancelButtons[0]?.getAttribute('aria-label')).toBe('取消检验申请 C 反应蛋白')

    await user.click(cancelButtons[0] as HTMLElement)
    const cancelDialog = await screen.findByRole('alertdialog', { name: '确认取消检验申请' })
    expect(cancellationRequests).toBe(0)
    expect(within(cancelDialog).getByText('C 反应蛋白')).toBeTruthy()
    expect(within(cancelDialog).getByText('已开具')).toBeTruthy()
    await user.click(within(cancelDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText(
      '检验申请当前状态为“已受理”，版本为 2。请刷新后重新确认。',
    )).toBeTruthy()
    expect(screen.queryByText(/The laboratory request cannot be cancelled/)).toBeNull()
    expect(cancellationRequests).toBe(1)

    await user.click(within(cancelDialog).getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '选择病例 合成候选患者周远' }))
    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('暂无检验申请或结果')).toBeTruthy()
    expect(screen.queryByText(
      '检验申请当前状态为“已受理”，版本为 2。请刷新后重新确认。',
    )).toBeNull()

    await user.click(screen.getByRole('button', { name: '选择病例 合成候选患者林晓' }))
    await user.click(await screen.findByRole('tab', { name: '检验' }))
    const retryCancelButton = (await screen.findAllByRole('button', { name: /取消检验申请/ }))[0]
    if (retryCancelButton === undefined) throw new Error('Cancellable request was not restored')
    await user.click(retryCancelButton)
    const retryCancelDialog = await screen.findByRole('alertdialog', { name: '确认取消检验申请' })
    await user.click(within(retryCancelDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText('检验申请已取消')).toBeTruthy()
    expect(cancellationRequests).toBe(2)
    await waitFor(() => expect(screen.queryByText('已开具')).toBeNull())
    await user.click(screen.getByRole('button', { name: '删除检验草稿' }))
    const deleteDialog = await screen.findByRole('alertdialog', { name: '确认删除检验草稿' })
    expect(draftDeletionRequests).toBe(0)
    expect(within(deleteDialog).getByText('血常规')).toBeTruthy()
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('检验草稿已删除')).toBeTruthy()
    expect(draftDeletionRequests).toBe(1)
    await waitFor(() => expect(screen.queryByText('草稿已自动保存')).toBeNull())

    await user.click(screen.getByRole('button', { name: '选择病例 合成候选患者周远' }))
    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('暂无检验申请或结果')).toBeTruthy()
    expect(screen.queryByText('检验草稿已删除')).toBeNull()
  })

  it('keeps polling an in-progress laboratory request until its report arrives', async () => {
    window.history.replaceState(null, '', '/consultation')
    const polling = stubLaboratoryReportPolling(true)
    render(<WebApp />)

    await userEvent.setup().click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('等待检验结果')).toBeTruthy()
    polling.makeReportReady()
    await waitFor(() => {
      expect(screen.getByText('C 反应蛋白升高。')).toBeTruthy()
    }, { timeout: 3_000 })
    const referenceRangeCell = screen.getByRole('cell', { name: '0-8 mg/L' })
    expect(referenceRangeCell.className).toContain('whitespace-normal')
    expect(referenceRangeCell.closest('table')?.className).toContain('table-fixed')
    expect(screen.queryByText('等待检验结果')).toBeNull()
    expect(polling.detailRequestCount()).toBeGreaterThanOrEqual(2)
  })

  it('does not poll an in-progress request when Scenario reporting is unsupported', async () => {
    window.history.replaceState(null, '', '/consultation')
    const polling = stubLaboratoryReportPolling(false)
    render(<WebApp />)

    await userEvent.setup().click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('等待检验结果')).toBeTruthy()
    const initialDetailRequests = polling.detailRequestCount()
    await act(async () => new Promise(resolve => setTimeout(resolve, 1_700)))

    expect(polling.detailRequestCount()).toBe(initialDetailRequests)
  })

  it('starts the first visit, saves a CAS draft, and issues the laboratory order', async () => {
    window.history.replaceState(null, '', '/consultation')
    let status: 'awaiting-doctor' | 'awaiting-lab-payment' | 'first-visit' = 'awaiting-doctor'
    let draftVersion = 0
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const visitVersions = () => status === 'awaiting-doctor'
      ? { encounterVersion: '2', taskVersion: '1' }
      : { encounterVersion: '3', taskVersion: '2' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [{
            allowedIndicationCodes: ['fever'],
            contraindicatedAllergyCodes: [],
            id: 'lab-fever-panel',
            nameEn: 'Fever laboratory panel',
            nameZh: '发热检验组合',
            priceFen: 6800,
            version: 1,
          }],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        if (status === 'awaiting-lab-payment') {
          return Response.json({ items: [], ...pagination(0) })
        }
        return Response.json({
          items: [{
            caseId: 'case-1',
            encounterId: 'encounter-1',
            ...visitVersions(),
            patient,
            presentation: doctorPresentation,
            status,
            taskId: 'task-doctor-1',
            triage: doctorTriage,
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-1',
          ...(draftVersion === 0 ? {} : {
            drafts: {
              firstVisit: {
                assessment: '急性发热，待检验明确病原',
                historyOfPresentIllness: '两天前出现发热，伴咽痛。',
                version: draftVersion,
              },
            },
          }),
          encounter: {
            id: 'encounter-1',
            status: 'in-progress',
            versionId: visitVersions().encounterVersion,
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status,
          taskId: 'task-doctor-1',
          taskVersion: visitVersions().taskVersion,
          triage: doctorTriage,
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/start-first-visit') {
        const body = JSON.parse(String(init?.body)) as { expectedVersions: Record<string, string> }
        expect(body.expectedVersions).toEqual({
          'Encounter/encounter-1': '2',
          'Task/task-doctor-1': '1',
        })
        status = 'first-visit'
        return Response.json(commandResponse({ encounterVersion: '3', status, taskVersion: '2' }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/drafts/first-visit') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(init?.method).toBe('PUT')
        expect(body.expectedVersions).toEqual({ 'Encounter/encounter-1': '3' })
        expect(body.input).toEqual({
          assessment: '急性发热，待检验明确病原',
          expectedDraftVersion: 0,
          historyOfPresentIllness: '两天前出现发热，伴咽痛。',
        })
        draftVersion = 1
        return Response.json(commandResponse({ draftVersion }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/issue-laboratory-order') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body.expectedVersions).toEqual({
          'Encounter/encounter-1': '3',
          'Task/task-doctor-1': '2',
        })
        expect(body.input).toEqual({
          catalogItemId: 'lab-fever-panel',
          expectedDraftVersion: 1,
          indicationCode: 'fever',
        })
        status = 'awaiting-lab-payment'
        return Response.json(commandResponse({
          chargeItemId: 'charge-laboratory-1',
          encounterId: 'encounter-1',
          encounterVersion: '4',
          serviceRequestId: 'service-request-1',
          status,
          totalFen: 6800,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByText('门诊医生 · 门诊医生')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '选择病例 合成患者周明' })).toBeTruthy()
    const caseDetail = await screen.findByRole('region', { name: '病例详情' })
    expect(within(caseDetail).getByText('脉搏（次/分）')).toBeTruthy()
    expect(within(caseDetail).getByText('102')).toBeTruthy()
    expect(within(caseDetail).getByText('20')).toBeTruthy()
    expect(within(caseDetail).getByText('118/76')).toBeTruthy()
    expect(within(caseDetail).getByText('98')).toBeTruthy()
    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect(screen.queryByRole('combobox', { name: '检验项目' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '开始首诊' }))
    expect((await screen.findByRole('combobox', { name: '检验项目' })).textContent).toContain('发热检验组合 · ¥68.00')
    expect(screen.getByRole('combobox', { name: '检验适应证' }).textContent).toContain('发热')

    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    const firstVisitForm = await screen.findByRole('form', { name: '首诊记录' })
    await user.type(within(firstVisitForm).getByLabelText('现病史'), '两天前出现发热，伴咽痛。')
    await user.type(within(firstVisitForm).getByLabelText('首诊评估'), '急性发热，待检验明确病原')
    await user.click(within(firstVisitForm).getByRole('button', { name: '保存首诊草稿' }))
    expect(await screen.findByText('草稿已保存')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: '检验' }))
    await user.click(screen.getByRole('button', { name: '签发检验申请' }))
    expect(await screen.findByText('检验申请已签发')).toBeTruthy()
    expect(screen.getByText(/¥68\.00/)).toBeTruthy()
  })

  it('previews and confirms laboratory payment before moving the case to paid', async () => {
    let paid = false
    let paymentConfirmations = 0
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const queueItem = {
      accountId: 'account-1',
      amountFen: 6800,
      caseId: 'case-1',
      category: 'laboratory',
      chargeItemId: 'charge-laboratory-1',
      chargeVersion: paid ? 2 : 1,
      descriptionEn: 'Fever laboratory panel',
      descriptionZh: '发热检验组合',
      encounterId: 'encounter-1',
      lines: [{
        descriptionEn: 'Fever laboratory panel',
        descriptionZh: '发热检验组合',
        quantity: 1,
        sourceReference: 'ServiceRequest/service-request-1',
        subtotalFen: 6800,
        unitPriceFen: 6800,
      }],
      patient,
      status: paid ? 'paid' : 'billable',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(cashierSession)
      if (url.pathname === '/api/his/v1/billing/queue') {
        const category = url.searchParams.get('category')
        const status = url.searchParams.get('status')
        const hasItem = category === 'laboratory' && status === (paid ? 'paid' : 'pending')
        return Response.json({
          items: hasItem ? [queueItem] : [],
          ...pagination(hasItem ? 1 : 0),
        })
      }
      if (url.pathname === '/api/his/v1/payments/actions/preview') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body.expectedVersions).toEqual({ 'ChargeItem/charge-laboratory-1': '1' })
        expect(body.input).toEqual({
          caseId: 'case-1',
          category: 'laboratory',
          simulatorRule: 'success',
        })
        return Response.json(commandResponse({
          allocations: [{ amountFen: 6800, chargeItemId: 'charge-laboratory-1' }],
          amountFen: 6800,
          channel: 'synthetic-payment',
          chargeItemId: 'charge-laboratory-1',
          chargeVersion: 1,
          commitToken: 'payment-preview-token-123456',
          expectedOutcome: 'success',
          expiresAt: '2026-08-24T09:05:00+08:00',
          previewId: 'payment-preview-1',
        }))
      }
      if (url.pathname === '/api/his/v1/payments/payment-preview-1/actions/confirm') {
        paymentConfirmations += 1
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body.expectedVersions).toEqual({ 'ChargeItem/charge-laboratory-1': '1' })
        expect(body.input).toEqual({ commitToken: 'payment-preview-token-123456' })
        if (paymentConfirmations === 1) {
          return Response.json({
            error: {
              code: 'WORKFLOW_CONFLICT',
              message: 'Synthetic payment confirmation failed',
            },
          }, { status: 409 })
        }
        paid = true
        return Response.json(commandResponse({
          amountFen: 6800,
          outcome: 'success',
          paymentId: 'payment-1',
          status: 'awaiting-lis',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('tab', { name: '检验费用' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '药品费用' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '待缴' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '已缴' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '结果未知' })).toBeTruthy()
    expect(await screen.findByRole('listitem', { name: '选择费用 合成患者周明' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '支付处理结果' }).textContent).toContain('成功')

    await user.click(screen.getByRole('button', { name: '预览支付' }))
    expect(await screen.findByRole('heading', { name: '支付预览' })).toBeTruthy()
    expect(screen.getByText('预计成功')).toBeTruthy()
    expect(screen.getByText('合成支付')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '金额分配' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认支付' }))
    expect(paymentConfirmations).toBe(0)
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '确认支付' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '提交支付' }))

    expect(await screen.findByText('当前业务状态或前置条件不满足，请核对病例信息后重试。')).toBeTruthy()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '提交支付' }))
    expect(await screen.findByText('支付成功')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(paymentConfirmations).toBe(2)
    await user.click(screen.getByRole('tab', { name: '已缴' }))
    expect(await screen.findByRole('listitem', { name: '选择费用 合成患者周明' })).toBeTruthy()
  })

  it('labels a declined payment and keeps it available for an explicit retry', async () => {
    let declined = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(cashierSession)
      if (url.pathname === '/api/his/v1/billing/queue') {
        const category = url.searchParams.get('category')
        const status = url.searchParams.get('status')
        const hasItem = category === 'laboratory' && status === (declined ? 'declined' : 'pending')
        return Response.json({
          items: hasItem ? [{
            accountId: 'account-1',
            amountFen: 6800,
            caseId: 'case-1',
            category: 'laboratory',
            chargeItemId: 'charge-laboratory-1',
            chargeVersion: declined ? 2 : 1,
            descriptionEn: 'Fever laboratory panel',
            descriptionZh: '发热检验组合',
            encounterId: 'encounter-1',
            lines: [{
              descriptionEn: 'Fever laboratory panel',
              descriptionZh: '发热检验组合',
              quantity: 1,
              sourceReference: 'ServiceRequest/service-request-1',
              subtotalFen: 6800,
              unitPriceFen: 6800,
            }],
            patient,
            status: declined ? 'declined' : 'billable',
          }] : [],
          ...pagination(hasItem ? 1 : 0),
        })
      }
      if (url.pathname === '/api/his/v1/payments/actions/preview') {
        const body = JSON.parse(String(init?.body)) as { input: { simulatorRule: string } }
        expect(body.input.simulatorRule).toBe('decline')
        return Response.json(commandResponse({
          allocations: [{ amountFen: 6800, chargeItemId: 'charge-laboratory-1' }],
          amountFen: 6800,
          channel: 'synthetic-payment',
          chargeItemId: 'charge-laboratory-1',
          chargeVersion: 1,
          commitToken: 'payment-preview-token-123456',
          expectedOutcome: 'declined',
          expiresAt: '2026-08-24T09:05:00+08:00',
          previewId: 'payment-preview-declined',
        }))
      }
      if (url.pathname === '/api/his/v1/payments/payment-preview-declined/actions/confirm') {
        declined = true
        return Response.json(commandResponse({
          amountFen: 6800,
          outcome: 'declined',
          paymentId: 'payment-declined-1',
          status: 'awaiting-lab-payment',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('combobox', { name: '支付处理结果' }))
    await user.click(await screen.findByRole('option', { name: '拒绝' }))
    await user.click(screen.getByRole('button', { name: '预览支付' }))
    expect(await screen.findByText('预计拒绝')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认支付' }))
    await user.click(await screen.findByRole('button', { name: '提交支付' }))

    expect(await screen.findByText('支付被拒绝')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '已拒绝' }))
    expect(await screen.findByRole('listitem', { name: '选择费用 合成患者周明' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '预览支付' })).toBeTruthy()
  })

  it('reviews the LIS report and saves versioned revisit clinical drafts', async () => {
    window.history.replaceState(null, '', '/consultation')
    let status: 'awaiting-revisit' | 'revisit-draft' = 'awaiting-revisit'
    let draftSaved = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [{
            allowedCombinationIds: [],
            allowedCourseDays: [5],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            allowedQuantities: [10],
            defaultCourseDays: 5,
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            defaultQuantity: 10,
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 7600,
            version: 1,
          }],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-1',
            diagnosticReportId: 'diagnostic-report-1',
            encounterId: 'encounter-1',
            encounterVersion: status === 'awaiting-revisit' ? '5' : '6',
            patient,
            presentation: doctorPresentation,
            status,
            taskId: 'task-doctor-1',
            taskVersion: status === 'awaiting-revisit' ? '1' : '2',
            triage: doctorTriage,
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-1') {
        return Response.json({
          allergies: [{
            code: 'OSELTAMIVIR',
            display: '磷酸奥司他韦过敏',
          }],
          caseId: 'case-1',
          ...(draftSaved ? {
            drafts: {
              document: {
                assessment: '甲型流感，生命体征稳定。',
                composition: { id: 'composition-draft-1', resourceType: 'Composition' },
                medicationRequestIds: ['medication-request-1'],
                plan: '口服抗病毒药物，对症处理，必要时复诊。',
                version: 1,
              },
              prescription: {
                id: 'prescription-1',
                items: [{
                  doseText: '75 mg',
                  frequencyCode: 'BID',
                  medicationId: 'medication-oseltamivir',
                  medicationRequestId: 'medication-request-1',
                  quantity: 10,
                  versionId: '1',
                }],
                number: 'CM-RX-20260824-0001',
                status: 'draft',
                version: 1,
              },
              revisit: {
                conditionId: 'condition-1',
                conditionVersion: '1',
                diagnosis: { code: 'J10.1', display: '甲型流感' },
                version: 1,
              },
            },
          } : {}),
          encounter: {
            id: 'encounter-1',
            status: 'in-progress',
            versionId: status === 'awaiting-revisit' ? '5' : '6',
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          report: {
            id: 'diagnostic-report-1',
            results: [{
              code: '80382-5',
              interpretation: 'POS',
              value: true,
            }, {
              code: '6690-2',
              interpretation: 'H',
              referenceRange: '3.5–9.5',
              unit: '×10⁹/L',
              value: 6.8,
            }, {
              code: '789-8',
              interpretation: 'N',
              value: 4.7,
            }, {
              code: '718-7',
              value: 138,
            }],
            status: 'final',
          },
          status,
          taskId: 'task-doctor-1',
          taskVersion: status === 'awaiting-revisit' ? '1' : '2',
          triage: doctorTriage,
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/start-revisit') {
        const body = JSON.parse(String(init?.body)) as { expectedVersions: Record<string, string> }
        expect(body.expectedVersions).toEqual({
          'Encounter/encounter-1': '5',
          'Task/task-doctor-1': '1',
        })
        status = 'revisit-draft'
        return Response.json(commandResponse({ encounterVersion: '6', status, taskVersion: '2' }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/drafts/revisit') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(init?.method).toBe('PUT')
        expect(body.expectedVersions).toEqual({ 'Encounter/encounter-1': '6' })
        expect(body.input).toEqual({
          diagnosis: { code: 'J10.1', display: '甲型流感' },
          document: {
            assessment: '甲型流感，生命体征稳定。',
            plan: '口服抗病毒药物，对症处理，必要时复诊。',
          },
          expectedVersions: { documentDraft: 0, prescription: 0, revisitDraft: 0 },
          medications: [{
            catalogItemId: 'medication-oseltamivir',
            doseText: '75 mg',
            frequencyCode: 'BID',
            quantity: 10,
          }],
        })
        draftSaved = true
        return Response.json(commandResponse({
          conditionId: 'condition-1',
          documentDraftVersion: 1,
          medicationRequestIds: ['medication-request-1'],
          prescriptionId: 'prescription-1',
          prescriptionNumber: 'CM-RX-20260824-0001',
          prescriptionVersion: 1,
          revisitDraftVersion: 1,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect(await screen.findByText('甲型流感抗原')).toBeTruthy()
    expect(screen.getAllByText('阳性')).toHaveLength(2)
    expect(screen.getByText(/6\.8.*×10⁹\/L/)).toBeTruthy()
    expect(screen.getByText('磷酸奥司他韦过敏')).toBeTruthy()
    const contextRail = screen.getByRole('complementary', { name: '病例上下文' })
    expect(within(contextRail).getByText('final')).toBeTruthy()
    expect(within(contextRail).getByText('2 项异常结果')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    await user.click(screen.getByRole('button', { name: '开始复诊' }))
    await user.click(await screen.findByRole('tab', { name: '处方' }))
    expect(screen.queryByRole('combobox', { name: '药品' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const medicationSelect = await screen.findByRole('combobox', { name: '药品' })
    expect(medicationSelect.textContent).not.toContain('磷酸奥司他韦胶囊')
    await user.click(medicationSelect)
    await user.click(await screen.findByRole('option', { name: '磷酸奥司他韦胶囊' }))
    expect(screen.getByRole('combobox', { name: '剂量' }).textContent).toContain('75 mg')
    expect(screen.getByRole('combobox', { name: '频次' }).textContent).toContain('BID')

    await user.type(await screen.findByLabelText('诊断编码'), 'J10.1')
    await user.type(screen.getByLabelText('诊断名称'), '甲型流感')
    await user.type(screen.getByLabelText('复诊评估'), '甲型流感，生命体征稳定。')
    await user.type(screen.getByLabelText('诊疗计划'), '口服抗病毒药物，对症处理，必要时复诊。')
    await user.clear(screen.getByLabelText('数量'))
    await user.type(screen.getByLabelText('数量'), '10')
    const selectors = agentActionTarget({ id: 'revisit', operationId: 'outpatient.revisit.draft.set', input: {}, phase: 'executing' }).selectors
    for (const field of [medicationSelect, screen.getByRole('combobox', { name: '剂量' }), screen.getByRole('combobox', { name: '频次' }), screen.getByLabelText('数量')]) {
      expect(selectors.some(selector => field.matches(selector))).toBe(true)
    }
    await user.click(screen.getByRole('button', { name: '保存复诊草稿' }))

    expect(await screen.findByText('复诊草稿已保存')).toBeTruthy()
    expect(screen.getByText('CM-RX-20260824-0001')).toBeTruthy()
  })

  it('saves and confirms independent primary and secondary diagnoses from the controlled catalog', async () => {
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-independent-diagnosis',
      identifier: 'CM-SYN-DIAGNOSIS-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const diagnoses = [{
      code: 'J10.1',
      id: 'diagnosis-influenza',
      nameEn: 'Influenza with respiratory manifestations',
      nameZh: '流感伴其他呼吸道表现',
      system: 'http://hl7.org/fhir/sid/icd-10',
      version: 1,
    }, {
      code: 'J06.9',
      id: 'diagnosis-acute-upper-respiratory-infection',
      nameEn: 'Acute upper respiratory infection',
      nameZh: '急性上呼吸道感染',
      system: 'http://hl7.org/fhir/sid/icd-10',
      version: 1,
    }, {
      code: 'R50.9',
      id: 'diagnosis-fever',
      nameEn: 'Fever, unspecified',
      nameZh: '发热，未特指',
      system: 'http://hl7.org/fhir/sid/icd-10',
      version: 1,
    }]
    const draftEntries: [DiagnosisDraftEntry, DiagnosisDraftEntry] = [{
      catalogItemId: 'diagnosis-influenza',
      note: '结合甲型流感抗原结果。',
      referenceConcept: {
        code: 'J10.1',
        display: '流感伴其他呼吸道表现',
        id: 'diagnosis-influenza',
        sourceLocator: 'concepts[0]',
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: '2026',
      },
      role: 'primary',
    }, {
      catalogItemId: 'diagnosis:hypertension',
      referenceConcept: {
        code: 'I10',
        display: '原发性高血压',
        id: 'diagnosis:hypertension',
        sourceLocator: 'concepts[1]',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      },
      role: 'secondary',
    }]
    const confirmation = {
      confirmedAt: '2026-08-24T09:00:00+08:00',
      entries: [{
        ...draftEntries[0],
        code: 'J10.1',
        conditionId: 'condition-diagnosis-primary',
        conditionVersion: '1',
        display: '流感伴其他呼吸道表现',
        system: 'http://hl7.org/fhir/sid/icd-10',
      }, {
        ...draftEntries[1],
        code: 'I10',
        conditionId: 'condition-diagnosis-secondary',
        conditionVersion: '1',
        display: '原发性高血压',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
      }],
      id: 'diagnosis-confirmation-1',
      provenanceId: 'provenance-diagnosis-1',
      revisionNumber: 1,
    }
    const diagnosisQueries: Array<string | null> = []
    const savedDiagnosisEntries: DiagnosisDraftEntry[][] = []
    let diagnosis: DiagnosisState | undefined
    let encounterVersion = '6'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const agentResponse = doctorSurfaceAgentResponse(url.pathname, init)
      if (agentResponse !== undefined) return agentResponse
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses,
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: false,
        })
      }
      if (url.pathname === '/api/his/v1/reference-catalogs/diagnoses') {
        diagnosisQueries.push(url.searchParams.get('query'))
        return Response.json({
          items: [{
            code: 'J10.1',
            display: '流感伴其他呼吸道表现',
            domain: 'diagnosis',
            id: 'diagnosis-influenza',
            sourceLocator: 'concepts[0]',
            status: 'active',
            system: 'http://hl7.org/fhir/sid/icd-10',
            version: '2026',
          }, {
            code: 'I10',
            display: '原发性高血压',
            domain: 'diagnosis',
            id: 'diagnosis:hypertension',
            sourceLocator: 'concepts[1]',
            status: 'active',
            system: 'urn:clinmesh:reference:nhsa-diagnosis',
            version: '2022',
          }],
          page: 1,
          pageSize: 20,
          releaseId: 'reference-http-test-v1',
          total: 2,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-independent-diagnosis',
            encounterId: 'encounter-independent-diagnosis',
            encounterVersion,
            patient,
            presentation: doctorPresentation,
            status: 'revisit-draft',
            taskId: 'task-independent-diagnosis',
            taskVersion: '2',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-independent-diagnosis') {
        return Response.json({
          allergies: [],
          caseId: 'case-independent-diagnosis',
          consultation: { turns: [], version: 1 },
          ...(diagnosis === undefined ? {} : { diagnosis }),
          encounter: {
            id: 'encounter-independent-diagnosis',
            status: 'in-progress',
            versionId: encounterVersion,
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [{
            clinicalStatus: 'active',
            code: 'R05',
            display: '既往咳嗽',
            id: 'condition-prior-cough',
            recordedDate: '2025-08-24',
          }],
          status: 'revisit-draft',
          taskId: 'task-independent-diagnosis',
          taskVersion: '2',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-independent-diagnosis/diagnosis/draft') {
        expect(init?.method).toBe('PUT')
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: {
            entries: Array<Omit<DiagnosisDraftEntry, 'referenceConcept'>>
            expectedDraftVersion: number
          }
        }
        expect(body.expectedVersions).toEqual({
          'Encounter/encounter-independent-diagnosis': encounterVersion,
        })
        expect(body.input.expectedDraftVersion).toBe(diagnosis?.draftVersion ?? 0)
        const entries = body.input.entries.map((entry) => {
          const snapshot = draftEntries.find(candidate => (
            candidate.catalogItemId === entry.catalogItemId
          ))?.referenceConcept
          return { ...entry, ...(snapshot === undefined ? {} : { referenceConcept: snapshot }) }
        })
        savedDiagnosisEntries.push(entries)
        const nextVersion = (diagnosis?.draftVersion ?? 0) + 1
        diagnosis = {
          ...(diagnosis?.confirmation === undefined ? {} : { confirmation: diagnosis.confirmation }),
          draft: { entries },
          draftVersion: nextVersion,
        }
        return Response.json(commandResponse({ draftVersion: nextVersion }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-independent-diagnosis/diagnosis/actions/confirm') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-independent-diagnosis': encounterVersion },
          input: { expectedDraftVersion: diagnosis?.draftVersion },
        })
        expect(diagnosis?.draft?.entries).toHaveLength(2)
        encounterVersion = '7'
        const diagnosisVersion = (diagnosis?.draftVersion ?? 0) + 1
        diagnosis = { confirmation, draftVersion: diagnosisVersion }
        return Response.json(commandResponse({
          confirmation,
          diagnosisVersion,
          encounterId: 'encounter-independent-diagnosis',
          encounterVersion,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp runtime={{
      mode: 'surface',
      surfaceAgent,
      surfaceAgentStatus: 'active',
      surfaceSessionId: 'dsh-session-1',
    }} />)

    expect(await screen.findByRole('complementary', { name: '病例上下文' })).toBeTruthy()
    await user.click(await screen.findByRole('tab', { name: '检验' }))
    expect((await screen.findAllByText(/既往咳嗽/)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: '用药结论' })).toBeNull()
    expect(screen.queryByLabelText('诊断编码')).toBeNull()
    await user.click(screen.getByRole('tab', { name: '诊断' }))
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    let diagnosisDialog = await screen.findByRole('dialog', { name: '选择诊断' })
    await user.type(within(diagnosisDialog).getByLabelText('搜索疾病目录'), '流感')
    await user.click(within(diagnosisDialog).getByRole('button', { name: '执行疾病目录搜索' }))
    await waitFor(() => expect(diagnosisQueries).toContain('流感'))
    await user.click(await within(diagnosisDialog).findByRole('button', {
      name: '选择 流感伴其他呼吸道表现 J10.1',
    }))
    await user.click(within(diagnosisDialog).getByRole('button', { name: '加入诊断' }))
    await user.type(screen.getByLabelText('诊断备注'), '结合甲型流感抗原结果。')
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    diagnosisDialog = await screen.findByRole('dialog', { name: '选择诊断' })
    await user.type(within(diagnosisDialog).getByLabelText('搜索疾病目录'), '高血')
    await user.click(within(diagnosisDialog).getByRole('button', { name: '执行疾病目录搜索' }))
    await waitFor(() => expect(diagnosisQueries).toContain('高血'))
    await user.click(await within(diagnosisDialog).findByRole('button', {
      name: '选择 原发性高血压 I10',
    }))
    await user.click(within(diagnosisDialog).getByRole('button', { name: '加入诊断' }))
    expect(screen.queryByRole('button', { name: '保存诊断草稿' })).toBeNull()
    await waitFor(() => expect(savedDiagnosisEntries.at(-1)).toHaveLength(2), { timeout: 3_000 })
    expect(await screen.findByText('草稿已自动保存')).toBeTruthy()
    expect(screen.queryByText('诊断已确认')).toBeNull()
    await user.click(screen.getByRole('button', { name: '确认诊断' }))
    const confirmDiagnosisDialog = await screen.findByRole('alertdialog', { name: '确认诊断版本' })
    await user.click(within(confirmDiagnosisDialog).getByRole('button', { name: '确认诊断版本' }))
    expect(await screen.findByText(/诊断已确认/)).toBeTruthy()
    expect(screen.getByText('J10.1')).toBeTruthy()
    expect(screen.getAllByText('流感伴其他呼吸道表现').length).toBeGreaterThan(0)
    expect(screen.getByText('I10')).toBeTruthy()
    expect(screen.getAllByText('原发性高血压').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '添加诊断' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '移除诊断 2' }))
    await waitFor(() => expect(savedDiagnosisEntries.at(-1)).toHaveLength(1), { timeout: 3_000 })
    expect((screen.getByRole('button', { name: '确认诊断' }) as HTMLButtonElement).disabled).toBe(false)
    await waitFor(() => expect(registration?.tools.some(tool => (
      tool.name === 'clinmesh_fill_diagnosis_draft'
    ))).toBe(true))
    const fillDiagnosis = registration!.tools.find(tool => (
      tool.name === 'clinmesh_fill_diagnosis_draft'
    ))!
    for (const name of ['clinmesh_fill_diagnosis_draft', 'clinmesh_prepare_confirm_diagnosis']) {
      const diagnosisTool = registration!.tools.find(tool => tool.name === name)
      expect(diagnosisTool?.parameters).toMatchObject({
        properties: {
          entries: {
            items: {
              properties: { role: { type: 'string', enum: ['primary', 'secondary'] } },
            },
          },
        },
      })
    }
    await act(async () => {
      await fillDiagnosis.execute(boundAgentToolInput(fillDiagnosis, {
        entries: [{ catalogItemId: 'diagnosis-fever', role: 'primary' }],
      }), new AbortController().signal)
    })
    expect(await screen.findByText('发热，未特指')).toBeTruthy()
    expect(screen.getByText('R50.9')).toBeTruthy()
    expect(screen.queryByText('流感伴其他呼吸道表现')).toBeNull()
    await user.click(screen.getByRole('tab', { name: '检验' }))
    expect(screen.getAllByText(/既往咳嗽/).length).toBeGreaterThan(0)
  })

  it('keeps each patient clinical record while aligning the consultation workbench', async () => {
    const questionText = '什么时候开始不舒服？'
    let releaseFirstPatientAnswer: (() => void) | undefined
    const patients = [{
      birthDate: '1981-06-12',
      gender: 'male',
      id: 'patient-wang-xiaoming',
      identifier: 'MZ20260826001',
      name: '王晓明',
      synthetic: true,
      versionId: '1',
    }, {
      birthDate: '1994-11-03',
      gender: 'female',
      id: 'patient-li-jing',
      identifier: 'MZ20260826002',
      name: '李静',
      synthetic: true,
      versionId: '1',
    }]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses: [],
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: patients.map((patient, index) => ({
            caseId: `case-${index + 1}`,
            encounterId: `encounter-${index + 1}`,
            encounterVersion: '1',
            patient,
            presentation: {
              ...doctorPresentation,
              chiefComplaint: index === 0 ? '咳嗽、发热三天' : '间断头痛一周',
              summary: index === 0 ? '三天前出现咳嗽伴发热。' : '一周来间断头痛。',
            },
            status: 'first-visit',
            taskId: `task-${index + 1}`,
            taskVersion: '1',
          })),
          ...pagination(2),
        })
      }
      const caseMatch = /^\/api\/his\/v1\/doctor\/cases\/case-(\d)$/.exec(url.pathname)
      if (caseMatch !== null) {
        const index = Number(caseMatch[1]) - 1
        const patient = patients[index]
        if (patient === undefined) throw new Error('Patient fixture was not found')
        return Response.json({
          allergies: [],
          caseId: `case-${index + 1}`,
          consultation: { turns: [], version: 1 },
          encounter: { id: `encounter-${index + 1}`, status: 'in-progress', versionId: '1' },
          laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
          patient,
          presentation: {
            ...doctorPresentation,
            chiefComplaint: index === 0 ? '咳嗽、发热三天' : '间断头痛一周',
            summary: index === 0 ? '三天前出现咳嗽伴发热。' : '一周来间断头痛。',
          },
          priorFacts: [],
          status: 'first-visit',
          taskId: `task-${index + 1}`,
          taskVersion: '1',
        })
      }
      const completionMatch = /^\/api\/his\/v1\/encounters\/encounter-(\d)\/completion$/.exec(url.pathname)
      if (completionMatch !== null) {
        return Response.json({
          canComplete: false,
          encounterId: `encounter-${completionMatch[1]}`,
          encounterVersion: '1',
          items: [{ code: 'primary-diagnosis-confirmed', status: 'incomplete', statusText: '待确认诊断', target: 'diagnosis' },
            { code: 'clinical-document-signed', status: 'incomplete', statusText: '待签署病历', target: 'clinical-document' },
            { code: 'required-reports-acknowledged', status: 'complete', statusText: '无需确认报告', target: 'laboratory' },
            { code: 'medication-conclusion-recorded', status: 'incomplete', statusText: '待记录用药结论', target: 'medication-conclusion' },
            { code: 'no-pending-drafts', status: 'complete', statusText: '无待处理项目', target: 'clinical-document' },
            { code: 'disposition-complete', status: 'incomplete', statusText: '待填写处置', target: 'clinical-document' },
            { code: 'follow-up-complete', status: 'incomplete', statusText: '待填写随访', target: 'clinical-document' }],
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/ask-consultation-question') {
        return new Promise<Response>(resolve => {
          releaseFirstPatientAnswer = () => resolve(Response.json({
            error: {
              code: 'WORKFLOW_CONFLICT',
              message: 'The first patient Consultation Record changed',
            },
          }, { status: 409 }))
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('tab', { name: '病历记录' })).toBeTruthy()
    const queueRegion = await screen.findByRole('complementary', { name: '候诊队列' })
    expect(within(queueRegion).getByRole('tab', { name: '在诊' })).toBeTruthy()
    expect(within(queueRegion).getByRole('tab', { name: '待诊' })).toBeTruthy()
    expect(within(queueRegion).getByRole('tab', { name: '完诊' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '当前诊疗' })).toBeNull()
    expect(within(queueRegion).getByRole('button', { name: '选择病例 王晓明' })).toBeTruthy()
    const patientBanner = screen.getByRole('region', { name: '当前患者' })
    expect(within(patientBanner).getByRole('img', { name: '王晓明 患者' })).toBeTruthy()
    const contextRail = await screen.findByRole('complementary', { name: '病例上下文' })
    expect(within(contextRail).queryByRole('button', { name: '向患者提问' })).toBeNull()
    expect(screen.getByRole('button', { name: '收起右侧边栏' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('heading', { name: '过敏提示' })).toBeTruthy()
    expect(within(contextRail).getByRole('heading', { name: '生命体征' })).toBeTruthy()
    expect(within(contextRail).getByText('体温（°C）38.2 · 脉搏（次/分）102 · 呼吸（次/分）20 · 血压（mmHg）118/76 · 血氧饱和度（%）98')).toBeTruthy()
    expect(within(contextRail).getByRole('heading', { name: '完诊清单' })).toBeTruthy()
    expect(within(contextRail).getByText('已满足 2 / 7')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '问诊记录' }))
    await user.type(screen.getByRole('textbox', { name: '向患者提问' }), questionText)
    await user.click(screen.getByRole('button', { name: '向患者提问' }))
    expect((await screen.findByRole('button', {
      name: '正在等待患者回答',
    }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '选择病例 李静' }))
    expect(await screen.findByRole('heading', { name: '李静' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '正在等待患者回答' })).toBeNull()
    await act(async () => {
      releaseFirstPatientAnswer?.()
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: '李静' })).toBeTruthy()
    expect(screen.queryByText('操作冲突')).toBeNull()
    await user.click(screen.getByRole('button', { name: '选择病例 王晓明' }))
    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    const history = screen.getByLabelText('现病史') as HTMLTextAreaElement
    await user.clear(history)
    await user.type(history, '患者三天前受凉后出现咳嗽、发热。')
    await user.click(screen.getByRole('button', { name: '选择病例 李静' }))
    await user.click(await screen.findByRole('button', { name: '选择病例 王晓明' }))

    expect((await screen.findByLabelText('现病史') as HTMLTextAreaElement).value)
      .toBe('患者三天前受凉后出现咳嗽、发热。')
    expect(screen.queryByText(/保存.*草稿|草稿版本|版本 \d/)).toBeNull()
  })

  it('completes an eligible Encounter from the patient header and converts it to read-only', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-completion',
      identifier: 'CM-SYN-COMPLETION-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const diagnosis = {
      confirmation: {
        confirmedAt: '2026-08-24T09:00:00+08:00',
        entries: [{
          catalogItemId: 'diagnosis-influenza',
          code: 'J10.1',
          conditionId: 'condition-completion-primary',
          conditionVersion: '1',
          display: '流感伴其他呼吸道表现',
          role: 'primary' as const,
          system: 'http://hl7.org/fhir/sid/icd-10',
        }],
        id: 'diagnosis-confirmation-completion',
        provenanceId: 'provenance-diagnosis-completion',
      },
      draftVersion: 2,
    }
    const noMedication = {
      authoredAt: '2026-08-24T09:00:00+08:00',
      authoredByActorId: 'actor-outpatient-doctor',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      id: 'no-medication-completion',
      version: 1,
    }
    const signedDocument = {
      bundleId: 'bundle-completion',
      compositionId: 'composition-completion',
      compositionVersion: '1',
      content: structuredClinicalDocument,
      documentId: 'document-completion',
      provenanceId: 'provenance-document-completion',
      revisionNumber: 1,
      signedAt: '2026-08-24T09:00:00+08:00',
    }
    const completionItems = [{
      code: 'primary-diagnosis-confirmed',
      status: 'complete',
      statusText: '已确认主诊断',
      target: 'diagnosis',
    }, {
      code: 'clinical-document-signed',
      status: 'complete',
      statusText: '已签署结构化病历',
      target: 'clinical-document',
    }, {
      code: 'required-reports-acknowledged',
      status: 'complete',
      statusText: '必要报告已全部确认已阅',
      target: 'laboratory',
    }, {
      code: 'medication-conclusion-recorded',
      status: 'complete',
      statusText: '已记录用药结论',
      target: 'medication-conclusion',
    }, {
      code: 'no-pending-drafts',
      status: 'complete',
      statusText: '无未处理临床草稿',
      target: 'clinical-document',
    }, {
      code: 'disposition-complete',
      status: 'complete',
      statusText: '已完善处置',
      target: 'clinical-document',
    }, {
      code: 'follow-up-complete',
      status: 'complete',
      statusText: '已完善随访安排',
      target: 'clinical-document',
    }] as const
    let completed = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses: [],
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: completed ? [] : [{
            caseId: 'case-completion',
            encounterId: 'encounter-completion',
            encounterVersion: '2',
            patient,
            presentation: doctorPresentation,
            status: 'first-visit',
            taskId: 'task-completion',
            taskVersion: '1',
          }],
          ...pagination(completed ? 0 : 1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-completion') {
        return Response.json({
          allergies: [],
          caseId: 'case-completion',
          clinicalDocument: {
            draft: {
              ...structuredClinicalDocument,
              updatedAt: '2026-08-24T08:55:00+08:00',
              version: 1,
            },
            signed: [signedDocument],
          },
          consultation: {
            turns: [],
            version: 1,
          },
          diagnosis,
          encounter: {
            id: 'encounter-completion',
            status: completed ? 'completed' : 'in-progress',
            versionId: completed ? '3' : '2',
          },
          laboratoryRequests: {
            draftVersion: 0,
            reportingSupported: true,
            requests: [],
          },
          medicationConclusion: {
            draftVersion: 1,
            noMedication,
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-completion',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-completion/completion') {
        return Response.json({
          canComplete: !completed,
          encounterId: 'encounter-completion',
          encounterVersion: completed ? '3' : '2',
          items: completionItems,
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-completion/actions/complete') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-completion': '2' },
          input: {},
        })
        completed = true
        return Response.json(commandResponse({
          completedAt: '2026-08-24T09:00:00+08:00',
          encounterId: 'encounter-completion',
          encounterVersion: '3',
          status: 'completed',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('complementary', { name: '候诊队列' })).toBeTruthy()
    expect(await screen.findByRole('region', { name: '当前患者' })).toBeTruthy()
    expect(await screen.findByRole('complementary', { name: '病例上下文' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '病历记录' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '诊断' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '处方' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '检验' })).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '完诊' }))
    expect(screen.getByRole('heading', { name: '确认完诊' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认完诊' }))

    expect(await screen.findByText('Encounter 已完成，当前病例为只读。')).toBeTruthy()
    expect(within(screen.getByRole('complementary', { name: '候诊队列' })).queryByRole('button', { name: /^选择病例 / })).toBeNull()
    expect(within(screen.getByRole('complementary', { name: '候诊队列' })).getByText('0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '向患者提问' })).toBeNull()
    expect(screen.queryByRole('button', { name: '提交病历修订' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认完诊' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: '处方' }))
    expect(screen.getByText('已确认无需用药')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    expect(screen.getByRole('heading', { name: '签署历史' })).toBeTruthy()
  })

  it('shows the server diagnosis primary validation error in the doctor workspace', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-diagnosis-validation',
      identifier: 'CM-SYN-DIAGNOSIS-002',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses: [{
            code: 'J10.1',
            id: 'diagnosis-influenza',
            nameEn: 'Influenza with respiratory manifestations',
            nameZh: '流感伴其他呼吸道表现',
            system: 'http://hl7.org/fhir/sid/icd-10',
            version: 1,
          }],
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-diagnosis-validation',
            encounterId: 'encounter-diagnosis-validation',
            encounterVersion: '6',
            patient,
            presentation: doctorPresentation,
            status: 'revisit-draft',
            taskId: 'task-diagnosis-validation',
            taskVersion: '2',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-diagnosis-validation') {
        return Response.json({
          allergies: [],
          caseId: 'case-diagnosis-validation',
          consultation: { turns: [], version: 1 },
          diagnosis: {
            draft: {
              entries: [{
                catalogItemId: 'diagnosis-influenza',
                role: 'primary',
              }],
            },
            draftVersion: 1,
          },
          encounter: {
            id: 'encounter-diagnosis-validation',
            status: 'in-progress',
            versionId: '6',
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'revisit-draft',
          taskId: 'task-diagnosis-validation',
          taskVersion: '2',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-diagnosis-validation/diagnosis/draft') {
        expect(init?.method).toBe('PUT')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-diagnosis-validation': '6' },
          input: {
            entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
            expectedDraftVersion: 1,
          },
        })
        return Response.json(commandResponse({ draftVersion: 2 }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-diagnosis-validation/diagnosis/actions/confirm') {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-diagnosis-validation': '6' },
          input: { expectedDraftVersion: 1 },
        })
        return Response.json({
          error: {
            code: 'DIAGNOSIS_PRIMARY_REQUIRED',
            message: 'Exactly one primary diagnosis is required',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '诊断' }))
    await user.click(await screen.findByRole('button', { name: '确认诊断' }))
    const confirmDialog = await screen.findByRole('alertdialog', { name: '确认诊断版本' })
    await user.click(within(confirmDialog).getByRole('button', { name: '确认诊断版本' }))
    expect(await screen.findByText('必须且只能选择一个主诊断。')).toBeTruthy()
  })

  it('groups medication package variants, saves and issues a controlled prescription, withdraws it, and confirms no medication', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-prescription-conclusion',
      identifier: 'CM-SYN-PRESCRIPTION-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const referenceMedication = {
      approvalNumber: '国药准字H20260001',
      brandName: null,
      code: 'H20260001',
      dosageForm: '胶囊剂',
      genericName: '磷酸奥司他韦胶囊',
      id: 'medication-product-oseltamivir-a',
      manufacturer: '合成制药有限公司',
      packageDescription: '10粒/盒',
      sourceLocator: 'products[1]',
      status: 'active',
      strength: '75 mg',
      system: 'https://www.nmpa.gov.cn/datasearch/home-index.html',
      version: '2026-08',
    } as const
    const secondReferenceMedication = {
      ...referenceMedication,
      approvalNumber: '国药准字H20260002',
      code: 'H20260002',
      id: 'medication-product-oseltamivir-b',
      manufacturer: '另一合成制药有限公司',
      sourceLocator: 'products[2]',
    } as const
    const referenceMedicationPackageVariant = {
      ...referenceMedication,
      id: 'medication-product-oseltamivir-a-12',
      packageDescription: '12粒/盒',
      sourceLocator: 'products[1].packages[2]',
    } as const
    const draftItem = {
      catalogItemId: referenceMedicationPackageVariant.id,
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
      referenceProduct: referenceMedicationPackageVariant,
    }
    const { referenceProduct: _referenceProduct, ...submittedDraftItem } = draftItem
    const issuedItem = {
      ...draftItem,
      display: '磷酸奥司他韦胶囊',
      medicationRequestId: 'medication-request-oseltamivir-1',
      medicationRequestVersion: '1',
    }
    const issuedPrescription = {
      authoredAt: '2026-08-24T09:00:00+08:00',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      id: 'prescription-independent-1',
      items: [issuedItem],
      number: 'CM-RX-20260824-0001',
      status: 'signed' as const,
      version: 1,
    }
    const withdrawal = {
      id: 'prescription-withdrawal-1',
      prescriptionId: issuedPrescription.id,
      version: 1,
      withdrawnAt: '2026-08-24T09:00:00+08:00',
      withdrawnByActorId: 'actor-outpatient-doctor',
      withdrawnByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
    }
    const noMedication = {
      authoredAt: '2026-08-24T09:00:00+08:00',
      authoredByActorId: 'actor-outpatient-doctor',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      id: 'no-medication-conclusion-1',
      version: 1,
    }
    const medicationQueries: Array<string | null> = []
    let draftDeletionRequests = 0
    let medicationConclusion: DoctorCaseDetail['medicationConclusion']
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses: [],
          laboratory: [],
          medications: [{
            allowedCombinationIds: ['medication-oseltamivir'],
            allowedCourseDays: [5],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            allowedQuantities: [10],
            defaultCourseDays: 5,
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            defaultQuantity: 10,
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir phosphate capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 1_680,
            version: 1,
          }],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/reference-catalogs/medications') {
        medicationQueries.push(url.searchParams.get('query'))
        return Response.json({
          items: [referenceMedication, referenceMedicationPackageVariant, secondReferenceMedication],
          page: 1,
          pageSize: 20,
          releaseId: 'reference-http-test-v1',
          total: 3,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-prescription-conclusion',
            encounterId: 'encounter-prescription-conclusion',
            encounterVersion: '6',
            patient,
            presentation: doctorPresentation,
            status: 'revisit-draft',
            taskId: 'task-prescription-conclusion',
            taskVersion: '2',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-prescription-conclusion') {
        return Response.json({
          allergies: [],
          caseId: 'case-prescription-conclusion',
          consultation: { turns: [], version: 1 },
          diagnosis: {
            confirmation: {
              confirmedAt: '2026-08-24T09:00:00+08:00',
              entries: [{
                catalogItemId: 'diagnosis-influenza',
                code: 'J10.1',
                conditionId: 'condition-influenza-1',
                conditionVersion: '1',
                display: '流感伴其他呼吸道表现',
                role: 'primary',
                system: 'http://hl7.org/fhir/sid/icd-10',
              }],
              id: 'diagnosis-confirmation-prescription-1',
              provenanceId: 'provenance-diagnosis-prescription-1',
            },
            draftVersion: 2,
          },
          encounter: {
            id: 'encounter-prescription-conclusion',
            status: 'in-progress',
            versionId: '6',
          },
          ...(medicationConclusion === undefined ? {} : { medicationConclusion }),
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'revisit-draft',
          taskId: 'task-prescription-conclusion',
          taskVersion: '2',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-prescription-conclusion/prescription/draft') {
        if (init?.method === 'DELETE') {
          draftDeletionRequests += 1
          expect(JSON.parse(String(init.body))).toEqual({
            expectedVersions: { 'Encounter/encounter-prescription-conclusion': '6' },
            input: { expectedDraftVersion: 1 },
          })
          medicationConclusion = { draftVersion: 2 }
          return Response.json(commandResponse({ draftVersion: 2 }))
        }
        expect(init?.method).toBe('PUT')
        const expectedDraftVersion = medicationConclusion?.draftVersion ?? 0
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-prescription-conclusion': '6' },
          input: { expectedDraftVersion, items: [submittedDraftItem] },
        })
        const draftVersion = expectedDraftVersion + 1
        medicationConclusion = { draft: { items: [draftItem] }, draftVersion }
        return Response.json(commandResponse({ draftVersion }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-prescription-conclusion/prescription/actions/issue') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-prescription-conclusion': '6' },
          input: { expectedDraftVersion: 3 },
        })
        medicationConclusion = { draftVersion: 4, prescription: issuedPrescription }
        return Response.json(commandResponse({
          draftVersion: 4,
          prescription: issuedPrescription,
        }))
      }
      if (url.pathname === '/api/his/v1/prescriptions/prescription-independent-1/actions/withdraw') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'MedicationRequest/medication-request-oseltamivir-1': '1' },
          input: { expectedPrescriptionVersion: 1 },
        })
        medicationConclusion = {
          draftVersion: 4,
          prescription: {
            ...issuedPrescription,
            status: 'withdrawn',
            version: 2,
            withdrawal,
          },
        }
        return Response.json(commandResponse({
          medicationRequests: [{ id: issuedItem.medicationRequestId, version: '2' }],
          prescriptionId: issuedPrescription.id,
          prescriptionVersion: 2,
          status: 'withdrawn',
          withdrawal,
        }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-prescription-conclusion/medication-conclusion/actions/confirm-no-medication') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-prescription-conclusion': '6' },
          input: { expectedDraftVersion: 4 },
        })
        medicationConclusion = {
          ...medicationConclusion,
          draftVersion: 5,
          noMedication,
        }
        return Response.json(commandResponse({ draftVersion: 5, noMedication }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '处方' }))
    expect(screen.queryByLabelText('剂量')).toBeNull()
    await user.click(await screen.findByRole('button', { name: '添加药品' }))
    const medicationDialog = await screen.findByRole('dialog', { name: '选择药品' })
    await user.type(within(medicationDialog).getByLabelText('搜索药品目录'), '奥司')
    await user.click(within(medicationDialog).getByRole('button', { name: '执行药品目录搜索' }))
    await waitFor(() => expect(medicationQueries).toContain('奥司'))
    expect(within(medicationDialog).queryByText('2 个包装')).toBeNull()
    expect(within(medicationDialog).getAllByRole('row')).toHaveLength(3)
    expect(within(medicationDialog).getAllByText('合成制药有限公司')).toHaveLength(1)
    expect(within(medicationDialog).getByText('另一合成制药有限公司')).toBeTruthy()
    await user.click(within(medicationDialog).getByRole('combobox', { name: '包装 磷酸奥司他韦胶囊 合成制药有限公司' }))
    await user.click(screen.getByRole('option', { name: '12粒/盒' }))
    await user.click(within(medicationDialog).getByRole('button', {
      name: '选择 磷酸奥司他韦胶囊 75 mg 12粒/盒 合成制药有限公司 国药准字H20260001',
    }))
    await user.click(within(medicationDialog).getByRole('button', { name: '加入处方' }))
    const dose = await screen.findByLabelText('剂量')
    const frequency = screen.getByLabelText('频次')
    const course = screen.getByLabelText('疗程')
    const quantity = screen.getByLabelText('数量')
    await user.type(dose, '75 mg')
    await user.type(frequency, 'BID')
    await user.clear(course)
    await user.type(course, '5')
    await user.clear(quantity)
    await user.type(quantity, '10')
    expect(screen.queryByRole('button', { name: '保存处方草稿' })).toBeNull()
    await waitFor(() => expect(medicationConclusion?.draftVersion).toBe(1), { timeout: 3_000 })
    expect(await screen.findByText('草稿已自动保存')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    const deleteDialog = await screen.findByRole('alertdialog', { name: '确认删除处方草稿' })
    expect(draftDeletionRequests).toBe(0)
    expect(within(deleteDialog).getByText('磷酸奥司他韦胶囊')).toBeTruthy()
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('处方草稿已删除')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alertdialog', {
      name: '确认删除处方草稿',
    })).toBeNull())
    expect(draftDeletionRequests).toBe(1)
    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const reopenedMedicationDialog = await screen.findByRole('dialog', { name: '选择药品' })
    await user.click(within(reopenedMedicationDialog).getByRole('combobox', { name: '包装 磷酸奥司他韦胶囊 合成制药有限公司' }))
    await user.click(screen.getByRole('option', { name: '12粒/盒' }))
    await user.click(await within(reopenedMedicationDialog).findByRole('button', {
      name: '选择 磷酸奥司他韦胶囊 75 mg 12粒/盒 合成制药有限公司 国药准字H20260001',
    }))
    await user.click(within(reopenedMedicationDialog).getByRole('button', { name: '加入处方' }))
    await user.type(await screen.findByLabelText('剂量'), '75 mg')
    await user.type(screen.getByLabelText('频次'), 'BID')
    await user.clear(screen.getByLabelText('疗程'))
    await user.type(screen.getByLabelText('疗程'), '5')
    await user.clear(screen.getByLabelText('数量'))
    await user.type(screen.getByLabelText('数量'), '10')
    await waitFor(() => expect(medicationConclusion?.draftVersion).toBe(3), { timeout: 3_000 })
    await user.click(screen.getByRole('button', { name: '正式开具处方' }))
    const issueDialog = await screen.findByRole('alertdialog', { name: '确认正式开具处方' })
    await user.click(within(issueDialog).getByRole('button', { name: '确认开具' }))
    expect(await screen.findByText('处方已正式开具')).toBeTruthy()
    expect(screen.getByText(/CM-RX-20260824-0001/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '药品' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '撤回处方' }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认撤回处方' })
    expect(within(dialog).getByText('CM-RX-20260824-0001')).toBeTruthy()
    expect(within(dialog).getByText('已开具')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: '确认撤回' }))
    expect(await screen.findByText(/处方已撤回/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '无需用药' }))
    await user.click(screen.getByRole('button', { name: '确认无需用药' }))
    expect(await screen.findByText('已确认无需用药')).toBeTruthy()
  }, 10_000)

  it('keeps the prescription draft visible when controlled issuance is rejected', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-prescription-conflict',
      identifier: 'CM-SYN-PRESCRIPTION-002',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const draftItem = {
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses: [],
          laboratory: [],
          medications: [{
            allowedCombinationIds: ['medication-oseltamivir'],
            allowedCourseDays: [5],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            allowedQuantities: [10],
            defaultCourseDays: 5,
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            defaultQuantity: 10,
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir phosphate capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 1_680,
            version: 1,
          }],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-prescription-conflict',
            encounterId: 'encounter-prescription-conflict',
            encounterVersion: '6',
            patient,
            presentation: doctorPresentation,
            status: 'revisit-draft',
            taskId: 'task-prescription-conflict',
            taskVersion: '2',
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-prescription-conflict') {
        return Response.json({
          allergies: [{ code: 'OSELTAMIVIR', display: '磷酸奥司他韦过敏' }],
          caseId: 'case-prescription-conflict',
          consultation: { turns: [], version: 1 },
          encounter: {
            id: 'encounter-prescription-conflict',
            status: 'in-progress',
            versionId: '6',
          },
          medicationConclusion: { draft: { items: [draftItem] }, draftVersion: 1 },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'revisit-draft',
          taskId: 'task-prescription-conflict',
          taskVersion: '2',
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-prescription-conflict/prescription/actions/issue') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-prescription-conflict': '6' },
          input: { expectedDraftVersion: 1 },
        })
        return Response.json({
          error: {
            code: 'CATALOG_CONFLICT',
            message: 'The confirmed diagnosis does not allow medication-oseltamivir',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '处方' }))
    await user.click(await screen.findByRole('button', { name: '正式开具处方' }))
    const issueDialog = await screen.findByRole('alertdialog', { name: '确认正式开具处方' })
    await user.click(within(issueDialog).getByRole('button', { name: '确认开具' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', {
      name: '确认正式开具处方',
    })).toBeNull())
    expect(await screen.findByText('当前诊断、过敏信息、目录或处方状态不允许正式开具，请检查后重试。')).toBeTruthy()
    expect(screen.getAllByText('磷酸奥司他韦胶囊').length).toBeGreaterThan(0)
    expect(screen.getByRole('combobox', { name: '剂量' }).textContent).toContain('75 mg')
    expect(screen.getByRole('combobox', { name: '频次' }).textContent).toContain('BID')
    expect(screen.getByRole('combobox', { name: '疗程' }).textContent).toContain('5 天')
    expect(screen.getByRole('combobox', { name: '数量' }).textContent).toContain('10')
  })

  it('previews clinical signing and completes the Encounter before medication payment', async () => {
    window.history.replaceState(null, '', '/consultation')
    let signed = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const expectedVersions = {
      'Condition/condition-1': '1',
      'Encounter/encounter-1': '6',
      'MedicationRequest/medication-request-1': '1',
      'Task/task-doctor-1': '2',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [{
            allowedCombinationIds: [],
            allowedCourseDays: [5],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            allowedQuantities: [10],
            defaultCourseDays: 5,
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            defaultQuantity: 10,
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 7600,
            version: 1,
          }],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: signed ? [] : [{
            caseId: 'case-1',
            diagnosticReportId: 'diagnostic-report-1',
            encounterId: 'encounter-1',
            encounterVersion: '6',
            patient,
            presentation: doctorPresentation,
            status: 'revisit-draft',
            taskId: 'task-doctor-1',
            taskVersion: '2',
            triage: doctorTriage,
          }],
          ...pagination(signed ? 0 : 1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-1',
          drafts: {
            document: {
              assessment: '甲型流感，生命体征稳定。',
              composition: { id: 'composition-draft-1', resourceType: 'Composition' },
              medicationRequestIds: ['medication-request-1'],
              plan: '口服抗病毒药物，对症处理，必要时复诊。',
              version: 1,
            },
            prescription: {
              id: 'prescription-1',
              items: [{
                doseText: '75 mg',
                frequencyCode: 'BID',
                medicationId: 'medication-oseltamivir',
                medicationRequestId: 'medication-request-1',
                quantity: 10,
                versionId: '1',
              }],
              number: 'CM-RX-20260824-0001',
              status: 'draft',
              version: 1,
            },
            revisit: {
              conditionId: 'condition-1',
              conditionVersion: '1',
              diagnosis: { code: 'J10.1', display: '甲型流感' },
              version: 1,
            },
          },
          encounter: {
            id: 'encounter-1',
            status: signed ? 'completed' : 'in-progress',
            versionId: signed ? '7' : '6',
          },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          report: {
            id: 'diagnostic-report-1',
            results: [{ code: '80382-5', interpretation: 'POS', value: true }],
            status: 'final',
          },
          status: signed ? 'awaiting-medication-payment' : 'revisit-draft',
          taskId: 'task-doctor-1',
          taskVersion: signed ? '3' : '2',
          triage: doctorTriage,
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/preview-sign') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: unknown
        }
        expect(body).toEqual({
          expectedVersions,
          input: {
            expectedDraftVersions: {
              documentDraft: 1,
              prescription: 1,
              revisitDraft: 1,
            },
          },
        })
        return Response.json(commandResponse({
          commitToken: 'clinical-sign-token-123456',
          expiresAt: '2026-08-24T08:05:00.000Z',
          medicationTotalFen: 7600,
          previewId: 'clinical-sign-preview-1',
          summary: {
            diagnosis: { code: 'J10.1', display: '甲型流感' },
            document: {
              assessment: '甲型流感，生命体征稳定。',
              plan: '口服抗病毒药物，对症处理，必要时复诊。',
            },
            medications: [{
              medicationId: 'medication-oseltamivir',
              medicationRequestId: 'medication-request-1',
              nameEn: 'Oseltamivir capsules',
              nameZh: '磷酸奥司他韦胶囊',
              quantity: 10,
              subtotalFen: 7600,
              unitPriceFen: 760,
            }],
          },
        }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/sign-and-complete') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: unknown
        }
        expect(body).toEqual({
          expectedVersions,
          input: {
            commitToken: 'clinical-sign-token-123456',
            previewId: 'clinical-sign-preview-1',
          },
        })
        signed = true
        return Response.json(commandResponse({
          bundleId: 'bundle-1',
          chargeItemId: 'charge-medication-1',
          compositionId: 'composition-1',
          encounterId: 'encounter-1',
          encounterVersion: '7',
          provenanceId: 'provenance-1',
          status: 'awaiting-medication-payment',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '诊断' }))
    await user.click(await screen.findByRole('button', { name: '预览签署' }))
    expect(await screen.findByRole('heading', { name: '签署预览' })).toBeTruthy()
    expect(screen.getByText('J10.1 · 甲型流感')).toBeTruthy()
    expect(screen.getAllByText('¥76.00').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '确认签署并完诊' }))

    expect(await screen.findByText('Encounter 已完成')).toBeTruthy()
    expect(screen.getByText('待药品缴费')).toBeTruthy()
  })

  it('recovers a versioned structured Clinical Document draft and signs it without completing the Encounter', async () => {
    window.history.replaceState(null, '', '/consultation')
    let document = structuredClinicalDocument
    let documentVersion = 1
    let saveAttempt = 0
    let signed = false
    let resolveConflictingSave: ((response: Response) => void) | undefined
    const conflictingSave = new Promise<Response>(resolve => {
      resolveConflictingSave = resolve
    })
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-1',
            encounterId: 'encounter-1',
            encounterVersion: '1',
            patient,
            presentation: doctorPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-1',
            taskVersion: '1',
            triage: doctorTriage,
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-1',
          clinicalDocument: {
            draft: {
              ...document,
              updatedAt: '2026-08-24T09:00:00+08:00',
              version: documentVersion,
            },
            signed: signed ? [{
              bundleId: 'bundle-structured-1',
              compositionId: 'composition-structured-1',
              compositionVersion: '1',
              content: document,
              documentId: 'document-structured-1',
              provenanceId: 'provenance-structured-1',
              revisionNumber: 1,
              signedAt: '2026-08-24T09:00:00+08:00',
            }] : [],
          },
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-1', status: 'in-progress', versionId: '1' },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-1',
          taskVersion: '1',
          triage: doctorTriage,
        })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/clinical-document/draft') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: { document: typeof structuredClinicalDocument; expectedDraftVersion: number }
        }
        expect(init?.method).toBe('PUT')
        expect(body.expectedVersions).toEqual({ 'Encounter/encounter-1': '1' })
        saveAttempt += 1
        if (saveAttempt === 1) {
          expect(body.input.expectedDraftVersion).toBe(1)
          document = {
            ...structuredClinicalDocument,
            assessment: '另一工作站已经补充了最新评估。',
          }
          documentVersion = 2
          return conflictingSave
        }
        expect(body.input.expectedDraftVersion).toBe(2)
        expect(body.input.document).toEqual({
          ...structuredClinicalDocument,
          assessment: '复核并合并并发编辑后的最终评估。',
        })
        document = body.input.document
        documentVersion = 3
        return Response.json(commandResponse({ caseId: 'case-1', draftVersion: 3 }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/clinical-document/actions/preview-sign') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: { expectedDraftVersion: number }
        }
        expect(body).toEqual({
          expectedVersions: { 'Encounter/encounter-1': '1' },
          input: { expectedDraftVersion: 3 },
        })
        return Response.json(commandResponse({
          commitToken: 'structured-sign-token-123456',
          document: { content: document, version: 3 },
          expiresAt: '2026-08-24T09:05:00.000Z',
          previewId: 'structured-sign-preview-1',
        }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/clinical-document/actions/sign') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: { commitToken: string; previewId: string }
        }
        expect(body).toEqual({
          expectedVersions: { 'Encounter/encounter-1': '1' },
          input: {
            commitToken: 'structured-sign-token-123456',
            previewId: 'structured-sign-preview-1',
          },
        })
        signed = true
        return Response.json(commandResponse({
          bundleId: 'bundle-structured-1',
          compositionId: 'composition-structured-1',
          compositionVersion: '1',
          documentId: 'document-structured-1',
          provenanceId: 'provenance-structured-1',
          revisionNumber: 1,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    const recoveredForm = await screen.findByRole('form', { name: '结构化病历' })
    expect((within(recoveredForm).getByLabelText('主诉') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.chiefComplaint)
    expect((within(recoveredForm).getByLabelText('现病史') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.historyOfPresentIllness)
    expect((within(recoveredForm).getByLabelText('查体') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.physicalExamination)
    expect((within(recoveredForm).getByLabelText('评估') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.assessment)
    expect((within(recoveredForm).getByLabelText('处置') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.disposition)
    expect((within(recoveredForm).getByLabelText('随访') as HTMLTextAreaElement).value)
      .toBe(structuredClinicalDocument.followUp)

    await user.clear(within(recoveredForm).getByLabelText('评估'))
    await user.type(within(recoveredForm).getByLabelText('评估'), '本工作站准备保存的评估。')
    await user.click(within(recoveredForm).getByRole('button', { name: '签署病历' }))
    const pendingButton = await within(recoveredForm).findByRole('button', { name: '正在准备签署' })
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveConflictingSave?.(Response.json({
        error: {
          code: 'WORKFLOW_CONFLICT',
          message: 'The Clinical Document draft version has changed',
        },
      }, { status: 409 }))
    })
    expect(await screen.findByText('操作冲突')).toBeTruthy()
    const refreshedForm = await screen.findByRole('form', { name: '结构化病历' })
    expect((within(refreshedForm).getByLabelText('评估') as HTMLTextAreaElement).value)
      .toBe('另一工作站已经补充了最新评估。')

    await user.clear(within(refreshedForm).getByLabelText('评估'))
    await user.type(within(refreshedForm).getByLabelText('评估'), '复核并合并并发编辑后的最终评估。')
    await user.click(within(refreshedForm).getByRole('button', { name: '签署病历' }))
    const previewDialog = await screen.findByRole('alertdialog', { name: '确认签署病历' })
    expect(within(previewDialog).getByText('复核并合并并发编辑后的最终评估。')).toBeTruthy()
    await user.click(within(previewDialog).getByRole('button', { name: '确认签署病历' }))

    const signedAlert = (await screen.findByText('Encounter 仍为诊疗中')).closest('[role="alert"]')
    expect(signedAlert).not.toBeNull()
    expect(within(signedAlert as HTMLElement).getByText('病历已签署')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '签署历史' })).toBeTruthy()
    expect(screen.getByText('版本 1')).toBeTruthy()
  })

  it('binds a Clinical Document revision confirmation to its previewed source version', async () => {
    window.history.replaceState(null, '', '/consultation')
    let caseDetailRequests = 0
    let clinicalRevisionRequest: unknown
    let clinicalRevisionPath: string | undefined
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    let signedDocuments = [{
      bundleId: 'bundle-structured-1',
      compositionId: 'composition-structured-1',
      compositionVersion: '1',
      content: structuredClinicalDocument,
      documentId: 'document-structured-1',
      provenanceId: 'provenance-structured-1',
      revisionNumber: 1,
      signedAt: '2026-08-24T09:00:00+08:00',
    }, {
      bundleId: 'bundle-structured-2',
      compositionId: 'composition-structured-2',
      compositionVersion: '1',
      content: revisedStructuredClinicalDocument,
      documentId: 'document-structured-2',
      provenanceId: 'provenance-structured-2',
      revisionNumber: 2,
      revisionOfCompositionId: 'composition-structured-1',
      revisionReason: '检验结果回报后修订诊断与处置。',
      signedAt: '2026-08-24T09:10:00+08:00',
    }]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: true,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({
          items: [{
            caseId: 'case-1',
            diagnosticReportId: 'diagnostic-report-1',
            encounterId: 'encounter-1',
            encounterVersion: '5',
            patient,
            presentation: doctorPresentation,
            status: 'awaiting-revisit',
            taskId: 'task-doctor-1',
            taskVersion: '1',
            triage: doctorTriage,
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-1') {
        caseDetailRequests += 1
        return Response.json({
          allergies: [],
          caseId: 'case-1',
          clinicalDocument: { signed: signedDocuments },
          consultation: { turns: [], version: 1 },
          encounter: { id: 'encounter-1', status: 'in-progress', versionId: '5' },
          patient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'awaiting-revisit',
          taskId: 'task-doctor-1',
          taskVersion: '1',
          triage: doctorTriage,
        })
      }
      if (
        url.pathname.startsWith('/api/his/v1/clinical-documents/')
        && url.pathname.endsWith('/actions/revise')
      ) {
        clinicalRevisionPath = url.pathname
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: { document: typeof structuredClinicalDocument; reason: string }
        }
        clinicalRevisionRequest = body
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            conflict: {
              currentStatus: 'superseded',
              owner: 'clinical-document',
              resource: 'Composition/composition-structured-2',
            },
            message: 'The Clinical Document is superseded; only the latest version can be revised',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: Infinity },
      },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DoctorWorkspace locale="zh-CN" session={doctorSession} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: '签署历史' })).toBeTruthy()
    expect(screen.getByText('版本 1')).toBeTruthy()
    expect(screen.getByText('版本 2')).toBeTruthy()
    expect(screen.getByText(structuredClinicalDocument.assessment)).toBeTruthy()
    expect(screen.getByText(/检验结果回报后修订诊断与处置。/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '提交病历修订' })).toHaveLength(1)

    const revisionForm = screen.getByRole('form', { name: '修订病历版本' })
    await user.clear(within(revisionForm).getByLabelText('评估'))
    await user.type(within(revisionForm).getByLabelText('评估'), '修订后明确为甲型流感轻症。')
    await user.type(within(revisionForm).getByLabelText('修订原因'), '补充复诊时限和危险征象。')
    await user.click(within(revisionForm).getByRole('button', { name: '提交病历修订' }))

    const revisionDialog = await screen.findByRole('alertdialog', { name: '确认提交病历修订' })
    expect(clinicalRevisionRequest).toBeUndefined()
    expect(within(revisionDialog).getByText('修订后明确为甲型流感轻症。')).toBeTruthy()
    expect(within(revisionDialog).getByText('补充复诊时限和危险征象。')).toBeTruthy()
    signedDocuments = [...signedDocuments, {
      bundleId: 'bundle-structured-concurrent',
      compositionId: 'composition-structured-concurrent',
      compositionVersion: '1',
      content: {
        ...revisedStructuredClinicalDocument,
        assessment: '另一工作站已提交的并发修订。',
      },
      documentId: 'document-structured-concurrent',
      provenanceId: 'provenance-structured-concurrent',
      revisionNumber: 3,
      revisionOfCompositionId: 'composition-structured-2',
      revisionReason: '并发修订。',
      signedAt: '2026-08-24T09:20:00+08:00',
    }]
    await queryClient.invalidateQueries({ queryKey: ['doctor-case'] })
    await waitFor(() => expect(caseDetailRequests).toBeGreaterThan(1))
    await user.click(within(revisionDialog).getByRole('button', { name: '确认提交修订' }))

    await waitFor(() => {
      expect(clinicalRevisionPath).toBe(
        '/api/his/v1/clinical-documents/composition-structured-2/actions/revise',
      )
    })
    expect(clinicalRevisionRequest).toMatchObject({
      expectedVersions: {
        'Composition/composition-structured-2': '1',
        'Encounter/encounter-1': '5',
      },
      input: {
        document: { assessment: '修订后明确为甲型流感轻症。' },
        reason: '补充复诊时限和危险征象。',
      },
    })
    expect(await screen.findByText(
      '病历当前状态为“已被后续版本替代”。请刷新后重新确认。',
    )).toBeTruthy()
    expect(screen.queryByText(
      'The Clinical Document is superseded; only the latest version can be revised',
    )).toBeNull()
  })

  it('searches completed cases with controlled patient, date, and diagnosis filters and shows the empty state', async () => {
    window.history.replaceState(null, '', '/consultation')
    const listRequests: URL[] = []
    stubDoctorCompletedCaseLibrary({
      list: { items: [], ...pagination(0) },
      onListRequest: url => listRequests.push(url),
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '完诊' }))
    expect(await screen.findByText('未找到已完诊病例')).toBeTruthy()

    await user.type(screen.getByLabelText('患者 ID'), 'patient-synthetic-1')
    await user.type(screen.getByLabelText('完诊开始日期'), '2026-08-01')
    await user.type(screen.getByLabelText('完诊结束日期'), '2026-08-24')
    await user.click(screen.getByRole('combobox', { name: '诊断' }))
    await user.click(await screen.findByRole('option', { name: '流感伴其他呼吸道表现 · J10.1' }))
    await user.click(screen.getByRole('button', { name: '检索病例' }))

    await waitFor(() => expect(listRequests.length).toBeGreaterThanOrEqual(2))
    expect(Object.fromEntries(listRequests.at(-1)?.searchParams ?? [])).toEqual({
      completedFrom: '2026-08-01',
      completedTo: '2026-08-24',
      diagnosisCatalogItemId: 'diagnosis-influenza-a',
      page: '1',
      pageSize: '20',
      patientId: 'patient-synthetic-1',
    })
    expect(screen.getByText('请调整筛选条件后重试。')).toBeTruthy()
  })

  it('opens long completed case facts and preserves the server timeline in read-only details', async () => {
    window.history.replaceState(null, '', '/consultation')
    const longPatientName = '合成患者欧阳晨曦阿依古丽娜扎诸葛明远司马清和上官云舒测试长姓名'
    const longAssessment = '患者持续高热伴咽痛，结合流行病学接触史、甲型流感抗原结果及完整查体，当前生命体征稳定，未见呼吸衰竭或其他重症危险征象；已详细告知居家隔离、补液、体温监测、复诊时限与需要立即就医的危险表现。'
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-completed-1',
      identifier: 'CM-SYN-COMPLETED-001',
      name: longPatientName,
      synthetic: true,
      versionId: '2',
    } as const
    const diagnosisEntry = {
      catalogItemId: 'diagnosis-influenza-a',
      code: 'J10.1',
      conditionId: 'condition-completed-1',
      conditionVersion: '1',
      display: '流感伴其他呼吸道表现',
      note: '结合抗原结果与临床表现。',
      role: 'primary',
      system: 'http://hl7.org/fhir/sid/icd-10',
    } as const
    const detail = {
      caseId: 'case-completed-1',
      clinicalDocuments: [{
        bundleId: 'bundle-completed-1',
        compositionId: 'composition-completed-1',
        compositionVersion: '1',
        content: {
          ...structuredClinicalDocument,
          assessment: longAssessment,
        },
        correctionSupported: true,
        documentId: 'document-completed-1',
        provenanceId: 'provenance-completed-1',
        revisionNumber: 1,
        signedAt: '2026-08-24T08:20:00+08:00',
      }],
      completedAt: '2026-08-24T09:00:00+08:00',
      consultation: {
        turns: [{
          actorId: null, practitionerId: null, id: 'legacy-question', kind: 'text',
          messageText: '症状何时开始？', personaRevision: null,
          recordedAt: '2026-08-24T08:05:00+08:00', reportReference: null,
          sequence: 1, source: 'legacy-question-answer', speaker: 'doctor',
        }, {
          actorId: null, practitionerId: null, id: 'legacy-answer', kind: 'text',
          messageText: '症状自前日晚间开始，最高体温 38.7 摄氏度，并伴有持续咽痛、乏力及同住家属近期流感样症状。', personaRevision: null,
          recordedAt: '2026-08-24T08:05:00+08:00', reportReference: null,
          sequence: 2, source: 'legacy-question-answer', speaker: 'patient',
        }], version: 3,
      },
      diagnosis: {
        confirmedAt: '2026-08-24T08:30:00+08:00',
        entries: [diagnosisEntry],
        id: 'diagnosis-confirmation-completed-1',
        provenanceId: 'provenance-diagnosis-completed-1',
        revisionNumber: 1,
      },
      encounter: { id: 'encounter-completed-1', status: 'completed', versionId: '6' },
      laboratoryRequests: [],
      medicationConclusion: {
        noMedication: {
          authoredAt: '2026-08-24T08:40:00+08:00',
          authoredByActorId: 'actor-outpatient-doctor',
          authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
          id: 'no-medication-completed-1',
          version: 1,
        },
        prescription: {
          authoredAt: '2026-08-24T08:35:00+08:00',
          authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
          id: 'prescription-completed-1',
          items: [{
            catalogItemId: 'medication-oseltamivir',
            courseDays: 5,
            display: '磷酸奥司他韦胶囊',
            doseText: '75 mg',
            frequencyCode: 'BID',
            medicationRequestId: 'medication-request-completed-1',
            medicationRequestVersion: '2',
            quantity: 10,
          }],
          number: 'RX-COMPLETED-001',
          status: 'withdrawn',
          version: 2,
          withdrawalSupported: false,
          withdrawal: {
            id: 'prescription-withdrawal-completed-1',
            prescriptionId: 'prescription-completed-1',
            version: 1,
            withdrawnAt: '2026-08-24T08:38:00+08:00',
            withdrawnByActorId: 'actor-outpatient-doctor',
            withdrawnByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
          },
        },
      },
      patient,
      timeline: [{
        kind: 'consultation-recorded',
        occurredAt: '2026-08-24T08:05:00+08:00',
        reference: 'ConsultationRecord/consultation-record-completed-1',
        relatedReferences: ['Encounter/encounter-completed-1'],
      }, {
        kind: 'clinical-document-signed',
        occurredAt: '2026-08-24T08:20:00+08:00',
        reference: 'Composition/composition-completed-1',
        relatedReferences: ['Bundle/bundle-completed-1'],
      }, {
        kind: 'diagnosis-confirmed',
        occurredAt: '2026-08-24T08:30:00+08:00',
        reference: 'DiagnosisConfirmation/diagnosis-confirmation-completed-1',
        relatedReferences: ['Condition/condition-completed-1'],
      }, {
        kind: 'prescription-issued',
        occurredAt: '2026-08-24T08:35:00+08:00',
        reference: 'Prescription/prescription-completed-1',
        relatedReferences: ['MedicationRequest/medication-request-completed-1'],
      }, {
        kind: 'prescription-withdrawn',
        occurredAt: '2026-08-24T08:38:00+08:00',
        reference: 'PrescriptionWithdrawal/prescription-withdrawal-completed-1',
        relatedReferences: ['Prescription/prescription-completed-1'],
      }, {
        kind: 'no-medication-confirmed',
        occurredAt: '2026-08-24T08:40:00+08:00',
        reference: 'NoMedicationConclusion/no-medication-completed-1',
        relatedReferences: [],
      }, {
        kind: 'encounter-completed',
        occurredAt: '2026-08-24T09:00:00+08:00',
        reference: 'Encounter/encounter-completed-1',
        relatedReferences: [],
      }],
    } satisfies DoctorCompletedCaseDetail
    stubDoctorCompletedCaseLibrary({
      detail,
      list: {
        items: [{
          caseId: detail.caseId,
          completedAt: detail.completedAt,
          encounterId: detail.encounter.id,
          encounterVersion: detail.encounter.versionId,
          patient,
          primaryDiagnosis: diagnosisEntry,
        }],
        ...pagination(1),
      },
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '完诊' }))
    expect(await screen.findByText(longPatientName)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: `查看病例 ${longPatientName}` }))

    expect(await screen.findByRole('heading', { name: '已完诊病例详情' })).toBeTruthy()
    expect(screen.getByText('只读详情')).toBeTruthy()
    expect(screen.getByText(longAssessment)).toBeTruthy()
    expect(screen.getByText('处方号 RX-COMPLETED-001')).toBeTruthy()
    expect(screen.getByText('已确认无需用药')).toBeTruthy()
    expect(screen.getAllByText('Composition/composition-completed-1').length).toBeGreaterThanOrEqual(1)
    const timeline = screen.getByRole('region', { name: '业务时间线' })
    expect(within(timeline).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('记录问诊'),
      expect.stringContaining('签署病历'),
      expect.stringContaining('确认诊断'),
      expect.stringContaining('开具处方'),
      expect.stringContaining('撤回处方'),
      expect.stringContaining('确认无需用药'),
      expect.stringContaining('完成 Encounter'),
    ])
    for (const name of ['保存病历草稿', '提交病历修订', '确认已阅', '撤回处方', '确认完诊']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('withdraws a paid undispensed prescription from its completed case', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-completed-paid-1',
      identifier: 'CM-SYN-PAID-001',
      name: '合成患者已收费处方',
      synthetic: true,
      versionId: '2',
    } as const
    const prescription = {
      authoredAt: '2026-08-24T08:35:00+08:00',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      id: 'prescription-completed-paid-1',
      items: [{
        catalogItemId: 'medication-oseltamivir',
        courseDays: 5,
        display: '磷酸奥司他韦胶囊',
        doseText: '75 mg',
        frequencyCode: 'BID',
        medicationRequestId: 'medication-request-completed-paid-1',
        medicationRequestVersion: '2',
        quantity: 10,
      }],
      number: 'RX-COMPLETED-PAID-001',
      status: 'paid' as const,
      version: 2,
    }
    const withdrawal = {
      id: 'prescription-withdrawal-completed-paid-1',
      prescriptionId: prescription.id,
      version: 1,
      withdrawnAt: '2026-08-24T09:05:00+08:00',
      withdrawnByActorId: 'actor-outpatient-doctor',
      withdrawnByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
    }
    let activeDetail: DoctorCaseDetail = {
      allergies: [],
      caseId: 'case-completed-paid-1',
      consultation: { turns: [], version: 1 },
      encounter: { id: 'encounter-completed-paid-1', status: 'completed', versionId: '6' },
      medicationConclusion: { draftVersion: 3, prescription },
      patient,
      presentation: doctorPresentation,
      priorFacts: [],
      status: 'completed',
      taskId: 'task-completed-paid-1',
      taskVersion: '2',
    }
    let completedDetail: DoctorCompletedCaseDetail = {
      caseId: activeDetail.caseId,
      clinicalDocuments: [],
      completedAt: '2026-08-24T09:00:00+08:00',
      encounter: {
        id: activeDetail.encounter.id,
        status: 'completed',
        versionId: activeDetail.encounter.versionId,
      },
      laboratoryRequests: [],
      medicationConclusion: {
        prescription: { ...prescription, withdrawalSupported: true },
      },
      patient,
      timeline: [{
        kind: 'encounter-completed',
        occurredAt: '2026-08-24T09:00:00+08:00',
        reference: `Encounter/${activeDetail.encounter.id}`,
        relatedReferences: [],
      }],
    }
    let withdrawalRequest: unknown
    stubDoctorCompletedCaseLibrary({
      list: {
        items: [{
          caseId: completedDetail.caseId,
          completedAt: completedDetail.completedAt,
          encounterId: completedDetail.encounter.id,
          encounterVersion: completedDetail.encounter.versionId,
          patient,
        }],
        ...pagination(1),
      },
      onRequest: (url, init) => {
        if (url.pathname === `/api/his/v1/doctor/cases/${activeDetail.caseId}`) {
          return Response.json(activeDetail)
        }
        if (url.pathname === `/api/his/v1/doctor/completed-cases/${completedDetail.caseId}`) {
          return Response.json(completedDetail)
        }
        if (url.pathname === `/api/his/v1/prescriptions/${prescription.id}/actions/withdraw`) {
          withdrawalRequest = JSON.parse(String(init?.body))
          const withdrawnPrescription = {
            ...prescription,
            status: 'withdrawn' as const,
            version: 3,
            withdrawal,
          }
          activeDetail = {
            ...activeDetail,
            medicationConclusion: { draftVersion: 3, prescription: withdrawnPrescription },
          }
          completedDetail = {
            ...completedDetail,
            medicationConclusion: {
              prescription: { ...withdrawnPrescription, withdrawalSupported: false },
            },
            timeline: [...completedDetail.timeline, {
              kind: 'prescription-withdrawn',
              occurredAt: withdrawal.withdrawnAt,
              reference: `PrescriptionWithdrawal/${withdrawal.id}`,
              relatedReferences: [`Prescription/${prescription.id}`],
            }],
          }
          return Response.json(commandResponse({
            medicationRequests: [{
              id: prescription.items[0]?.medicationRequestId,
              version: '3',
            }],
            prescriptionId: prescription.id,
            prescriptionVersion: 3,
            status: 'withdrawn',
            withdrawal,
          }))
        }
        return undefined
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: Infinity },
      },
    })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={queryClient}>
        <DoctorWorkspace locale="zh-CN" session={doctorSession} />
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    await user.click(await screen.findByRole('button', { name: '撤回处方' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-medication-conclusion')
    })
    await user.click(await screen.findByRole('tab', { name: '处方' }))
    await user.click(await screen.findByRole('button', { name: '撤回处方' }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认撤回处方' })
    expect(within(dialog).getByText(prescription.number)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: '确认撤回' }))

    expect(await screen.findByText('处方已撤回')).toBeTruthy()
    expect(withdrawalRequest).toEqual({
      expectedVersions: {
        [`MedicationRequest/${prescription.items[0]?.medicationRequestId}`]: '2',
      },
      input: { expectedPrescriptionVersion: 2 },
    })
    await user.click(screen.getByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText(/处方已撤回/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
  })

  it('keeps legacy completed facts readable without unsupported correction navigation', async () => {
    window.history.replaceState(null, '', '/consultation')
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-completed-legacy-1',
      identifier: 'CM-SYN-LEGACY-001',
      name: '合成患者旧版病例',
      synthetic: true,
      versionId: '2',
    } as const
    const detail = {
      caseId: 'case-completed-legacy-1',
      clinicalDocuments: [{
        bundleId: 'bundle-completed-legacy-1',
        compositionId: 'composition-completed-legacy-1',
        compositionVersion: '1',
        content: {
          assessment: '甲型流感，生命体征稳定。',
          plan: '口服抗病毒药物，对症处理，必要时复诊。',
        },
        correctionSupported: false,
        documentId: 'document-completed-legacy-1',
        provenanceId: 'provenance-completed-legacy-1',
        revisionNumber: 1,
        signedAt: '2026-08-24T08:20:00+08:00',
      }],
      completedAt: '2026-08-24T09:00:00+08:00',
      encounter: {
        id: 'encounter-completed-legacy-1',
        status: 'completed',
        versionId: '6',
      },
      laboratoryRequests: [{
        catalogDisplay: '发热检验组合',
        correctionSupported: false,
        id: 'legacy-service-request-completed-1',
        indicationCode: 'legacy-indication',
        previousReports: [],
        report: {
          conclusion: '甲型流感抗原阳性。',
          diagnosticReportId: 'diagnostic-report-completed-legacy-1',
          diagnosticReportVersion: '1',
          issuedAt: '2026-08-24T08:40:00+08:00',
          revisionNumber: 1,
          results: [{
            code: '80382-5',
            display: '甲型流感病毒抗原',
            interpretation: 'positive',
            observationId: 'observation-completed-legacy-1',
            value: true,
          }],
          specimenId: 'specimen-completed-legacy-1',
          status: 'final',
        },
        serviceRequestId: 'service-request-completed-legacy-1',
        serviceRequestVersion: '1',
        status: 'reported',
        taskId: 'task-completed-legacy-1',
        taskVersion: '4',
        version: 1,
      }],
      medicationConclusion: {
        prescription: {
          authoredAt: '2026-08-24T08:35:00+08:00',
          authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
          id: 'prescription-completed-legacy-1',
          items: [{
            catalogItemId: 'medication-oseltamivir',
            courseDays: 5,
            display: '磷酸奥司他韦胶囊',
            doseText: '75 mg',
            frequencyCode: 'BID',
            medicationRequestId: 'medication-request-completed-legacy-1',
            medicationRequestVersion: '1',
            quantity: 10,
          }],
          number: 'RX-COMPLETED-LEGACY-001',
          status: 'signed',
          version: 1,
          withdrawalSupported: false,
        },
      },
      patient,
      timeline: [],
    } satisfies DoctorCompletedCaseDetail
    stubDoctorCompletedCaseLibrary({
      detail,
      list: {
        items: [{
          caseId: detail.caseId,
          completedAt: detail.completedAt,
          encounterId: detail.encounter.id,
          encounterVersion: detail.encounter.versionId,
          patient,
        }],
        ...pagination(1),
      },
      session: administratorAsDoctorSession,
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))

    expect(await screen.findByText('甲型流感，生命体征稳定。')).toBeTruthy()
    expect(screen.getByText('甲型流感抗原阳性。')).toBeTruthy()
    expect(screen.getByText('处方号 RX-COMPLETED-LEGACY-001')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更正病历' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更正检验报告' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
  })

  it('completes all five controlled clinical correction classes and shows the final timeline', async () => {
    window.history.replaceState(null, '', '/consultation')
    let clinicalRevisionRequest: unknown
    let laboratoryCancellationRequest: unknown
    let laboratoryCorrectionRequest: unknown
    let laboratoryDraftDeletionRequest: unknown
    let prescriptionDraftDeletionRequest: unknown
    let prescriptionDraftRequest: unknown
    let prescriptionIssueRequest: unknown
    let prescriptionWithdrawalRequest: unknown
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'patient-completed-correction-1',
      identifier: 'CM-SYN-CORRECTION-001',
      name: '合成患者病例更正',
      synthetic: true,
      versionId: '2',
    } as const
    const prescriptionDraftItem = {
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    } as const
    const issuedPrescriptionItem = {
      ...prescriptionDraftItem,
      display: '磷酸奥司他韦胶囊',
      medicationRequestId: 'medication-request-correction-replacement-1',
      medicationRequestVersion: '1',
    }
    const issuedPrescription = {
      authoredAt: '2026-08-24T09:07:00+08:00',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      id: 'prescription-correction-replacement-1',
      items: [issuedPrescriptionItem],
      number: 'CM-RX-20260824-0032',
      status: 'signed' as const,
      version: 1,
    }
    const withdrawal = {
      id: 'prescription-withdrawal-correction-1',
      prescriptionId: issuedPrescription.id,
      version: 1,
      withdrawnAt: '2026-08-24T09:08:00+08:00',
      withdrawnByActorId: 'actor-administrator',
      withdrawnByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
    }
    const withdrawnPrescription = {
      ...issuedPrescription,
      status: 'withdrawn' as const,
      version: 2,
      withdrawal,
    }
    const signedDocument = {
      bundleId: 'bundle-completed-correction-1',
      compositionId: 'composition-completed-correction-1',
      compositionVersion: '1',
      content: structuredClinicalDocument,
      documentId: 'document-completed-correction-1',
      provenanceId: 'provenance-completed-correction-1',
      revisionNumber: 1,
      signedAt: '2026-08-24T08:20:00+08:00',
    } as const
    const completedSignedDocument = {
      ...signedDocument,
      correctionSupported: true,
    } as const
    const report: NonNullable<LaboratoryRequest['report']> = {
      acknowledgement: {
        acknowledgedAt: '2026-08-24T08:45:00+08:00',
        acknowledgedBy: 'actor-outpatient-doctor',
        id: 'laboratory-acknowledgement-correction-1',
      },
      conclusion: 'C 反应蛋白升高，结合临床表现评估。',
      diagnosticReportId: 'diagnostic-report-correction-1',
      diagnosticReportVersion: '1',
      issuedAt: '2026-08-24T08:40:00+08:00',
      revisionNumber: 1,
      results: [{
        code: '1988-5',
        display: 'C 反应蛋白',
        interpretation: 'high',
        observationId: 'observation-correction-1',
        referenceRange: { high: 10, low: 0, text: '0-10 mg/L' },
        unit: {
          code: 'mg/L',
          display: 'mg/L',
          system: 'http://unitsofmeasure.org',
        },
        value: 28.6,
      }],
      specimenId: 'specimen-correction-1',
      status: 'final',
    }
    const laboratoryRequest: LaboratoryRequest = {
      catalogItemId: 'lab-crp',
      id: 'laboratory-request-correction-1',
      indicationCode: 'fever',
      previousReports: [],
      report,
      serviceRequestId: 'service-request-correction-1',
      serviceRequestVersion: '2',
      status: 'acknowledged',
      taskId: 'task-laboratory-correction-1',
      taskVersion: '5',
      version: 5,
    }
    const issuedLaboratoryRequest: LaboratoryRequest = {
      catalogItemId: 'lab-cbc',
      id: 'laboratory-request-cancellation-1',
      indicationCode: 'fever',
      previousReports: [],
      serviceRequestId: 'service-request-cancellation-1',
      serviceRequestVersion: '1',
      status: 'issued',
      taskId: 'task-laboratory-cancellation-1',
      taskVersion: '1',
      version: 1,
    }
    const completedLaboratoryRequest = {
      ...laboratoryRequest,
      correctionSupported: true,
    } as const
    const completedIssuedLaboratoryRequest = {
      ...issuedLaboratoryRequest,
      correctionSupported: false,
    } as const
    const completedDetail = {
      caseId: 'case-completed-correction-1',
      clinicalDocuments: [completedSignedDocument],
      completedAt: '2026-08-24T09:00:00+08:00',
      encounter: {
        id: 'encounter-completed-correction-1',
        status: 'completed',
        versionId: '6',
      },
      laboratoryRequests: [completedIssuedLaboratoryRequest, completedLaboratoryRequest],
      patient,
      timeline: [{
        kind: 'clinical-document-signed',
        occurredAt: signedDocument.signedAt,
        reference: `Composition/${signedDocument.compositionId}`,
        relatedReferences: [`Bundle/${signedDocument.bundleId}`],
      }, {
        kind: 'laboratory-request-issued',
        occurredAt: '2026-08-24T08:30:00+08:00',
        reference: `ServiceRequest/${issuedLaboratoryRequest.serviceRequestId}`,
        relatedReferences: [`Task/${issuedLaboratoryRequest.taskId}`],
      }, {
        kind: 'laboratory-report-issued',
        occurredAt: report.issuedAt,
        reference: `DiagnosticReport/${report.diagnosticReportId}`,
        relatedReferences: report.results.map(result => `Observation/${result.observationId}`),
      }],
    } satisfies DoctorCompletedCaseDetail
    const revisedDocument: DoctorCompletedCaseDetail['clinicalDocuments'][number] = {
      ...completedSignedDocument,
      bundleId: 'bundle-completed-correction-2',
      compositionId: 'composition-completed-correction-2',
      documentId: 'document-completed-correction-2',
      provenanceId: 'provenance-completed-correction-2',
      revisionNumber: 2,
      revisionOfCompositionId: signedDocument.compositionId,
      revisionReason: '补充检验复核后的处置说明。',
      signedAt: '2026-08-24T09:10:00+08:00',
    }
    const revisedReport: NonNullable<LaboratoryRequest['report']> = {
      conclusion: '复核后 C 反应蛋白仍升高。',
      diagnosticReportId: 'diagnostic-report-correction-2',
      diagnosticReportVersion: '1',
      issuedAt: '2026-08-24T09:20:00+08:00',
      revisionNumber: 2,
      revisionOfDiagnosticReportId: report.diagnosticReportId,
      revisionReason: '复核仪器原始数据后更正。',
      results: report.results.map(result => typeof result.value === 'number' && 'unit' in result
        ? {
            ...result,
            observationId: 'observation-correction-2',
            value: 29.1,
          }
        : result),
      specimenId: report.specimenId,
      status: 'final',
    }
    let currentCompletedDetail: DoctorCompletedCaseDetail = completedDetail
    const clinicalRevisionEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'clinical-document-revised',
      occurredAt: revisedDocument.signedAt,
      reference: `Composition/${revisedDocument.compositionId}`,
      relatedReferences: [`Composition/${signedDocument.compositionId}`],
    }
    const laboratoryCorrectionEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'laboratory-report-revised',
      occurredAt: revisedReport.issuedAt,
      reference: `DiagnosticReport/${revisedReport.diagnosticReportId}`,
      relatedReferences: [`DiagnosticReport/${report.diagnosticReportId}`],
    }
    const laboratoryCancellationEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'laboratory-request-cancelled',
      occurredAt: '2026-08-24T09:05:00+08:00',
      reference: `LaboratoryRequest/${issuedLaboratoryRequest.id}`,
      relatedReferences: [
        `ServiceRequest/${issuedLaboratoryRequest.serviceRequestId}`,
        `Task/${issuedLaboratoryRequest.taskId}`,
      ],
    }
    const laboratoryDraftDeletionEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'laboratory-request-draft-deleted',
      occurredAt: '2026-08-24T09:01:00+08:00',
      reference: 'ActionTrace/trace-laboratory-draft-deletion-1',
      relatedReferences: [`LaboratoryRequestDraft/${completedDetail.caseId}`],
    }
    const prescriptionIssuedEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'prescription-issued',
      occurredAt: issuedPrescription.authoredAt,
      reference: `Prescription/${issuedPrescription.id}`,
      relatedReferences: issuedPrescription.items.map(
        item => `MedicationRequest/${item.medicationRequestId}`,
      ),
    }
    const prescriptionDraftDeletionEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'prescription-draft-deleted',
      occurredAt: '2026-08-24T09:06:00+08:00',
      reference: 'ActionTrace/trace-prescription-draft-deletion-1',
      relatedReferences: [`PrescriptionDraft/${completedDetail.caseId}`],
    }
    const prescriptionWithdrawalEvent: DoctorCompletedCaseDetail['timeline'][number] = {
      kind: 'prescription-withdrawn',
      occurredAt: withdrawal.withdrawnAt,
      reference: `PrescriptionWithdrawal/${withdrawal.id}`,
      relatedReferences: [`Prescription/${issuedPrescription.id}`],
    }
    let currentActiveDetail: DoctorCaseDetail = {
      allergies: [],
      caseId: completedDetail.caseId,
      clinicalDocument: { signed: [signedDocument] },
      consultation: { turns: [], version: 1 },
      encounter: {
        id: completedDetail.encounter.id,
        status: 'in-progress',
        versionId: completedDetail.encounter.versionId,
      },
      laboratoryRequests: {
        draft: { catalogItemId: 'lab-crp', indicationCode: 'fever' },
        draftVersion: 1,
        reportingSupported: true,
        requests: [issuedLaboratoryRequest, laboratoryRequest],
      },
      medicationConclusion: {
        draft: { items: [prescriptionDraftItem] },
        draftVersion: 1,
      },
      patient,
      presentation: doctorPresentation,
      priorFacts: [],
      status: 'revisit-draft',
      taskId: 'task-doctor-completed-correction-1',
      taskVersion: '2',
    }
    stubDoctorCompletedCaseLibrary({
      list: {
        items: [{
          caseId: completedDetail.caseId,
          completedAt: completedDetail.completedAt,
          encounterId: completedDetail.encounter.id,
          encounterVersion: completedDetail.encounter.versionId,
          patient,
        }],
        ...pagination(1),
      },
      onRequest: (url, init) => {
        if (url.pathname === '/api/his/v1/catalogs/clinical') {
          return Response.json({
            diagnoses: [{
              code: 'J10.1',
              id: 'diagnosis-influenza-a',
              nameEn: 'Influenza with other respiratory manifestations',
              nameZh: '流感伴其他呼吸道表现',
              system: 'http://hl7.org/fhir/sid/icd-10',
              version: 1,
            }],
            laboratory: [{
              allowedIndicationCodes: ['fever'],
              contraindicatedAllergyCodes: [],
              id: 'lab-cbc',
              nameEn: 'Complete blood count',
              nameZh: '血常规',
              priceFen: 2_500,
              version: 1,
            }, {
              allowedIndicationCodes: ['fever'],
              contraindicatedAllergyCodes: [],
              id: 'lab-crp',
              nameEn: 'C-reactive protein',
              nameZh: 'C 反应蛋白',
              priceFen: 4_300,
              version: 1,
            }],
            medications: [{
              allowedCombinationIds: ['medication-oseltamivir'],
              allowedCourseDays: [5],
              allowedDoseTexts: ['75 mg'],
              allowedFrequencyCodes: ['BID'],
              allowedQuantities: [10],
              defaultCourseDays: 5,
              defaultDoseText: '75 mg',
              defaultFrequencyCode: 'BID',
              defaultQuantity: 10,
              id: 'medication-oseltamivir',
              nameEn: 'Oseltamivir phosphate capsules',
              nameZh: '磷酸奥司他韦胶囊',
              priceFen: 1_680,
              version: 1,
            }],
            prescriptionConclusionSupported: true,
          })
        }
        if (url.pathname === '/api/his/v1/doctor/queue') {
          return Response.json({
            items: [{
              caseId: completedDetail.caseId,
              encounterId: completedDetail.encounter.id,
              encounterVersion: completedDetail.encounter.versionId,
              patient,
              presentation: doctorPresentation,
              status: 'revisit-draft',
              taskId: currentActiveDetail.taskId,
              taskVersion: currentActiveDetail.taskVersion,
            }],
            ...pagination(1),
          })
        }
        if (
          url.pathname
          === `/api/his/v1/doctor/cases/${completedDetail.caseId}`
        ) {
          return Response.json(currentActiveDetail)
        }
        if (
          url.pathname
          === `/api/his/v1/doctor/completed-cases/${completedDetail.caseId}`
        ) {
          return Response.json(currentCompletedDetail)
        }
        if (
          url.pathname
          === `/api/his/v1/encounters/${completedDetail.encounter.id}/laboratory-request/draft`
        ) {
          laboratoryDraftDeletionRequest = JSON.parse(String(init?.body))
          const requestState = currentActiveDetail.laboratoryRequests
          if (requestState === undefined) throw new Error('Laboratory state was not found')
          currentActiveDetail = {
            ...currentActiveDetail,
            laboratoryRequests: {
              draftVersion: 2,
              reportingSupported: requestState.reportingSupported,
              requests: requestState.requests,
            },
          }
          currentCompletedDetail = {
            ...currentCompletedDetail,
            timeline: [...currentCompletedDetail.timeline, laboratoryDraftDeletionEvent],
          }
          return Response.json(commandResponse({
            caseId: completedDetail.caseId,
            draftVersion: 2,
          }))
        }
        if (
          url.pathname
          === `/api/his/v1/laboratory-requests/${issuedLaboratoryRequest.id}/actions/cancel`
        ) {
          laboratoryCancellationRequest = JSON.parse(String(init?.body))
          const cancelledRequest: LaboratoryRequest = {
            ...issuedLaboratoryRequest,
            serviceRequestVersion: '2',
            status: 'cancelled',
            taskVersion: '2',
            version: 2,
          }
          const requestState = currentActiveDetail.laboratoryRequests
          if (requestState === undefined) throw new Error('Laboratory state was not found')
          currentActiveDetail = {
            ...currentActiveDetail,
            laboratoryRequests: {
              ...requestState,
              requests: requestState.requests.map(request => (
                request.id === cancelledRequest.id ? cancelledRequest : request
              )),
            },
          }
          currentCompletedDetail = {
            ...currentCompletedDetail,
            laboratoryRequests: currentCompletedDetail.laboratoryRequests.map(request => (
              request.id === cancelledRequest.id
                ? { ...cancelledRequest, correctionSupported: false }
                : request
            )),
            timeline: [...currentCompletedDetail.timeline, laboratoryCancellationEvent],
          }
          return Response.json(commandResponse({ request: cancelledRequest }))
        }
        if (
          url.pathname
          === `/api/his/v1/encounters/${completedDetail.encounter.id}/prescription/draft`
        ) {
          if (init?.method === 'DELETE') {
            prescriptionDraftDeletionRequest = JSON.parse(String(init.body))
            currentActiveDetail = {
              ...currentActiveDetail,
              medicationConclusion: { draftVersion: 2 },
            }
            currentCompletedDetail = {
              ...currentCompletedDetail,
              timeline: [...currentCompletedDetail.timeline, prescriptionDraftDeletionEvent],
            }
            return Response.json(commandResponse({ draftVersion: 2 }))
          }
          prescriptionDraftRequest = JSON.parse(String(init?.body))
          currentActiveDetail = {
            ...currentActiveDetail,
            medicationConclusion: {
              draft: { items: [prescriptionDraftItem] },
              draftVersion: 3,
            },
          }
          return Response.json(commandResponse({ draftVersion: 3 }))
        }
        if (
          url.pathname
          === `/api/his/v1/encounters/${completedDetail.encounter.id}/prescription/actions/issue`
        ) {
          prescriptionIssueRequest = JSON.parse(String(init?.body))
          currentActiveDetail = {
            ...currentActiveDetail,
            medicationConclusion: {
              draftVersion: 4,
              prescription: issuedPrescription,
            },
          }
          currentCompletedDetail = {
            ...currentCompletedDetail,
            medicationConclusion: {
              prescription: { ...issuedPrescription, withdrawalSupported: true },
            },
            timeline: [...currentCompletedDetail.timeline, prescriptionIssuedEvent],
          }
          return Response.json(commandResponse({
            draftVersion: 4,
            prescription: issuedPrescription,
          }))
        }
        if (
          url.pathname
          === `/api/his/v1/prescriptions/${issuedPrescription.id}/actions/withdraw`
        ) {
          prescriptionWithdrawalRequest = JSON.parse(String(init?.body))
          currentActiveDetail = {
            ...currentActiveDetail,
            medicationConclusion: {
              draftVersion: 4,
              prescription: withdrawnPrescription,
            },
          }
          currentCompletedDetail = {
            ...currentCompletedDetail,
            medicationConclusion: {
              prescription: { ...withdrawnPrescription, withdrawalSupported: false },
            },
            timeline: [...currentCompletedDetail.timeline, prescriptionWithdrawalEvent],
          }
          return Response.json(commandResponse({
            medicationRequests: [{
              id: issuedPrescriptionItem.medicationRequestId,
              version: '2',
            }],
            prescriptionId: issuedPrescription.id,
            prescriptionVersion: 2,
            status: 'withdrawn',
            withdrawal,
          }))
        }
        if (
          url.pathname
          === '/api/his/v1/clinical-documents/composition-completed-correction-1/actions/revise'
        ) {
          clinicalRevisionRequest = JSON.parse(String(init?.body))
          currentCompletedDetail = {
            ...currentCompletedDetail,
            clinicalDocuments: [completedSignedDocument, revisedDocument],
            timeline: [...currentCompletedDetail.timeline, clinicalRevisionEvent],
          }
          return Response.json(commandResponse({
            bundleId: 'bundle-completed-correction-2',
            compositionId: 'composition-completed-correction-2',
            compositionVersion: '1',
            documentId: 'document-completed-correction-2',
            provenanceId: 'provenance-completed-correction-2',
            revisionNumber: 2,
            revisionOfCompositionId: signedDocument.compositionId,
          }))
        }
        if (
          url.pathname
          === '/api/his/v1/laboratory-requests/laboratory-request-correction-1/reports/diagnostic-report-correction-1/actions/correct'
        ) {
          laboratoryCorrectionRequest = JSON.parse(String(init?.body))
          const revisedLaboratoryRequest: LaboratoryRequest = {
            ...laboratoryRequest,
            previousReports: [report],
            report: revisedReport,
            status: 'reported',
            version: laboratoryRequest.version + 1,
          }
          const requestState = currentActiveDetail.laboratoryRequests
          if (requestState === undefined) throw new Error('Laboratory state was not found')
          currentActiveDetail = {
            ...currentActiveDetail,
            laboratoryRequests: {
              ...requestState,
              requests: requestState.requests.map(request => (
                request.id === revisedLaboratoryRequest.id ? revisedLaboratoryRequest : request
              )),
            },
          }
          currentCompletedDetail = {
            ...currentCompletedDetail,
            laboratoryRequests: currentCompletedDetail.laboratoryRequests.map(request => (
              request.id === revisedLaboratoryRequest.id
                ? { ...revisedLaboratoryRequest, correctionSupported: true }
                : request
            )),
            timeline: [...currentCompletedDetail.timeline, laboratoryCorrectionEvent],
          }
          return Response.json(commandResponse({
            diagnosticReportId: 'diagnostic-report-correction-2',
            previousDiagnosticReportId: report.diagnosticReportId,
            provenanceId: 'provenance-report-correction-2',
            requestId: laboratoryRequest.id,
            requestVersion: laboratoryRequest.version + 1,
            status: 'reported',
          }))
        }
        return undefined
      },
      session: administratorAsDoctorSession,
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: Infinity },
      },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <DoctorWorkspace locale="zh-CN" session={administratorAsDoctorSession} />
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('tab', { name: '检验' }))
    await user.click(await screen.findByRole('button', { name: '删除检验草稿' }))
    const laboratoryDraftDialog = await screen.findByRole('alertdialog', {
      name: '确认删除检验草稿',
    })
    expect(within(laboratoryDraftDialog).getByText('C 反应蛋白')).toBeTruthy()
    await user.click(within(laboratoryDraftDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('检验草稿已删除')).toBeTruthy()
    expect(laboratoryDraftDeletionRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 1 },
    })

    await user.click(screen.getByRole('button', { name: '取消检验申请 血常规' }))
    const laboratoryCancellationDialog = await screen.findByRole('alertdialog', {
      name: '确认取消检验申请',
    })
    expect(within(laboratoryCancellationDialog).getByText('血常规')).toBeTruthy()
    await user.click(within(laboratoryCancellationDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText('检验申请已取消')).toBeTruthy()
    expect(laboratoryCancellationRequest).toEqual({
      expectedVersions: {
        'ServiceRequest/service-request-cancellation-1': '1',
        'Task/task-laboratory-cancellation-1': '1',
      },
      input: { expectedRequestVersion: 1, reasonCode: 'no-longer-needed' },
    })

    await user.click(screen.getByRole('tab', { name: '处方' }))
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    const prescriptionDraftDialog = await screen.findByRole('alertdialog', {
      name: '确认删除处方草稿',
    })
    expect(within(prescriptionDraftDialog).getByText('磷酸奥司他韦胶囊')).toBeTruthy()
    await user.click(within(prescriptionDraftDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('处方草稿已删除')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alertdialog', {
      name: '确认删除处方草稿',
    })).toBeNull())
    expect(prescriptionDraftDeletionRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 1 },
    })

    await user.click(screen.getByRole('button', { name: '添加药品' }))
    const replacementMedicationDialog = await screen.findByRole('dialog', { name: '选择药品' })
    await user.click(await within(replacementMedicationDialog).findByRole('button', {
      name: '选择 磷酸奥司他韦胶囊',
    }))
    await user.click(within(replacementMedicationDialog).getByRole('button', { name: '加入处方' }))
    await waitFor(() => expect(prescriptionDraftRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 2, items: [prescriptionDraftItem] },
    }), { timeout: 3_000 })
    await user.click(screen.getByRole('button', { name: '正式开具处方' }))
    const issueDialog = await screen.findByRole('alertdialog', { name: '确认正式开具处方' })
    await user.click(within(issueDialog).getByRole('button', { name: '确认开具' }))
    expect(await screen.findByText('处方已正式开具')).toBeTruthy()
    expect(prescriptionIssueRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 3 },
    })

    await user.click(screen.getByRole('button', { name: '撤回处方' }))
    const prescriptionWithdrawalDialog = await screen.findByRole('alertdialog', {
      name: '确认撤回处方',
    })
    expect(within(prescriptionWithdrawalDialog).getByText(issuedPrescription.number)).toBeTruthy()
    await user.click(within(prescriptionWithdrawalDialog).getByRole('button', { name: '确认撤回' }))
    expect(await screen.findByText('处方已撤回')).toBeTruthy()
    expect(prescriptionWithdrawalRequest).toEqual({
      expectedVersions: {
        'MedicationRequest/medication-request-correction-replacement-1': '1',
      },
      input: { expectedPrescriptionVersion: 1 },
    })

    await user.click(await screen.findByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('只读详情')).toBeTruthy()
    expect(screen.getByText('偏高').getAttribute('data-variant')).toBe('warning')
    expect(screen.queryByRole('button', { name: '提交病历修订' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '更正病历' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-clinical-document')
    })
    expect(screen.getByRole('tab', { name: '在诊' }).getAttribute('aria-selected')).toBe('true')
    const revisionForm = await screen.findByRole('form', { name: '修订病历版本' })
    await user.type(within(revisionForm).getByLabelText('修订原因'), '补充检验复核后的处置说明。')
    await user.click(within(revisionForm).getByRole('button', { name: '提交病历修订' }))
    const revisionConfirmation = await screen.findByRole('alertdialog', {
      name: '确认提交病历修订',
    })
    await user.click(within(revisionConfirmation).getByRole('button', { name: '确认提交修订' }))
    await waitFor(() => {
      expect(clinicalRevisionRequest).toMatchObject({
        expectedVersions: {
          'Composition/composition-completed-correction-1': '1',
          'Encounter/encounter-completed-correction-1': '6',
        },
        input: { reason: '补充检验复核后的处置说明。' },
      })
    })

    await user.click(screen.getByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('版本 2')).toBeTruthy()
    expect(screen.getByText('补充检验复核后的处置说明。')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '更正检验报告' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-laboratory')
    })
    expect(screen.getByRole('tab', { name: '在诊' }).getAttribute('aria-selected')).toBe('true')
    const correctionForm = await screen.findByRole('form', { name: '更正检验报告 C 反应蛋白' })
    await user.clear(within(correctionForm).getByLabelText('更正后结论'))
    await user.type(within(correctionForm).getByLabelText('更正后结论'), '复核后 C 反应蛋白仍升高。')
    await user.clear(within(correctionForm).getByLabelText('C 反应蛋白 · 结果'))
    await user.type(within(correctionForm).getByLabelText('C 反应蛋白 · 结果'), '29.1')
    await user.type(within(correctionForm).getByLabelText('更正原因'), '复核仪器原始数据后更正。')
    await user.click(within(correctionForm).getByRole('button', { name: '预览报告更正' }))
    const confirmation = await screen.findByRole('alertdialog', { name: '确认更正检验报告' })
    expect(within(confirmation).getByText('复核后 C 反应蛋白仍升高。')).toBeTruthy()
    expect(within(confirmation).getByText('29.1 mg/L')).toBeTruthy()
    expect(within(confirmation).getByText('复核仪器原始数据后更正。')).toBeTruthy()
    await user.click(within(confirmation).getByRole('button', { name: '确认更正检验报告' }))
    await waitFor(() => {
      expect(laboratoryCorrectionRequest).toEqual({
        expectedVersions: { 'DiagnosticReport/diagnostic-report-correction-1': '1' },
        input: {
          conclusion: '复核后 C 反应蛋白仍升高。',
          expectedRequestVersion: 5,
          reason: '复核仪器原始数据后更正。',
          results: [{ code: '1988-5', value: 29.1 }],
        },
      })
    })

    await user.click(screen.getByRole('tab', { name: '完诊' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('第 2 版（当前）')).toBeTruthy()
    expect(screen.getByText('复核后 C 反应蛋白仍升高。')).toBeTruthy()
    const timeline = screen.getByRole('region', { name: '业务时间线' })
    expect(within(timeline).getByText('签署病历')).toBeTruthy()
    expect(within(timeline).getByText('修订病历')).toBeTruthy()
    expect(within(timeline).getByText('删除检验草稿')).toBeTruthy()
    expect(within(timeline).getByText('开具检验申请')).toBeTruthy()
    expect(within(timeline).getByText('取消检验申请')).toBeTruthy()
    expect(within(timeline).getByText('签发检验报告')).toBeTruthy()
    expect(within(timeline).getByText('更正检验报告')).toBeTruthy()
    expect(within(timeline).getByText('删除处方草稿')).toBeTruthy()
    expect(within(timeline).getByText('开具处方')).toBeTruthy()
    expect(within(timeline).getByText('撤回处方')).toBeTruthy()
  })

  it('partially dispenses from a versioned lot before completing the Scenario Run', async () => {
    let dispensedQuantity = 0
    let dispenseCount = 0
    let reviewed = false
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-1',
      identifier: 'CM-SYN-001',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const pendingPrescription = {
      allergyWarnings: [],
      authoredBy: 'actor-outpatient-doctor',
      caseId: 'case-1',
      encounterId: 'encounter-1',
      encounterStatus: 'completed',
      encounterVersion: '7',
      medications: [{
        doseText: '75 mg',
        frequencyCode: 'BID',
        lots: [{
          expiresOn: '2027-12-31',
          id: 'lot-oseltamivir-001',
          locationId: 'location-pharmacist',
          lotNumber: 'SYN-OS-001',
          quantityOnHand: 1000,
          version: 1,
        }],
        medicationId: 'medication-oseltamivir',
        medicationRequestId: 'medication-request-1',
        medicationRequestVersion: '2',
        nameEn: 'Oseltamivir capsules',
        nameZh: '磷酸奥司他韦胶囊',
        dispensedQuantity: 0,
        quantity: 10,
        remainingQuantity: 10,
        unitPriceFen: 760,
      }],
      patient,
      prescriptionId: 'prescription-1',
      prescriptionNumber: 'CM-RX-20260824-0001',
      prescriptionStatus: 'paid',
      prescriptionVersion: 3,
      status: 'awaiting-review',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(pharmacistSession)
      if (url.pathname === '/api/his/v1/pharmacy/queue') {
        const status = url.searchParams.get('status') ?? 'pending'
        const completed = dispensedQuantity === 10
        const hasItem = status === (completed ? 'completed' : 'pending')
        return Response.json({
          items: hasItem ? [{
            ...pendingPrescription,
            medications: pendingPrescription.medications.map(medication => ({
              ...medication,
              dispensedQuantity,
              lots: medication.lots.map(lot => ({
                ...lot,
                quantityOnHand: 1000 - dispensedQuantity,
                version: 1 + dispenseCount,
              })),
              remainingQuantity: 10 - dispensedQuantity,
            })),
            prescriptionStatus: completed ? 'dispensed' : 'paid',
            prescriptionVersion: 3 + Number(reviewed) + dispenseCount,
            ...(reviewed ? {
              review: {
                note: '已核对诊断、剂量与用药禁忌。',
                reviewId: 'prescription-review-1',
                reviewedAt: '2026-08-24T10:00:00+08:00',
                reviewedBy: 'actor-pharmacist',
              },
            } : {}),
            status: completed
              ? 'completed'
              : dispensedQuantity > 0
                ? 'partially-dispensed'
                : reviewed ? 'awaiting-dispense' : 'awaiting-review',
          }] : [],
          ...pagination(hasItem ? 1 : 0),
        })
      }
      if (url.pathname === '/api/his/v1/prescriptions/prescription-1/actions/review') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body).toEqual({
          expectedVersions: {
            'Encounter/encounter-1': '7',
            'MedicationRequest/medication-request-1': '2',
          },
          input: {
            expectedPrescriptionVersion: 3,
            note: '已核对诊断、剂量与用药禁忌。',
          },
        })
        reviewed = true
        return Response.json(commandResponse({
          prescriptionId: 'prescription-1',
          prescriptionVersion: 4,
          reviewId: 'prescription-review-1',
          status: 'awaiting-dispense',
        }))
      }
      if (url.pathname === '/api/his/v1/prescriptions/prescription-1/actions/dispense') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: {
            expectedPrescriptionVersion: number
            lotSelections: Array<{ expectedVersion: number; lotId: string; quantity: number }>
          }
        }
        expect(body).toEqual({
          expectedVersions: {
            'Encounter/encounter-1': '7',
            'MedicationRequest/medication-request-1': '2',
          },
          input: {
            expectedPrescriptionVersion: 4 + dispenseCount,
            lotSelections: [{
              expectedVersion: 1 + dispenseCount,
              lotId: 'lot-oseltamivir-001',
              quantity: body.input.lotSelections[0]?.quantity,
            }],
          },
        })
        dispensedQuantity += body.input.lotSelections[0]?.quantity ?? 0
        dispenseCount += 1
        const completed = dispensedQuantity === 10
        return Response.json(commandResponse({
          medicationDispenseIds: [`medication-dispense-${dispenseCount}`],
          prescriptionId: 'prescription-1',
          prescriptionVersion: 4 + dispenseCount,
          scenarioStatus: completed ? 'completed' : 'active',
          status: completed ? 'completed' : 'partial',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect((await screen.findAllByText('CM-RX-20260824-0001')).length).toBeGreaterThan(0)
    expect(screen.getByText('磷酸奥司他韦胶囊')).toBeTruthy()
    expect(screen.getByText('Encounter 已完成')).toBeTruthy()
    expect(screen.getByText('待审核')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '库存批次 · 磷酸奥司他韦胶囊' }).textContent).toContain('SYN-OS-001')
    expect(screen.queryByRole('button', { name: '确认发药' })).toBeNull()
    await user.type(screen.getByLabelText('审核意见'), '已核对诊断、剂量与用药禁忌。')
    await user.click(screen.getByRole('button', { name: '审核通过' }))

    expect(await screen.findByText('处方审核通过')).toBeTruthy()
    expect(await screen.findByText('待发')).toBeTruthy()
    expect(screen.getByText('已核对诊断、剂量与用药禁忌。')).toBeTruthy()
    const firstQuantity = screen.getByRole('spinbutton', {
      name: '本次发放数量 · 磷酸奥司他韦胶囊',
    })
    await user.clear(firstQuantity)
    await user.type(firstQuantity, '4')
    await user.click(screen.getByRole('button', { name: '确认发药' }))

    expect(await screen.findByText('部分发药完成')).toBeTruthy()
    expect(screen.getByText('业务流程仍在进行')).toBeTruthy()
    expect(await screen.findByText('部分已发')).toBeTruthy()
    const remainder = await screen.findByRole('spinbutton', {
      name: '本次发放数量 · 磷酸奥司他韦胶囊',
    }) as HTMLInputElement
    expect(remainder.value).toBe('6')
    await user.click(screen.getByRole('button', { name: '确认发药' }))

    expect(await screen.findByText('业务流程已完成')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenChineseClinicalUiTerms)
    await user.click(screen.getByRole('tab', { name: '已发药' }))
    expect((await screen.findAllByText('CM-RX-20260824-0001')).length).toBeGreaterThan(0)
    expect(screen.getByText('库存 990')).toBeTruthy()
  })
})
