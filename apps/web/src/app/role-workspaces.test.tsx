// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  DiagnosisDraftEntry,
  DiagnosisState,
  DoctorCaseDetail,
  DoctorCompletedCaseDetail,
  DoctorCompletedCaseList,
  LaboratoryRequest,
  SessionContext,
} from '@clinmesh/contracts/his'
import {
  scenarioDatasetContentSchema,
  type ScenarioDataset,
  type ScenarioGenerationRequest,
  type SyntheticPatientProfile,
} from '@clinmesh/contracts/scenario'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DoctorWorkspace } from './doctor-workspace.tsx'
import { WebApp } from './web-app.tsx'

const forbiddenChineseClinicalUiTerms = /Agent|评分|仿真|Scenario|Epoch/i
const forbiddenEnglishClinicalUiTerms = /Agent|scor(?:e|ing)|simulation|Scenario|Epoch/i

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
  chiefComplaint: '发热伴咽痛两天。',
  disposition: '门诊随诊，完善检验后复评。',
  followUp: '持续高热或呼吸困难时立即复诊。',
  historyOfPresentIllness: '患者两天前出现发热和咽痛，最高体温 38.7 °C。',
  physicalExamination: '咽部充血，双肺呼吸音清，未闻及干湿啰音。',
}

const revisedStructuredClinicalDocument = {
  assessment: '检验支持甲型流感，当前生命体征稳定。',
  chiefComplaint: '发热伴咽痛两天。',
  disposition: '门诊抗病毒及对症治疗。',
  followUp: '三日内门诊复查；呼吸困难时立即就诊。',
  historyOfPresentIllness: '患者两天前出现发热和咽痛，甲型流感抗原阳性。',
  physicalExamination: '咽部充血，双肺呼吸音清，血氧饱和度 98%。',
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

const virtualPatient = {
  birthDate: '1988-03-16',
  gender: 'female',
  id: 'virtual-patient-fever-001',
  name: '合成候选患者林晓',
  presentation: virtualPatientPresentation,
  version: 'opaque-virtual-patient-version-token',
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

function stubAdministratorWorkspace() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/auth/context') return Response.json(administratorSession)
    if (path === '/api/sim/v1/scenario-runs/current') {
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
    throw new Error(`Unexpected request: ${path}`)
  }))
}

function stubScenarioDataWorkspace(options: {
  datasetTotal?: number | ((url: URL) => number)
  invalidUpdate?: boolean
  onDelete?: () => void
  onDatasetListRequest?: (url: URL) => void
  onGenerate?: (request: ScenarioGenerationRequest) => void
  onInstall?: () => void
  onUpdate?: (content: unknown) => void
  profileAvailable?: boolean
  profileUpdateConflict?: boolean
  staleUpdate?: boolean
  syntheaAvailable?: boolean
} = {}) {
  let generated = false
  let activeVisit = false
  let jobReads = 0
  let dataset: ScenarioDataset = {
    content: {
      catalog: {
        departments: [{
          active: true,
          code: 'GM',
          displayOrder: 10,
          id: 'department-general-medicine',
          name: '全科医学科',
          organizationId: 'hospital-synthetic-renhe',
          parentId: 'hospital-synthetic-renhe',
          priceFen: 0,
          status: 'active',
          type: 'department',
        }],
        diagnoses: [{
          active: true,
          code: 'R50.9',
          codeSystem: 'http://hl7.org/fhir/sid/icd-10',
          id: 'diagnosis-fever',
          name: '发热，未特指',
          organizationId: 'hospital-synthetic-renhe',
          priceFen: 0,
          status: 'active',
        }],
        investigations: [{
          active: true,
          allowedIndicationCodes: ['fever'],
          available: true,
          category: 'laboratory',
          code: 'CBC',
          contraindicatedAllergyCodes: [],
          id: 'lab-cbc',
          name: '血常规',
          organizationId: 'hospital-synthetic-renhe',
          priceFen: 2500,
          referenceRanges: [{ appliesToGender: 'any', text: '按血细胞分类项目报告' }],
          reportTemplate: '{value}',
          status: 'active',
          tatMinutes: 20,
          valueType: 'panel',
        }],
        medications: [{
          active: true,
          category: '解热镇痛药',
          code: 'ACETAMINOPHEN',
          defaultDose: '0.5 g',
          defaultFrequency: 'PRN',
          defaultRoute: '口服',
          dosageForm: '片剂',
          id: 'medication-acetaminophen',
          name: '对乙酰氨基酚片',
          organizationId: 'hospital-synthetic-renhe',
          priceFen: 120,
          restriction: '注意总剂量。',
          status: 'active',
          unit: '片',
          workflow: {
            allowedCombinationIds: [],
            allowedCourseDays: [3],
            allowedDiagnosisCodes: ['R50.9'],
            allowedDoseTexts: ['0.5 g'],
            allowedFrequencyCodes: ['PRN'],
            allowedQuantities: [6],
            defaultCourseDays: 3,
            defaultQuantity: 6,
          },
        }],
      },
      hiddenFacts: [{ code: 'objective-diagnosis', patientId: 'synthetic-patient-001', value: '发热' }],
      hospital: {
        active: true,
        businessCode: 'CM-SYN-HOSPITAL-001',
        displayOrder: 1,
        id: 'hospital-synthetic-renhe',
        locale: 'zh-CN',
        name: '仁和医院',
        status: 'active',
        type: 'public-general-hospital',
      },
      inventory: [{
        expiresOn: '2030-12-31',
        itemId: 'medication-acetaminophen',
        lotId: 'lot-acetaminophen-001',
        quantity: 1000,
      }],
      patients: [{
        birthDate: '1988-03-16',
        costBaseline: {
          note: '仅用于合成门诊场景。',
          overInvestigationThresholdFen: 50000,
          reasonableRangeFen: [2500, 15000],
          referencePath: '按临床需要选择检查。',
        },
        diagnosisSpace: {
          comorbidities: [],
          differentials: [],
          primary: {
            code: 'R50.9',
            display: '发热，原因待查',
            evidence: ['体温升高'],
            id: 'diagnosis-primary-fever',
          },
          traps: ['不能仅凭发热使用抗菌药物。'],
        },
        encounter: {
          openingStatement: '昨天下午开始发热。',
          setting: '全科医学科门诊',
          timeStateItems: [],
        },
        examinationFindings: [{
          abnormal: ['体温升高'],
          finding: '神志清，咽部轻度充血。',
          id: 'exam-vital-signs',
          name: '生命体征',
        }],
        fhirHistory: [],
        gender: 'female',
        id: 'synthetic-patient-001',
        investigations: [{
          catalogItemId: 'lab-cbc',
          critical: false,
          feeFen: 2500,
          id: 'investigation-cbc',
          name: '血常规',
          report: '白细胞计数升高。',
          result: { flag: 'H', outcome: 'reported', value: '白细胞计数升高' },
          sourceLevel: 'L1',
          tatMinutes: 20,
        }],
        longitudinalHistory: [],
        managementSpace: {
          acceptableOptions: ['对症退热。'],
          contraindications: ['无指征使用抗菌药物。'],
          followUp: '高热不退时复诊。',
          requiredElements: ['评估危险征象'],
        },
        name: '林晓',
        patientKnowledge: {
          careMemory: '没有接受相关检查。',
          chiefComplaint: '发热、咽痛一天',
          healthLiteracy: '一般',
          lifestyle: [],
          medicationMemory: '未规律用药。',
          neverKnows: ['尚未告知的检查数值'],
          toldDiagnoses: [],
        },
        persona: {
          attitude: '希望尽快明确原因。',
          character: '表达直接。',
          healthLiteracy: '一般',
          occupation: '教师',
          speechStyle: '自然口语。',
        },
        physiologyBaseline: {
          generators: [],
          vitalSigns: { temperatureC: 38.6 },
        },
        symptomResponses: [{
          avoids: [],
          denies: ['没有气促。'],
          id: 'symptom-fever',
          name: '发热经过',
          passive: false,
          responsePoints: ['昨天下午开始发热。'],
        }],
      }],
      reproduction: {
        clinicalSeed: 7331,
        generator: 'clinmesh-builtin-v1',
        modules: ['fever'],
        populationSeed: 4242,
        timeRange: { end: '2026-08-01', start: '2020-01-01' },
        timeZone: 'Asia/Shanghai',
      },
      revealPolicies: [{
        code: 'policy-objective-diagnosis',
        factCode: 'objective-diagnosis',
        patientId: 'synthetic-patient-001',
        triggerCode: 'evaluator-only',
      }],
      schemaVersion: '1',
      simulatorRules: [],
    },
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-26T09:00:00+08:00',
    datasetId: 'scenario-dataset-001',
    diagnostics: [],
    name: '发热门诊样本',
    providerId: 'builtin',
    updatedAt: '2026-08-26T09:00:00+08:00',
    version: 1,
    workspaceId: 'workspace-demo',
  }
  const datasetPatient = dataset.content.patients[0]
  if (datasetPatient === undefined) throw new Error('Scenario Dataset test fixture requires a patient')
  let profile: SyntheticPatientProfile = {
    createdAt: dataset.createdAt,
    identity: {
      address: '江苏省苏州市张家港市合成路 123 号（合成地址）',
      displayName: datasetPatient.name,
      email: 'cmsyn001@example.test',
      insuranceDisplay: '模拟城镇职工医保',
      mrn: 'CMSYN000001',
      nationalId: '320582198803160028',
      phone: '13800001234',
    },
    mappings: [],
    patient: {
      ...datasetPatient,
      longitudinalHistory: [{
        code: '386661006',
        display: '发热',
        id: 'history-event-fever',
        kind: 'condition' as const,
        mappedCode: null,
        occurredAt: '2026-08-01T08:00:00+08:00',
        sourceResourceId: 'condition-fever',
        sourceResourceType: 'Condition' as const,
        status: 'active',
      }],
    },
    profileId: 'synthetic-patient-profile-001',
    revision: 1,
    source: {
      batchId: dataset.datasetId,
      batchName: dataset.name,
      compilation: null,
      format: 'clinmesh-template' as const,
      hash: 'b'.repeat(64),
      mappingVersion: 'builtin-case-truth-v1',
      patientId: datasetPatient.id,
      providerId: dataset.providerId,
      raw: null,
    },
    updatedAt: dataset.updatedAt,
    workspaceId: dataset.workspaceId,
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
          catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
          available: true,
          maxPopulation: 10,
          modules: ['fever', 'type-2-diabetes'],
          providerId: 'builtin',
          providerName: 'ClinMesh 内置生成器',
        }, {
          available: options.syntheaAvailable === true,
          maxPopulation: 10,
          modules: ['fever', 'type-2-diabetes'],
          providerId: 'synthea',
          providerName: 'Synthea',
          ...(options.syntheaAvailable === true
            ? {}
            : { unavailableReason: '未配置 Synthea Provider' }),
        }],
      })
    }
    if (url.pathname === '/api/sim/v1/synthetic-patients') {
      return Response.json({
        items: generated ? [{
          activeVisit,
          allergyCount: 0,
          batchId: profile.source.batchId,
          batchName: profile.source.batchName,
          birthDate: profile.patient.birthDate,
          chronicConditions: [],
          createdAt: profile.createdAt,
          gender: profile.patient.gender,
          historyCount: profile.patient.longitudinalHistory.length,
          mappingWarningCount: 0,
          mrn: profile.identity.mrn,
          name: profile.identity.displayName,
          profileId: profile.profileId,
          providerId: profile.source.providerId,
          revision: profile.revision,
          updatedAt: profile.updatedAt,
        }] : [],
        page: 1,
        pageSize: 20,
        total: generated ? 1 : 0,
      })
    }
    if (url.pathname === '/api/sim/v1/synthetic-patient-mapping-catalog') {
      return Response.json({
        items: [{
          catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
          code: 'J06.9',
          nameEn: 'Acute upper respiratory infection',
          nameZh: '急性上呼吸道感染',
          sourceResourceType: 'Condition',
          system: 'http://hl7.org/fhir/sid/icd-10',
          version: 1,
        }, {
          catalogItemId: 'encounter-class-ambulatory',
          code: 'AMB',
          nameEn: 'Ambulatory encounter',
          nameZh: '门诊就诊',
          sourceResourceType: 'Encounter',
          system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
          version: 1,
        }],
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
      return Response.json(commandResponse(profile))
    }
    if (url.pathname === `/api/sim/v1/synthetic-patients/${profile.profileId}/mappings` && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        expectedRevision: number
        input: Array<{
          sourceResourceId: string
          target: { catalogItemId: string; version: number } | null
        }>
      }
      const mappings = body.input.flatMap(item => (
        item.target?.catalogItemId === 'diagnosis-acute-upper-respiratory-infection'
          ? [{
              sourceResourceId: item.sourceResourceId,
              sourceResourceType: 'Condition' as const,
              target: {
                catalogItemId: item.target.catalogItemId,
                code: 'J06.9',
                system: 'http://hl7.org/fhir/sid/icd-10',
                version: item.target.version,
              },
            }]
          : []
      ))
      const mappingBySourceId = new Map(mappings.map(item => (
        [item.sourceResourceId, item.target.code] as const
      )))
      profile = {
        ...profile,
        mappings,
        patient: {
          ...profile.patient,
          longitudinalHistory: profile.patient.longitudinalHistory.map(item => ({
            ...item,
            mappedCode: mappingBySourceId.get(item.sourceResourceId) ?? null,
          })),
        },
        revision: body.expectedRevision + 1,
      }
      return Response.json(commandResponse(profile))
    }
    if (url.pathname === `/api/sim/v1/synthetic-patients/${profile.profileId}`) {
      return Response.json(profile)
    }
    if (url.pathname === '/api/his/v1/catalogs/registration') {
      return Response.json({
        departments: [{ id: 'department-general-medicine', nameEn: 'General Medicine', nameZh: '全科医学科', version: 1 }],
        locations: [{ id: 'location-outpatient', nameEn: 'Outpatient', nameZh: '门诊一层', version: 1 }],
        virtualDate: '2026-08-24',
        visitTypes: [{ id: 'visit-type-general', nameEn: 'General', nameZh: '普通门诊', priceFen: 1000, version: 1 }],
      })
    }
    if (url.pathname === '/api/sim/v1/synthetic-patients/actions/start-outpatient-visits') {
      activeVisit = true
      return Response.json(commandResponse({
        items: [{
          encounterId: 'encounter-profile-001',
          patientId: 'patient-profile-001',
          profileId: profile.profileId,
          queueTaskId: 'task-profile-001',
          registrationId: 'registration-profile-001',
          status: 'awaiting-triage',
        }],
      }))
    }
    if (url.pathname === '/api/sim/v1/scenario-datasets' && init?.method !== 'POST') {
      options.onDatasetListRequest?.(url)
      const total = typeof options.datasetTotal === 'function'
        ? options.datasetTotal(url)
        : options.datasetTotal ?? (generated ? 1 : 0)
      return Response.json({
        items: total > 0 ? [{
          contentHash: dataset.contentHash,
          createdAt: dataset.createdAt,
          datasetId: dataset.datasetId,
          diagnosticCounts: {
            error: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
            warning: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length,
          },
          name: dataset.name,
          patientCount: 1,
          providerId: dataset.providerId,
          updatedAt: dataset.updatedAt,
          version: 1,
        }] : [],
        page: Number(url.searchParams.get('page') ?? '1'),
        pageSize: 20,
        total,
      })
    }
    if (url.pathname === '/api/sim/v1/scenario-datasets/actions/generate') {
      options.onGenerate?.(JSON.parse(String(init?.body)) as ScenarioGenerationRequest)
      generated = true
      return Response.json(commandResponse(dataset))
    }
    if (url.pathname === '/api/sim/v1/scenario-generation-jobs' && init?.method === 'POST') {
      options.onGenerate?.(JSON.parse(String(init.body)) as ScenarioGenerationRequest)
      return Response.json(commandResponse({
        createdAt: '2026-08-26T09:00:00+08:00',
        datasetId: null,
        error: null,
        finishedAt: null,
        jobId: 'scenario-generation-job-001',
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
      jobReads += 1
      const succeeded = jobReads > 1
      if (succeeded) generated = true
      return Response.json({
        createdAt: '2026-08-26T09:00:00+08:00',
        datasetId: succeeded ? dataset.datasetId : null,
        error: null,
        finishedAt: succeeded ? '2026-08-26T09:00:02+08:00' : null,
        jobId: 'scenario-generation-job-001',
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
        status: succeeded ? 'succeeded' : 'running',
        updatedAt: succeeded ? '2026-08-26T09:00:02+08:00' : '2026-08-26T09:00:01+08:00',
        workspaceId: 'workspace-demo',
      })
    }
    if (url.pathname === `/api/sim/v1/scenario-datasets/${dataset.datasetId}` && init?.method === 'PUT') {
      if (options.staleUpdate === true) {
        return Response.json({
          error: {
            code: 'DATASET_VERSION_CONFLICT',
            message: 'The Scenario Dataset version has changed',
          },
        }, { status: 409 })
      }
      const body = JSON.parse(String(init.body)) as {
        expectedVersion: number
        input: { content: typeof dataset.content; name: string }
      }
      options.onUpdate?.(body.input.content)
      dataset = {
        ...dataset,
        content: body.input.content,
        name: body.input.name,
        updatedAt: '2026-08-26T09:01:00+08:00',
        version: body.expectedVersion + 1,
        ...(options.invalidUpdate === true ? {
          diagnostics: [{
            code: 'PATIENT_REFERENCE_MISSING',
            message: 'Hidden Fact references an unknown patient',
            path: 'hiddenFacts[0].patientId',
            severity: 'error' as const,
          }],
        } : {}),
      }
      return Response.json(commandResponse(dataset))
    }
    if (
      url.pathname === `/api/sim/v1/scenario-datasets/${dataset.datasetId}/actions/install`
      && init?.method === 'POST'
    ) {
      options.onInstall?.()
      return Response.json(commandResponse({
        packageId: 'scenario-package-001',
        scenario: {
          clinicalReview: null,
          epoch: 'epoch-2',
          initialStateHash: '0123456789abcdef',
          kind: 'candidate',
          scenarioId: 'scenario-package-001',
          scenarioRunId: 'scenario-run-2',
          seed: 7331,
          status: 'active',
          virtualTime: '2026-08-26T09:00:00+08:00',
          workspaceId: 'workspace-demo',
        },
      }))
    }
    if (url.pathname === `/api/sim/v1/scenario-datasets/${dataset.datasetId}` && init?.method === 'DELETE') {
      options.onDelete?.()
      generated = false
      return Response.json(commandResponse({ datasetId: dataset.datasetId, deleted: true }))
    }
    if (url.pathname === `/api/sim/v1/scenario-datasets/${dataset.datasetId}`) {
      return Response.json(dataset)
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
    if (path === '/api/his/v1/registrations') {
      return Response.json({ items: [], ...pagination(0) })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
}

async function openAdvancedCaseAuthoring(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('tab', { name: '高级病例编排' }))
}

function stubEmptyDoctorWorkspace() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/auth/context') return Response.json(doctorSession)
    if (path === '/api/his/v1/catalogs/clinical') {
      return Response.json({
        laboratory: [],
        medications: [],
        prescriptionConclusionSupported: true,
      })
    }
    if (path === '/api/his/v1/doctor/virtual-patients') {
      return Response.json({ items: [], ...pagination(0) })
    }
    if (path === '/api/his/v1/doctor/queue') {
      return Response.json({ items: [], ...pagination(0) })
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
    if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
      return Response.json({ items: [], ...pagination(0) })
    }
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
        consultation: { questions: [], records: [], version: 1 },
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
    if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
      return Response.json({ items: [], ...pagination(0) })
    }
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
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('uses clinical operator language for administrator data controls', async () => {
    stubAdministratorWorkspace()

    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '演示数据' })).toBeTruthy()
    expect(screen.getByText('标准门诊数据')).toBeTruthy()
    expect(screen.queryByText('candidate-fever-outpatient-v1')).toBeNull()
    expect(screen.queryByText('epoch-1')).toBeNull()
    expect(screen.getByRole('button', { name: '载入标准数据' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '载入密集数据' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重置当前数据' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenChineseClinicalUiTerms)
  })

  it('uses clinical operator language for English administrator data controls', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'light',
    }))
    stubAdministratorWorkspace()

    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: 'Demo data' })).toBeTruthy()
    expect(screen.getByText('Standard outpatient data')).toBeTruthy()
    expect(screen.queryByText('candidate-fever-outpatient-v1')).toBeNull()
    expect(screen.queryByText('epoch-1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Load standard data' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load high-volume data' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset current data' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenEnglishClinicalUiTerms)
  })

  it('lets an administrator generate a Dataset while an optional Provider is unavailable', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace()
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    expect(await screen.findByRole('heading', { name: '模拟数据' })).toBeTruthy()
    expect((await screen.findByRole('option', { name: 'Synthea' }))
      .hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('未配置 Synthea Provider')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '生成数据' }))
    expect(await screen.findByText('发热门诊样本')).toBeTruthy()
  })

  it('searches and pages Scenario Datasets through the administrator Web seam', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    const listRequests: URL[] = []
    stubScenarioDataWorkspace({
      datasetTotal: url => url.searchParams.has('search') ? 1 : 21,
      onDatasetListRequest: url => listRequests.push(new URL(url)),
    })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await screen.findByText('发热门诊样本')
    const previousPage = screen.getByRole('button', { name: '上一页' })
    const nextPage = screen.getByRole('button', { name: '下一页' })
    expect(previousPage.hasAttribute('disabled')).toBe(true)
    expect(nextPage.hasAttribute('disabled')).toBe(false)

    await user.click(nextPage)
    await waitFor(() => {
      expect(listRequests.at(-1)?.searchParams.get('page')).toBe('2')
    })
    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)

    await user.type(screen.getByLabelText('搜索数据集'), '  糖尿病  ')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => {
      expect(Object.fromEntries(listRequests.at(-1)?.searchParams ?? [])).toEqual({
        page: '1',
        pageSize: '20',
        search: '糖尿病',
      })
    })
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
  })

  it('edits a generated patient through structured Dataset fields', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let savedContent: unknown
    stubScenarioDataWorkspace({ onUpdate: content => { savedContent = content } })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    const patientName = await screen.findByLabelText('患者姓名')
    await user.clear(patientName)
    await user.type(patientName, '合成患者李明')

    await user.click(screen.getByRole('tab', { name: '问诊应答' }))
    const responsePoints = screen.getByLabelText('应答要点')
    fireEvent.change(responsePoints, { target: { value: '昨夜开始高热。\n伴轻度咽痛。' } })

    await user.click(screen.getByRole('tab', { name: '查体与检查' }))
    const report = screen.getByLabelText('报告文本')
    await user.clear(report)
    await user.type(report, '白细胞计数 11.2 x10^9/L。')

    await user.click(screen.getByRole('tab', { name: '诊断与处置' }))
    const diagnosis = screen.getByLabelText('主诊断名称')
    await user.clear(diagnosis)
    await user.type(diagnosis, '急性发热待查')

    await user.click(screen.getByRole('tab', { name: '目录与库存' }))
    const referenceRange = screen.getByLabelText('参考范围文本')
    await user.clear(referenceRange)
    await user.type(referenceRange, '3.5-9.5 x10^9/L')
    await user.type(screen.getByLabelText('参考下限'), '3.5')
    await user.type(screen.getByLabelText('参考上限'), '9.5')
    await user.type(screen.getByLabelText('生理生成器 ID'), 'hematology-panel')
    fireEvent.change(screen.getByLabelText('组合项目 ID'), {
      target: { value: 'lab-wbc\nlab-hemoglobin' },
    })
    await user.click(screen.getByRole('checkbox', { name: '启用 L3 正常参考采样' }))
    await user.clear(screen.getByLabelText('L3 均值'))
    await user.type(screen.getByLabelText('L3 均值'), '6.5')
    await user.clear(screen.getByLabelText('L3 标准差'))
    await user.type(screen.getByLabelText('L3 标准差'), '1.2')
    await user.clear(screen.getByLabelText('测定变异系数'))
    await user.type(screen.getByLabelText('测定变异系数'), '0.04')
    const inventory = screen.getByLabelText('库存数量')
    await user.clear(inventory)
    await user.type(inventory, '800')

    await user.click(screen.getByRole('tab', { name: '隐藏事实与揭示' }))
    const hiddenFact = screen.getByLabelText('Hidden Fact 值')
    await user.clear(hiddenFact)
    await user.type(hiddenFact, '急性病毒性上呼吸道感染')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(await screen.findByText('版本 2')).toBeTruthy()
    expect(savedContent).toMatchObject({
      catalog: {
        investigations: [{
          componentItemIds: ['lab-wbc', 'lab-hemoglobin'],
          normalDistribution: {
            assayCv: 0.04,
            maximum: 9.5,
            mean: 6.5,
            minimum: 3.5,
            standardDeviation: 1.2,
          },
          physiologyGeneratorId: 'hematology-panel',
          referenceRanges: [{ maximum: 9.5, minimum: 3.5, text: '3.5-9.5 x10^9/L' }],
        }],
      },
      hiddenFacts: [{ value: '急性病毒性上呼吸道感染' }],
      inventory: [{ quantity: 800 }],
      patients: [{
        diagnosisSpace: { primary: { display: '急性发热待查' } },
        investigations: [{ report: '白细胞计数 11.2 x10^9/L。' }],
        name: '合成患者李明',
        symptomResponses: [{ responsePoints: ['昨夜开始高热。', '伴轻度咽痛。'] }],
      }],
    })
  })

  it('edits history, diagnosis space and simulator rules through structured fields', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let savedContent: unknown
    stubScenarioDataWorkspace({ onUpdate: content => { savedContent = content } })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    await user.click(screen.getByRole('tab', { name: '纵向病史' }))
    await user.click(screen.getByRole('button', { name: '新增病史事件' }))
    const historyDisplay = screen.getByLabelText('病史名称 1')
    await user.clear(historyDisplay)
    await user.type(historyDisplay, '既往高血压')
    await user.click(screen.getByRole('button', { name: '新增 FHIR 病史' }))
    const fhirDisplay = screen.getByLabelText('FHIR 诊断名称 1')
    await user.clear(fhirDisplay)
    await user.type(fhirDisplay, '高血压')

    await user.click(screen.getByRole('tab', { name: '查体与检查' }))
    expect(screen.queryByRole('combobox', { name: '结果来源级别' })).toBeNull()
    expect(screen.getByLabelText('结果来源级别').textContent).toBe('L1')

    await user.click(screen.getByRole('tab', { name: '诊断与处置' }))
    await user.click(screen.getByRole('button', { name: '新增共病' }))
    await user.clear(screen.getByLabelText('共病名称 1'))
    await user.type(screen.getByLabelText('共病名称 1'), '原发性高血压')
    await user.click(screen.getByRole('button', { name: '新增鉴别诊断' }))
    await user.clear(screen.getByLabelText('鉴别诊断名称 1'))
    await user.type(screen.getByLabelText('鉴别诊断名称 1'), '社区获得性肺炎')
    fireEvent.change(screen.getByLabelText('诊断陷阱'), {
      target: { value: '避免仅凭发热使用抗菌药物。\n排除重症感染。' },
    })

    await user.click(screen.getByRole('tab', { name: '隐藏事实与揭示' }))
    await user.click(screen.getByRole('button', { name: '新增模拟器规则' }))
    const ruleCode = screen.getByLabelText('规则编码 1')
    await user.clear(ruleCode)
    await user.type(ruleCode, 'lis-timeout-once')
    await user.click(screen.getByLabelText('模拟结果 1'))
    await user.click(await screen.findByRole('option', { name: '结果未知' }))
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(savedContent).not.toBeUndefined())
    scenarioDatasetContentSchema.parse(savedContent)
    expect(await screen.findByText('版本 2')).toBeTruthy()
    expect(savedContent).toMatchObject({
      patients: [{
        diagnosisSpace: {
          comorbidities: [{ display: '原发性高血压' }],
          differentials: [{ display: '社区获得性肺炎' }],
          traps: ['避免仅凭发热使用抗菌药物。', '排除重症感染。'],
        },
        fhirHistory: [{ code: { display: '高血压' }, resourceType: 'Condition' }],
        longitudinalHistory: [{ display: '既往高血压' }],
      }],
      simulatorRules: [{ code: 'lis-timeout-once', outcome: 'ambiguous', simulator: 'lis' }],
    })
  })

  it('edits the complete patient truth and topic reveal policy through structured fields', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let savedContent: unknown
    stubScenarioDataWorkspace({ onUpdate: content => { savedContent = content } })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    const changeText = async (label: string, value: string): Promise<void> => {
      const input = screen.getByLabelText(label)
      await user.clear(input)
      await user.type(input, value)
    }

    await changeText('就医经过记忆', '曾在社区就诊，但没有完成检查。')
    await changeText('患者医学认知', '能理解常见检查名称。')
    await changeText('性格特征', '谨慎，回答具体。')
    await changeText('表达医学认知', '一般，避免使用专业术语。')
    await changeText('说话方式', '简短自然口语。')
    await changeText('就诊场景', '发热门诊')
    fireEvent.change(screen.getByLabelText('患者不会知道的事实'), {
      target: { value: '尚未检查的实验室数值\n医生未告知的诊断' },
    })
    fireEvent.change(screen.getByLabelText('已告知诊断'), {
      target: { value: '上呼吸道感染' },
    })
    await changeText('身高（cm）', '168')
    await changeText('体重（kg）', '62')
    await changeText('脉搏（次/分）', '96')
    await changeText('呼吸（次/分）', '19')
    await changeText('血氧饱和度（%）', '97')

    await user.click(screen.getByRole('button', { name: '新增生活方式' }))
    await changeText('生活方式名称 1', '吸烟')
    await changeText('实际情况 1', '从不吸烟')
    await changeText('首次询问回答 1', '没有吸烟习惯。')
    await user.click(screen.getByRole('checkbox', { name: '二次追问时承认 1' }))

    await user.click(screen.getByRole('button', { name: '新增时间状态' }))
    await changeText('状态变化 1', '体温升至 39.2 C。')
    await changeText('触发分钟 1', '45')

    await user.click(screen.getByRole('button', { name: '新增生理生成器' }))
    await changeText('生成器 ID 1', 'baseline-glucose')
    await changeText('生成器来源 1', '合成病例基线')
    await changeText('生成器单位 1', 'mmol/L')
    await changeText('常量值 1', '6.1')

    await user.click(screen.getByRole('tab', { name: '问诊应答' }))
    await user.click(screen.getByRole('button', { name: '新增回避回答 1' }))
    await changeText('回避问题模式 1.1', '是否自行服用抗菌药物')
    await changeText('回避回答 1.1', '先不想说这个。')

    await user.click(screen.getByRole('tab', { name: '查体与检查' }))
    await user.click(screen.getByRole('checkbox', { name: '危急结果 1' }))

    await user.click(screen.getByRole('tab', { name: '目录与库存' }))
    await changeText('危急值下限', '2')
    await changeText('危急值上限', '10')

    await user.click(screen.getByRole('tab', { name: '诊断与处置' }))
    fireEvent.change(screen.getByLabelText('必要处置要素'), {
      target: { value: '评估危险征象\n交代复诊指征' },
    })
    await changeText('费用参考依据', '依据当前虚构医院目录计费。')

    await user.click(screen.getByRole('tab', { name: '隐藏事实与揭示' }))
    await user.click(screen.getByRole('button', { name: '新增 Hidden Fact' }))
    await changeText('事实编码 2', 'topic-fever-detail')
    await user.selectOptions(screen.getByLabelText('事实患者 2'), 'synthetic-patient-001')
    await changeText('Hidden Fact 值 2', '昨夜开始高热，伴明显咽痛。')
    await user.click(screen.getByRole('button', { name: '新增 Reveal Policy' }))
    await changeText('策略编码 2', 'reveal-fever-detail')
    await user.selectOptions(screen.getByLabelText('关联事实 2'), 'topic-fever-detail')
    await user.selectOptions(screen.getByLabelText('策略患者 2'), 'synthetic-patient-001')
    await user.selectOptions(screen.getByLabelText('揭示时机 2'), 'after-topic')
    await user.selectOptions(screen.getByLabelText('问诊主题 2'), 'symptom-fever')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(savedContent).not.toBeUndefined())
    scenarioDatasetContentSchema.parse(savedContent)
    expect(savedContent).toMatchObject({
      hiddenFacts: [{}, {
        code: 'topic-fever-detail',
        patientId: 'synthetic-patient-001',
        value: '昨夜开始高热，伴明显咽痛。',
      }],
      patients: [{
        costBaseline: { referencePath: '依据当前虚构医院目录计费。' },
        encounter: {
          setting: '发热门诊',
          timeStateItems: [{ change: '体温升至 39.2 C。', triggerAfterMinutes: 45 }],
        },
        managementSpace: { requiredElements: ['评估危险征象', '交代复诊指征'] },
        patientKnowledge: {
          careMemory: '曾在社区就诊，但没有完成检查。',
          healthLiteracy: '能理解常见检查名称。',
          lifestyle: [{
            actual: '从不吸烟',
            admittedOnFirstAsk: '没有吸烟习惯。',
            concedeOnSecondAsk: true,
            label: '吸烟',
          }],
          neverKnows: ['尚未检查的实验室数值', '医生未告知的诊断'],
          toldDiagnoses: ['上呼吸道感染'],
        },
        persona: {
          character: '谨慎，回答具体。',
          healthLiteracy: '一般，避免使用专业术语。',
          speechStyle: '简短自然口语。',
        },
        physiologyBaseline: {
          generators: [{
            id: 'baseline-glucose',
            kind: 'constant',
            source: '合成病例基线',
            unit: 'mmol/L',
            value: 6.1,
          }],
          vitalSigns: {
            heightCm: 168,
            oxygenSaturationPct: 97,
            pulseBpm: 96,
            respirationBpm: 19,
            weightKg: 62,
          },
        },
        symptomResponses: [{
          avoids: [{
            questionPattern: '是否自行服用抗菌药物',
            response: '先不想说这个。',
          }],
        }],
        investigations: [{ critical: true }],
      }],
      catalog: {
        investigations: [{ criticalMaximum: 10, criticalMinimum: 2 }],
      },
      revealPolicies: [{}, {
        code: 'reveal-fever-detail',
        factCode: 'topic-fever-detail',
        patientId: 'synthetic-patient-001',
        triggerCode: 'after-topic',
        triggerId: 'symptom-fever',
      }],
    })
  }, 15_000)

  it('shows Dataset validation and disables installation after saving an invalid draft', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ invalidUpdate: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(await screen.findByText('hiddenFacts[0].patientId: Hidden Fact references an unknown patient')).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装运行' }).hasAttribute('disabled')).toBe(true)
  })

  it('reports a stale Dataset version without replacing the administrator draft', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ staleUpdate: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    await user.clear(screen.getByLabelText('患者姓名'))
    await user.type(screen.getByLabelText('患者姓名'), '未保存的合成患者')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect((screen.getByLabelText('患者姓名') as HTMLInputElement).value).toBe('未保存的合成患者')
  })

  it('confirms Dataset deletion and reports successful installation', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let deleted = false
    let installed = false
    stubScenarioDataWorkspace({
      onDelete: () => { deleted = true },
      onInstall: () => { installed = true },
    })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await user.click(await screen.findByRole('button', { name: '生成数据' }))
    await user.click(await screen.findByRole('button', { name: '编辑 发热门诊样本' }))
    await user.click(screen.getByRole('button', { name: '安装运行' }))
    expect(await screen.findByText('数据集已安装运行')).toBeTruthy()
    expect(installed).toBe(true)

    await user.click(screen.getByRole('button', { name: '删除数据集' }))
    const dialog = await screen.findByRole('alertdialog', { name: '确认删除数据集' })
    expect(deleted).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deleted).toBe(true))
    expect(screen.queryByRole('heading', { name: '数据集编辑' })).toBeNull()
  })

  it('does not expose synthetic data management to a non-administrator role', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubEmptyRegistrarWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('当前暂无门诊挂号。')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '模拟数据' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '模拟数据' })).toBeNull()
  })

  it('selects Synthea and follows a persistent generation job to completion', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ syntheaAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await screen.findByRole('option', { name: 'Synthea' })
    await user.selectOptions(screen.getByLabelText('生成服务'), 'synthea')
    await user.click(screen.getByRole('button', { name: '生成数据' }))

    expect(await screen.findByText('运行中')).toBeTruthy()
    expect(await screen.findByText('已完成')).toBeTruthy()
    expect(await screen.findByText('发热门诊样本')).toBeTruthy()
  })

  it('opens the persistent synthetic patient library before advanced case authoring', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true, syntheaAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '合成患者库' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成患者' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '数据生成服务' })).toBeNull()
    expect(screen.getByRole('tab', { name: '高级病例编排' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '生成患者' }))
    const generationSheet = await screen.findByRole('dialog', { name: '生成患者' })
    expect(within(generationSheet).getByRole('button', { name: /Synthea/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(generationSheet).getByRole('spinbutton', { name: '患者人数' }).getAttribute('max')).toBe('10')
  })

  it('edits a persistent profile and starts its outpatient visit', async () => {
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

    await user.click(screen.getByRole('button', { name: '发起门诊就诊' }))
    const visitSheet = await screen.findByRole('dialog', { name: '发起门诊就诊' })
    await user.click(within(visitSheet).getByRole('button', { name: '发起门诊就诊' }))

    expect((await screen.findAllByText('已有活动就诊')).length).toBeGreaterThan(0)
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

  it('creates a profile revision when an administrator saves source mappings', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    stubScenarioDataWorkspace({ profileAvailable: true })
    const user = userEvent.setup()

    render(<WebApp />)

    await user.click(await screen.findByRole('button', { name: '处理映射' }))
    const mappingSheet = await screen.findByRole('dialog', { name: '处理映射' })
    const mapping = within(mappingSheet).getByRole('combobox', {
      name: '发热 · Condition/condition-fever',
    })
    await user.click(mapping)
    await user.click(await screen.findByRole('option', { name: '急性上呼吸道感染 · J06.9' }))
    await user.click(within(mappingSheet).getByRole('button', { name: '保存映射' }))

    expect(await screen.findByText('Profile revision 2')).toBeTruthy()
    expect(screen.getByText('映射完整')).toBeTruthy()
  })

  it('submits a diabetes-only Synthea population while keeping one module selected', async () => {
    window.history.replaceState(null, '', '/scenario-data')
    let submittedRequest: ScenarioGenerationRequest | undefined
    stubScenarioDataWorkspace({
      onGenerate: request => { submittedRequest = request },
      syntheaAvailable: true,
    })
    const user = userEvent.setup()

    render(<WebApp />)

    await openAdvancedCaseAuthoring(user)

    await screen.findByRole('option', { name: 'Synthea' })
    await user.selectOptions(screen.getByLabelText('生成服务'), 'synthea')
    const fever = screen.getByRole('checkbox', { name: '发热门诊' })
    await user.click(fever)
    expect(fever.getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('checkbox', { name: '2 型糖尿病' }))
    await user.click(fever)
    expect(fever.getAttribute('aria-checked')).toBe('false')
    await user.click(screen.getByRole('button', { name: '生成数据' }))

    await waitFor(() => expect(submittedRequest?.modules).toEqual(['type-2-diabetes']))
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
    expect(document.body.textContent).not.toMatch(forbiddenEnglishClinicalUiTerms)
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
    await user.click(screen.getByRole('tab', { name: '新建合成患者' }))
    expect((await screen.findByRole('combobox', { name: '性别' })).textContent).toContain('男')
    expect((await screen.findByRole('combobox', { name: '科室' })).textContent).toContain('全科医学科')
    expect(screen.getByRole('combobox', { name: '号别' }).textContent).toContain('普通门诊挂号费 · ¥20.00')
    expect(screen.getByRole('combobox', { name: '就诊地点' }).textContent).toContain('发热门诊')
    await user.type(screen.getByLabelText('姓名'), '合成患者周明')
    await user.type(screen.getByLabelText('合成标识'), 'CM-SYN-001')
    await user.click(screen.getByRole('button', { name: '创建患者' }))

    expect(await screen.findByText('已选择：合成患者周明')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认挂号' }))

    expect(await screen.findByText('挂号完成')).toBeTruthy()
    expect(await screen.findByText('CM-OP-20260824-0001')).toBeTruthy()
  })

  it('exposes patient-search loading and service errors at the Web seam', async () => {
    let resolvePatientSearch: (response: Response) => void = () => undefined
    const patientSearch = new Promise<Response>((resolve) => {
      resolvePatientSearch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
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

    await user.type(await screen.findByLabelText('姓名、门诊号或合成标识'), patient.identifier)
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.click(await screen.findByRole('button', { name: `选择患者 ${patient.name}` }))
    await user.click(screen.getByRole('button', { name: '确认挂号' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByText('数据已发生变化，请刷新后重新确认。')).toBeTruthy()
  })

  it('keeps a long Chinese patient name available through search and selection', async () => {
    const longName = '合成患者用于验证窄视口下超长中文姓名仍可被完整识别与选择'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
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

    await user.type(await screen.findByLabelText('姓名、门诊号或合成标识'), 'CM-SYN-LONG-NAME')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.click(await screen.findByRole('button', { name: `选择患者 ${longName}` }))

    expect(await screen.findByText(`已选择：${longName}`)).toBeTruthy()
  })

  it('navigates the registration queue to the requested server page', async () => {
    const requestedPages: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(registrarSession)
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

  it('selects a clinically visible Virtual Patient and submits its expected version', async () => {
    let startRequests = 0
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients' && init?.method === undefined) {
        return Response.json({ items: [virtualPatient], ...pagination(1) })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients/virtual-patient-fever-001/actions/start') {
        startRequests += 1
        if (init === undefined) throw new Error('Expected a mutation request')
        expect(init.method).toBe('POST')
        expect(new Headers(init.headers).get('idempotency-key')).toBeTruthy()
        expect(JSON.parse(String(init.body))).toEqual({
          expectedVersions: {},
          input: { expectedVersion: 'opaque-virtual-patient-version-token' },
        })
        return Response.json(commandResponse({
          caseId: 'case-direct',
          encounterId: 'encounter-direct',
          patientId: 'candidate-patient-001',
          queueTaskId: 'task-doctor-direct',
          registrationId: 'registration-direct',
          status: 'first-visit',
          virtualPatientId: virtualPatient.id,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    const candidate = await screen.findByRole('button', {
      name: '选择候选患者 合成候选患者林晓',
    })
    expect(screen.getByText('发热、咽痛 1 天。')).toBeTruthy()
    await user.click(candidate)
    expect(screen.getByText('昨日傍晚开始发热，最高 38.7 °C，伴咽痛。')).toBeTruthy()
    expect(screen.getByText('38.6')).toBeTruthy()
    expect(screen.getByText('118/76')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '开始接诊' }))

    await waitFor(() => expect(startRequests).toBe(1))
  })

  it('refreshes Virtual Patients and the queue before opening the started case', async () => {
    let started = false
    let queueRequests = 0
    let virtualPatientRequests = 0
    const existingPatient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-existing',
      identifier: 'CM-SYN-EXISTING',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    const directPatient = {
      birthDate: virtualPatient.birthDate,
      gender: virtualPatient.gender,
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: virtualPatient.name,
      synthetic: true,
      versionId: '1',
    }
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        virtualPatientRequests += 1
        return Response.json({ items: started ? [] : [virtualPatient], ...pagination(started ? 0 : 1) })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        queueRequests += 1
        return Response.json({
          items: [{
            caseId: 'case-existing',
            encounterId: 'encounter-existing',
            encounterVersion: '2',
            patient: existingPatient,
            presentation: doctorPresentation,
            status: 'awaiting-doctor',
            taskId: 'task-doctor-existing',
            taskVersion: '1',
            triage: doctorTriage,
          }, ...(started ? [{
            caseId: 'case-direct',
            encounterId: 'encounter-direct',
            encounterVersion: '1',
            patient: directPatient,
            presentation: virtualPatientPresentation,
            status: 'first-visit',
            taskId: 'task-doctor-direct',
            taskVersion: '1',
          }] : [])],
          ...pagination(started ? 2 : 1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-existing') {
        return Response.json({
          allergies: [],
          caseId: 'case-existing',
          encounter: { id: 'encounter-existing', status: 'in-progress', versionId: '2' },
          patient: existingPatient,
          presentation: doctorPresentation,
          priorFacts: [],
          status: 'awaiting-doctor',
          taskId: 'task-doctor-existing',
          taskVersion: '1',
          triage: doctorTriage,
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-direct') {
        return Response.json({
          allergies: [],
          caseId: 'case-direct',
          encounter: { id: 'encounter-direct', status: 'in-progress', versionId: '1' },
          patient: directPatient,
          presentation: virtualPatientPresentation,
          priorFacts: [],
          status: 'first-visit',
          taskId: 'task-doctor-direct',
          taskVersion: '1',
        })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients/virtual-patient-fever-001/actions/start') {
        started = true
        return Response.json(commandResponse({
          caseId: 'case-direct',
          encounterId: 'encounter-direct',
          patientId: directPatient.id,
          queueTaskId: 'task-doctor-direct',
          registrationId: 'registration-direct',
          status: 'first-visit',
          virtualPatientId: virtualPatient.id,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('button', {
      name: '选择候选患者 合成候选患者林晓',
    }))
    await user.click(screen.getByRole('button', { name: '开始接诊' }))

    const firstVisitForm = await screen.findByRole('form', { name: '首诊记录' })
    expect(within(firstVisitForm).getByLabelText('现病史')).toBeTruthy()
    expect(screen.getByText('CM-SYN-CANDIDATE-001')).toBeTruthy()
    expect(screen.getByText('昨日傍晚开始发热，最高 38.7 °C，伴咽痛。')).toBeTruthy()
    expect(virtualPatientRequests).toBeGreaterThanOrEqual(2)
    expect(queueRequests).toBeGreaterThanOrEqual(2)
  })

  it('restores Consultation Records and shows a pending controlled-question response', async () => {
    const patient = {
      birthDate: '1988-03-16',
      gender: 'female',
      id: 'candidate-patient-001',
      identifier: 'CM-SYN-CANDIDATE-001',
      name: '合成候选患者林晓',
      synthetic: true,
      versionId: '1',
    }
    const questions = [{ code: 'symptom-onset', text: '什么时候开始发热？' }, {
      code: 'associated-symptoms',
      text: '除了发热，还有哪里不舒服？',
    }, {
      code: 'infection-cause',
      text: '知道是什么感染引起的吗？',
    }]
    let consultationVersion = 2
    let records = [{
      answer: '昨天傍晚开始发热，最高量到 38.7 °C。',
      id: 'consultation-record-1',
      question: questions[0],
      recordedAt: '2026-08-24T09:00:00+08:00',
      sequence: 1,
    }]
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
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
          consultation: { questions, records, version: consultationVersion },
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
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('idempotency-key')).toBeTruthy()
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: {
            'Encounter/encounter-direct': '1',
            'Task/task-doctor-direct': '1',
          },
          input: {
            expectedVersion: 2,
            questionCode: 'associated-symptoms',
          },
        })
        return new Promise<Response>(resolve => {
          releaseAnswer = () => {
            const record = {
              answer: '咽痛，吞咽时更明显，没有气促。',
              id: 'consultation-record-2',
              question: questions[1],
              recordedAt: '2026-08-24T09:00:00+08:00',
              sequence: 2,
            }
            consultationVersion = 3
            records = [...records, record]
            resolve(Response.json(commandResponse({
              caseId: 'case-direct',
              consultationVersion,
              record,
            })))
          }
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByText('昨天傍晚开始发热，最高量到 38.7 °C。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '除了发热，还有哪里不舒服？' }))
    await user.click(screen.getByRole('button', { name: '向患者提问' }))

    const pendingButton = await screen.findByRole('button', { name: '正在等待患者回答' })
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true)
    await act(async () => releaseAnswer?.())
    expect(await screen.findByText('咽痛，吞咽时更明显，没有气促。')).toBeTruthy()
    expect(screen.getByText('昨天傍晚开始发热，最高量到 38.7 °C。')).toBeTruthy()
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
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
          consultation: { questions: [question], records: [], version: 1 },
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

    await user.click(await screen.findByRole('button', { name: question.text }))
    await user.click(screen.getByRole('button', { name: '向患者提问' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByText('数据已发生变化，请刷新后重新确认。')).toBeTruthy()
    expect(screen.getByText('暂无问诊记录')).toBeTruthy()
    expect(screen.getByRole('button', { name: question.text })).toBeTruthy()
  })

  it('renders a specific empty state when no Virtual Patient is available', async () => {
    stubEmptyDoctorWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('暂无可接诊候选患者')).toBeTruthy()
    expect(screen.getByText('当前没有可接诊的候选患者。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenChineseClinicalUiTerms)
  })

  it('uses clinical operator language for the English doctor empty state', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'light',
    }))
    stubEmptyDoctorWorkspace()

    render(<WebApp />)

    expect(await screen.findByText('No candidate patients available')).toBeTruthy()
    expect(screen.getByText('No candidate patient is currently available for consultation.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(forbiddenEnglishClinicalUiTerms)
  })

  it('shows the operation-conflict alert when a Virtual Patient version is stale', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [virtualPatient], ...pagination(1) })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients/virtual-patient-fever-001/actions/start') {
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            message: 'The Virtual Patient version has changed',
          },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('button', {
      name: '选择候选患者 合成候选患者林晓',
    }))
    await user.click(screen.getByRole('button', { name: '开始接诊' }))

    expect(await screen.findByText('操作冲突')).toBeTruthy()
    expect(screen.getByText('数据已发生变化，请刷新后重新确认。')).toBeTruthy()
  })

  it('saves and issues the selected controlled laboratory request', async () => {
    let draft: { catalogItemId: string; indicationCode: string } | undefined
    let draftVersion = 0
    let request: {
      catalogItemId: 'lab-crp'
      id: string
      indicationCode: string
      previousReports: []
      serviceRequestId: string
      serviceRequestVersion: string
      status: 'issued'
      taskId: string
      taskVersion: string
      version: number
    } | undefined
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
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          }, {
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
          }],
          ...pagination(1),
        })
      }
      if (url.pathname === '/api/his/v1/doctor/cases/case-virtual-1') {
        return Response.json({
          allergies: [],
          caseId: 'case-virtual-1',
          consultation: { questions: [], records: [], version: 1 },
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
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(init?.method).toBe('PUT')
        expect(body).toEqual({
          expectedVersions: { 'Encounter/encounter-virtual-1': '1' },
          input: {
            catalogItemId: 'lab-crp',
            expectedDraftVersion: 0,
            indicationCode: 'fever',
          },
        })
        draft = { catalogItemId: 'lab-crp', indicationCode: 'fever' }
        draftVersion = 1
        return Response.json(commandResponse({ caseId: 'case-virtual-1', draftVersion }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-virtual-1/laboratory-request/actions/issue') {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersions: Record<string, string>
          input: Record<string, unknown>
        }
        expect(body).toEqual({
          expectedVersions: { 'Encounter/encounter-virtual-1': '1' },
          input: { expectedDraftVersion: 1 },
        })
        draft = undefined
        draftVersion = 2
        request = {
          catalogItemId: 'lab-crp',
          id: 'laboratory-request-crp-1',
          indicationCode: 'fever',
          previousReports: [],
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
    render(<WebApp />)

    const laboratoryItem = await screen.findByRole('combobox', { name: '检验项目' })
    await user.click(laboratoryItem)
    expect(await screen.findByRole('option', { name: '血常规 · ¥25.00' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'C 反应蛋白 · ¥43.00' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '发热检验组合 · ¥68.00' })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'C 反应蛋白 · ¥43.00' }))
    await user.click(screen.getByRole('button', { name: '保存检查草稿' }))

    expect(await screen.findByText('检查草稿已保存')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '开具检查申请' }))

    expect(await screen.findByRole('cell', { name: 'C 反应蛋白' })).toBeTruthy()
    expect(screen.getByText('已开具')).toBeTruthy()
  })

  it('shows laboratory request statuses and exposes only valid correction actions', async () => {
    let cancellationRequests = 0
    let draftDeletionRequests = 0
    let draft: { catalogItemId: string; indicationCode: string } | undefined = {
      catalogItemId: 'lab-cbc',
      indicationCode: 'fever',
    }
    let draftVersion = 1
    const request = (
      status: 'accepted' | 'acknowledged' | 'cancelled' | 'in-progress' | 'issued' | 'reported',
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
      taskVersion: status === 'issued' ? '1' : '2',
      version: status === 'issued' ? 1 : 2,
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
    let requests: LaboratoryRequest[] = [
      request('issued', 1),
      request('accepted', 2),
      request('in-progress', 3),
      reportedRequest,
      acknowledgedRequest,
      request('cancelled', 6),
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
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          consultation: { questions: [], records: [], version: 1 },
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
          consultation: { questions: [], records: [], version: 1 },
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
    render(<WebApp />)

    expect(await screen.findByText('已开具')).toBeTruthy()
    for (const label of ['已受理', '执行中', '已报告', '已取消']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByText('医生已阅')).toHaveLength(2)
    expect(screen.getByText('等待检验结果')).toBeTruthy()
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
    const cancelButtons = screen.getAllByRole('button', { name: /取消检查申请/ })
    expect(cancelButtons).toHaveLength(1)
    expect(cancelButtons[0]?.getAttribute('aria-label')).toBe('取消检查申请 C 反应蛋白')

    await user.click(cancelButtons[0] as HTMLElement)
    const cancelDialog = await screen.findByRole('alertdialog', { name: '确认取消检查申请' })
    expect(cancellationRequests).toBe(0)
    expect(within(cancelDialog).getByText('C 反应蛋白')).toBeTruthy()
    expect(within(cancelDialog).getByText('已开具')).toBeTruthy()
    await user.click(within(cancelDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText(
      '检查申请当前状态为“已受理”，版本为 2。请刷新后重新确认。',
    )).toBeTruthy()
    expect(screen.queryByText(/The laboratory request cannot be cancelled/)).toBeNull()
    expect(cancellationRequests).toBe(1)

    await user.click(within(cancelDialog).getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('listitem', { name: '选择病例 合成候选患者周远' }))
    expect(await screen.findByText('当前无正式检查申请')).toBeTruthy()
    expect(screen.queryByText(
      '检查申请当前状态为“已受理”，版本为 2。请刷新后重新确认。',
    )).toBeNull()

    await user.click(screen.getByRole('listitem', { name: '选择病例 合成候选患者林晓' }))
    const retryCancelButton = (await screen.findAllByRole('button', { name: /取消检查申请/ }))[0]
    if (retryCancelButton === undefined) throw new Error('Cancellable request was not restored')
    await user.click(retryCancelButton)
    const retryCancelDialog = await screen.findByRole('alertdialog', { name: '确认取消检查申请' })
    await user.click(within(retryCancelDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText('检查申请已取消')).toBeTruthy()
    expect(cancellationRequests).toBe(2)
    await waitFor(() => expect(screen.queryByText('已开具')).toBeNull())
    await user.click(screen.getByRole('button', { name: '删除检查草稿' }))
    const deleteDialog = await screen.findByRole('alertdialog', { name: '确认删除检查草稿' })
    expect(draftDeletionRequests).toBe(0)
    expect(within(deleteDialog).getByText('血常规')).toBeTruthy()
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('检查草稿已删除')).toBeTruthy()
    expect(draftDeletionRequests).toBe(1)
    await waitFor(() => expect(screen.queryByText('检查草稿已保存')).toBeNull())

    await user.click(screen.getByRole('listitem', { name: '选择病例 合成候选患者周远' }))
    expect(await screen.findByText('当前无正式检查申请')).toBeTruthy()
    expect(screen.queryByText('检查草稿已删除')).toBeNull()
  })

  it('keeps polling an in-progress laboratory request until its report arrives', async () => {
    const polling = stubLaboratoryReportPolling(true)
    render(<WebApp />)

    expect(await screen.findByText('等待检验结果')).toBeTruthy()
    polling.makeReportReady()
    await waitFor(() => {
      expect(screen.getByText('C 反应蛋白升高。')).toBeTruthy()
    }, { timeout: 3_000 })
    expect(screen.queryByText('等待检验结果')).toBeNull()
    expect(polling.detailRequestCount()).toBeGreaterThanOrEqual(2)
  })

  it('does not poll an in-progress request when Scenario reporting is unsupported', async () => {
    const polling = stubLaboratoryReportPolling(false)
    render(<WebApp />)

    expect(await screen.findByText('等待检验结果')).toBeTruthy()
    const initialDetailRequests = polling.detailRequestCount()
    await act(async () => new Promise(resolve => setTimeout(resolve, 1_700)))

    expect(polling.detailRequestCount()).toBe(initialDetailRequests)
  })

  it('starts the first visit, saves a CAS draft, and issues the laboratory order', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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

    expect(await screen.findByText('门诊医生 · 合成门诊医生')).toBeTruthy()
    expect(await screen.findByRole('listitem', { name: '选择病例 合成患者周明' })).toBeTruthy()
    expect((await screen.findByText('脉搏（次/分）')).nextElementSibling?.textContent).toBe('102')
    expect(screen.getByText('呼吸（次/分）').nextElementSibling?.textContent).toBe('20')
    expect(screen.getByText('血压（mmHg）').nextElementSibling?.textContent).toBe('118/76')
    expect(screen.getByText('血氧饱和度（%）').nextElementSibling?.textContent).toBe('98')
    await user.click(await screen.findByRole('button', { name: '开始首诊' }))
    expect((await screen.findByRole('combobox', { name: '检验项目' })).textContent).toContain('发热检验组合 · ¥68.00')
    expect(screen.getByRole('combobox', { name: '检验适应证' }).textContent).toContain('发热')

    const firstVisitForm = await screen.findByRole('form', { name: '首诊记录' })
    await user.type(within(firstVisitForm).getByLabelText('现病史'), '两天前出现发热，伴咽痛。')
    await user.type(within(firstVisitForm).getByLabelText('首诊评估'), '急性发热，待检验明确病原')
    await user.click(within(firstVisitForm).getByRole('button', { name: '保存首诊草稿' }))
    expect(await screen.findByText('草稿已保存')).toBeTruthy()

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

    expect(await screen.findByText('数据已发生变化，请刷新后重新确认。')).toBeTruthy()
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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

    expect(await screen.findByText('甲型流感抗原')).toBeTruthy()
    expect(screen.getAllByText('阳性')).toHaveLength(2)
    expect(screen.getByText(/6\.8.*×10⁹\/L/)).toBeTruthy()
    expect(screen.getByText('磷酸奥司他韦过敏')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '开始复诊' }))
    expect((await screen.findByRole('combobox', { name: '药品' })).textContent).toContain('磷酸奥司他韦胶囊')
    expect(screen.getByRole('combobox', { name: '剂量' }).textContent).toContain('75 mg')
    expect(screen.getByRole('combobox', { name: '频次' }).textContent).toContain('BID')

    await user.type(await screen.findByLabelText('诊断编码'), 'J10.1')
    await user.type(screen.getByLabelText('诊断名称'), '甲型流感')
    await user.type(screen.getByLabelText('复诊评估'), '甲型流感，生命体征稳定。')
    await user.type(screen.getByLabelText('诊疗计划'), '口服抗病毒药物，对症处理，必要时复诊。')
    await user.clear(screen.getByLabelText('数量'))
    await user.type(screen.getByLabelText('数量'), '10')
    await user.click(screen.getByRole('button', { name: '保存复诊草稿' }))

    expect(await screen.findByText('复诊草稿已保存')).toBeTruthy()
    expect(screen.getByText('CM-RX-20260824-0001')).toBeTruthy()
  })

  it('saves and confirms independent primary and secondary diagnoses from the controlled catalog', async () => {
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
      role: 'primary',
    }, {
      catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
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
        code: 'J06.9',
        conditionId: 'condition-diagnosis-secondary',
        conditionVersion: '1',
        display: '急性上呼吸道感染',
        system: 'http://hl7.org/fhir/sid/icd-10',
      }],
      id: 'diagnosis-confirmation-1',
      provenanceId: 'provenance-diagnosis-1',
    }
    let diagnosis: DiagnosisState | undefined
    let encounterVersion = '6'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          diagnoses,
          laboratory: [],
          medications: [],
          prescriptionConclusionSupported: false,
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
          consultation: { questions: [], records: [], version: 1 },
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
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-independent-diagnosis': '6' },
          input: { entries: draftEntries, expectedDraftVersion: 0 },
        })
        diagnosis = { draft: { entries: draftEntries }, draftVersion: 1 }
        return Response.json(commandResponse({ draftVersion: 1 }))
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-independent-diagnosis/diagnosis/actions/confirm') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersions: { 'Encounter/encounter-independent-diagnosis': '6' },
          input: { expectedDraftVersion: 1 },
        })
        encounterVersion = '7'
        diagnosis = { confirmation, draftVersion: 2 }
        return Response.json(commandResponse({
          confirmation,
          diagnosisVersion: 2,
          encounterId: 'encounter-independent-diagnosis',
          encounterVersion,
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('complementary', { name: '病情摘要' })).toBeTruthy()
    await user.click(await screen.findByRole('tab', { name: '检验检查' }))
    expect((await screen.findAllByText(/既往咳嗽/)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: '用药结论' })).toBeNull()
    expect(screen.queryByLabelText('诊断编码')).toBeNull()
    await user.click(screen.getByRole('tab', { name: '诊断' }))
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    await user.click(screen.getByRole('combobox', { name: '诊断项目' }))
    await user.click(await screen.findByRole('option', { name: '流感伴其他呼吸道表现 · J10.1' }))
    await user.type(screen.getByLabelText('诊断备注'), '结合甲型流感抗原结果。')
    await user.click(screen.getByRole('button', { name: '添加诊断' }))
    await user.click(screen.getByRole('combobox', { name: '诊断项目 2' }))
    await user.click(await screen.findByRole('option', { name: '急性上呼吸道感染 · J06.9' }))
    await user.click(screen.getByRole('button', { name: '确认诊断' }))
    expect(await screen.findByText('诊断已确认')).toBeTruthy()
    expect(screen.getByText('J10.1 · 流感伴其他呼吸道表现')).toBeTruthy()
    expect(screen.getByText('J06.9 · 急性上呼吸道感染')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '检验检查' }))
    expect(screen.getAllByText(/既往咳嗽/).length).toBeGreaterThan(0)
  })

  it('keeps each patient clinical record while aligning the consultation workbench', async () => {
    const questions = [{ code: 'symptom-onset', text: '什么时候开始不舒服？' }]
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          consultation: { questions, records: [], version: 1 },
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
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('tab', { name: '病历记录' })).toBeTruthy()
    expect(screen.getAllByRole('img', { name: '王晓明 患者' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('complementary', { name: '诊疗对话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起右侧边栏' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('heading', { name: '过敏提示' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '向患者提问' })).toBeTruthy()
    const history = screen.getByLabelText('现病史') as HTMLTextAreaElement
    await user.clear(history)
    await user.type(history, '患者三天前受凉后出现咳嗽、发热。')
    await user.click(screen.getByRole('listitem', { name: '选择病例 李静' }))
    await user.click(await screen.findByRole('listitem', { name: '选择病例 王晓明' }))

    expect((await screen.findByLabelText('现病史') as HTMLTextAreaElement).value)
      .toBe('患者三天前受凉后出现咳嗽、发热。')
    expect(screen.queryByText(/保存.*草稿|草稿版本|版本 \d/)).toBeNull()
  })

  it('completes an eligible Encounter from the patient header and converts it to read-only', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
            questions: [{ code: 'symptom-onset', text: '什么时候开始发热？' }],
            records: [],
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

    expect(await screen.findByRole('complementary', { name: '诊疗队列' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '病例详情' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '诊疗对话' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '病历记录' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '诊断' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '处方' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '检验检查' })).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '完诊' }))
    expect(screen.getByRole('heading', { name: '确认完诊' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认完诊' }))

    expect(await screen.findByText('Encounter 已完成，当前病例为只读。')).toBeTruthy()
    expect(screen.getByText('当前无待诊病例')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '向患者提问' })).toBeNull()
    expect(screen.queryByRole('button', { name: '提交病历修订' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认完诊' })).toBeNull()
    expect(screen.getByText('已确认无需用药')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '病历记录' }))
    expect(screen.getByRole('heading', { name: '签署历史' })).toBeTruthy()
  })

  it('shows the server diagnosis primary validation error in the doctor workspace', async () => {
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-diagnosis-validation',
      identifier: 'CM-SYN-DIAGNOSIS-002',
      name: '合成患者周明',
      synthetic: true,
      versionId: '1',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          consultation: { questions: [], records: [], version: 1 },
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
      if (url.pathname === '/api/his/v1/encounters/encounter-diagnosis-validation/diagnosis/actions/confirm') {
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

    await user.click(await screen.findByRole('button', { name: '确认诊断' }))
    expect(await screen.findByText('必须且只能选择一个主诊断。')).toBeTruthy()
  })

  it('saves and issues a controlled prescription, withdraws it, and confirms no medication', async () => {
    const patient = {
      birthDate: '1990-05-10',
      gender: 'male',
      id: 'patient-prescription-conclusion',
      identifier: 'CM-SYN-PRESCRIPTION-001',
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
    let draftDeletionRequests = 0
    let medicationConclusion: DoctorCaseDetail['medicationConclusion']
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          consultation: { questions: [], records: [], version: 1 },
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
          input: { expectedDraftVersion, items: [draftItem] },
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

    expect((await screen.findByRole('combobox', { name: '药品' })).textContent).toContain('磷酸奥司他韦胶囊')
    expect(screen.getByRole('combobox', { name: '剂量' }).textContent).toContain('75 mg')
    expect(screen.getByRole('combobox', { name: '频次' }).textContent).toContain('BID')
    expect(screen.getByRole('combobox', { name: '疗程' }).textContent).toContain('5 天')
    expect(screen.getByRole('combobox', { name: '数量' }).textContent).toContain('10')
    await user.click(screen.getByRole('button', { name: '保存处方草稿' }))

    expect(await screen.findByText('处方草稿已保存')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    const deleteDialog = await screen.findByRole('alertdialog', { name: '确认删除处方草稿' })
    expect(draftDeletionRequests).toBe(0)
    expect(within(deleteDialog).getByText('磷酸奥司他韦胶囊')).toBeTruthy()
    await user.click(within(deleteDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('处方草稿已删除')).toBeTruthy()
    expect(draftDeletionRequests).toBe(1)
    await user.click(screen.getByRole('button', { name: '保存处方草稿' }))
    expect(await screen.findByText('处方草稿已保存')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '正式开具处方' }))
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
  })

  it('keeps the prescription draft visible when controlled issuance is rejected', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
          consultation: { questions: [], records: [], version: 1 },
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

    await user.click(await screen.findByRole('button', { name: '正式开具处方' }))
    expect(await screen.findByText('当前诊断、过敏信息、目录或处方状态不允许正式开具，请检查后重试。')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '药品' }).textContent).toContain('磷酸奥司他韦胶囊')
    expect(screen.getByRole('combobox', { name: '剂量' }).textContent).toContain('75 mg')
    expect(screen.getByRole('combobox', { name: '频次' }).textContent).toContain('BID')
    expect(screen.getByRole('combobox', { name: '疗程' }).textContent).toContain('5 天')
    expect(screen.getByRole('combobox', { name: '数量' }).textContent).toContain('10')
  })

  it('previews clinical signing and completes the Encounter before medication payment', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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

    await user.click(await screen.findByRole('button', { name: '预览签署' }))
    expect(await screen.findByRole('heading', { name: '签署预览' })).toBeTruthy()
    expect(screen.getByText('J10.1 · 甲型流感')).toBeTruthy()
    expect(screen.getAllByText('¥76.00').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '确认签署并完诊' }))

    expect(await screen.findByText('Encounter 已完成')).toBeTruthy()
    expect(screen.getByText('待药品缴费')).toBeTruthy()
  })

  it('recovers a versioned structured Clinical Document draft and signs it without completing the Encounter', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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
    await user.click(within(recoveredForm).getByRole('button', { name: '保存病历草稿' }))
    const pendingButton = await within(recoveredForm).findByRole('button', { name: '正在保存病历' })
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
    await user.click(within(refreshedForm).getByRole('button', { name: '保存病历草稿' }))
    expect(await screen.findByText('病历草稿已保存')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '预览病历签署' }))
    const previewHeading = await screen.findByRole('heading', { name: '病历签署预览' })
    expect(within(previewHeading.parentElement as HTMLElement)
      .getByText('复核并合并并发编辑后的最终评估。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认签署病历' }))

    expect(await screen.findByText('病历已签署')).toBeTruthy()
    expect(screen.getByText('Encounter 仍为诊疗中')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '签署历史' })).toBeTruthy()
    expect(screen.getByText('版本 1')).toBeTruthy()
  })

  it('binds a Clinical Document revision confirmation to its previewed source version', async () => {
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
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [], ...pagination(0) })
      }
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

    const revisionForm = screen.getByRole('form', { name: '修订病历版本 2' })
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
    const listRequests: URL[] = []
    stubDoctorCompletedCaseLibrary({
      list: { items: [], ...pagination(0) },
      onListRequest: url => listRequests.push(url),
    })
    const user = userEvent.setup()
    render(<WebApp />)

    await user.click(await screen.findByRole('tab', { name: '已完诊病例' }))
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
        records: [{
          answer: '症状自前日晚间开始，最高体温 38.7 摄氏度，并伴有持续咽痛、乏力及同住家属近期流感样症状。',
          id: 'consultation-record-completed-1',
          question: { code: 'symptom-onset', text: '症状何时开始？' },
          recordedAt: '2026-08-24T08:05:00+08:00',
          sequence: 1,
        }],
        version: 1,
      },
      diagnosis: {
        confirmedAt: '2026-08-24T08:30:00+08:00',
        entries: [diagnosisEntry],
        id: 'diagnosis-confirmation-completed-1',
        provenanceId: 'provenance-diagnosis-completed-1',
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

    await user.click(await screen.findByRole('tab', { name: '已完诊病例' }))
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
      consultation: { questions: [], records: [], version: 1 },
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

    await user.click(await screen.findByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    await user.click(await screen.findByRole('button', { name: '撤回处方' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-medication-conclusion')
    })
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
    await user.click(screen.getByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText(/处方已撤回/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
  })

  it('keeps legacy completed facts readable without unsupported correction navigation', async () => {
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

    await user.click(await screen.findByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))

    expect(await screen.findByText('甲型流感，生命体征稳定。')).toBeTruthy()
    expect(screen.getByText('甲型流感抗原阳性。')).toBeTruthy()
    expect(screen.getByText('处方号 RX-COMPLETED-LEGACY-001')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更正病历' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更正检查报告' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤回处方' })).toBeNull()
  })

  it('completes all five controlled clinical correction classes and shows the final timeline', async () => {
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
      consultation: { questions: [], records: [], version: 1 },
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

    await user.click(await screen.findByRole('button', { name: '删除检查草稿' }))
    const laboratoryDraftDialog = await screen.findByRole('alertdialog', {
      name: '确认删除检查草稿',
    })
    expect(within(laboratoryDraftDialog).getByText('C 反应蛋白')).toBeTruthy()
    await user.click(within(laboratoryDraftDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('检查草稿已删除')).toBeTruthy()
    expect(laboratoryDraftDeletionRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 1 },
    })

    await user.click(screen.getByRole('button', { name: '取消检查申请 血常规' }))
    const laboratoryCancellationDialog = await screen.findByRole('alertdialog', {
      name: '确认取消检查申请',
    })
    expect(within(laboratoryCancellationDialog).getByText('血常规')).toBeTruthy()
    await user.click(within(laboratoryCancellationDialog).getByRole('button', { name: '确认取消' }))
    expect(await screen.findByText('检查申请已取消')).toBeTruthy()
    expect(laboratoryCancellationRequest).toEqual({
      expectedVersions: {
        'ServiceRequest/service-request-cancellation-1': '1',
        'Task/task-laboratory-cancellation-1': '1',
      },
      input: { expectedRequestVersion: 1, reasonCode: 'no-longer-needed' },
    })

    await user.click(screen.getByRole('button', { name: '删除处方草稿' }))
    const prescriptionDraftDialog = await screen.findByRole('alertdialog', {
      name: '确认删除处方草稿',
    })
    expect(within(prescriptionDraftDialog).getByText('磷酸奥司他韦胶囊')).toBeTruthy()
    await user.click(within(prescriptionDraftDialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('处方草稿已删除')).toBeTruthy()
    expect(prescriptionDraftDeletionRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 1 },
    })

    await user.click(screen.getByRole('button', { name: '保存处方草稿' }))
    expect(await screen.findByText('处方草稿已保存')).toBeTruthy()
    expect(prescriptionDraftRequest).toEqual({
      expectedVersions: { 'Encounter/encounter-completed-correction-1': '6' },
      input: { expectedDraftVersion: 2, items: [prescriptionDraftItem] },
    })
    await user.click(screen.getByRole('button', { name: '正式开具处方' }))
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

    await user.click(await screen.findByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('只读详情')).toBeTruthy()
    expect(screen.getByText('偏高').getAttribute('data-variant')).toBe('warning')
    expect(screen.queryByRole('button', { name: '提交病历修订' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '更正病历' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-clinical-document')
    })
    expect(screen.getByRole('tab', { name: '当前诊疗' }).getAttribute('aria-selected')).toBe('true')
    const revisionForm = await screen.findByRole('form', { name: '修订病历版本 1' })
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

    await user.click(screen.getByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('版本 2')).toBeTruthy()
    expect(screen.getByText('补充检验复核后的处置说明。')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '更正检查报告' }))
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('encounter-completion-target-laboratory')
    })
    expect(screen.getByRole('tab', { name: '当前诊疗' }).getAttribute('aria-selected')).toBe('true')
    const correctionForm = await screen.findByRole('form', { name: '更正检查报告 C 反应蛋白' })
    await user.clear(within(correctionForm).getByLabelText('更正后结论'))
    await user.type(within(correctionForm).getByLabelText('更正后结论'), '复核后 C 反应蛋白仍升高。')
    await user.clear(within(correctionForm).getByLabelText('C 反应蛋白 · 结果'))
    await user.type(within(correctionForm).getByLabelText('C 反应蛋白 · 结果'), '29.1')
    await user.type(within(correctionForm).getByLabelText('更正原因'), '复核仪器原始数据后更正。')
    await user.click(within(correctionForm).getByRole('button', { name: '预览报告更正' }))
    const confirmation = await screen.findByRole('alertdialog', { name: '确认更正检查报告' })
    expect(within(confirmation).getByText('复核后 C 反应蛋白仍升高。')).toBeTruthy()
    expect(within(confirmation).getByText('29.1 mg/L')).toBeTruthy()
    expect(within(confirmation).getByText('复核仪器原始数据后更正。')).toBeTruthy()
    await user.click(within(confirmation).getByRole('button', { name: '确认更正检查报告' }))
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

    await user.click(screen.getByRole('tab', { name: '已完诊病例' }))
    await user.click(await screen.findByRole('button', { name: `查看病例 ${patient.name}` }))
    expect(await screen.findByText('第 2 版（当前）')).toBeTruthy()
    expect(screen.getByText('复核后 C 反应蛋白仍升高。')).toBeTruthy()
    const timeline = screen.getByRole('region', { name: '业务时间线' })
    expect(within(timeline).getByText('签署病历')).toBeTruthy()
    expect(within(timeline).getByText('修订病历')).toBeTruthy()
    expect(within(timeline).getByText('删除检查草稿')).toBeTruthy()
    expect(within(timeline).getByText('开具检查申请')).toBeTruthy()
    expect(within(timeline).getByText('取消检查申请')).toBeTruthy()
    expect(within(timeline).getByText('签发检查报告')).toBeTruthy()
    expect(within(timeline).getByText('更正检查报告')).toBeTruthy()
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
