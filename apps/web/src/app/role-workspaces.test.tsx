// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebApp } from './web-app.tsx'

const doctorTriage = {
  acuityCode: 'level-3',
  bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
  chiefComplaint: '发热伴咽痛两天',
  oxygenSaturationPct: 98,
  pulseBpm: 102,
  respirationBpm: 20,
  temperatureC: 38.2,
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
  version: 7,
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

const doctorSession = {
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

  it('opens the administrator on the active Scenario controls', async () => {
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

    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '场景运行' })).toBeTruthy()
    expect(screen.getByText('candidate-fever-outpatient-v1')).toBeTruthy()
    expect(screen.getByText('epoch-1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装候选场景' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装密度场景' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重置运行' })).toBeTruthy()
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

    await user.click(await screen.findByRole('tab', { name: '新建合成患者' }))
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
        return Response.json({ laboratory: [], medications: [] })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients' && init?.method === undefined) {
        return Response.json({ items: [virtualPatient] })
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
          input: { expectedVersion: 7 },
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
        return Response.json({ laboratory: [], medications: [] })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        virtualPatientRequests += 1
        return Response.json({ items: started ? [] : [virtualPatient] })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        queueRequests += 1
        return Response.json({
          items: [{
            caseId: 'case-existing',
            encounterId: 'encounter-existing',
            encounterVersion: '2',
            patient: existingPatient,
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

    expect(await screen.findByLabelText('现病史')).toBeTruthy()
    expect(screen.getByText('CM-SYN-CANDIDATE-001')).toBeTruthy()
    expect(screen.getByText('昨日傍晚开始发热，最高 38.7 °C，伴咽痛。')).toBeTruthy()
    expect(virtualPatientRequests).toBeGreaterThanOrEqual(2)
    expect(queueRequests).toBeGreaterThanOrEqual(2)
  })

  it('renders a specific empty state when no Virtual Patient is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({ laboratory: [], medications: [] })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [] })
      }
      if (url.pathname === '/api/his/v1/doctor/queue') {
        return Response.json({ items: [], ...pagination(0) })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    render(<WebApp />)

    expect(await screen.findByText('暂无可接诊候选患者')).toBeTruthy()
    expect(screen.getByText('当前场景没有待建立接诊上下文的候选患者。')).toBeTruthy()
  })

  it('shows the operation-conflict alert when a Virtual Patient version is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') return Response.json(doctorSession)
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({ laboratory: [], medications: [] })
      }
      if (url.pathname === '/api/his/v1/doctor/virtual-patients') {
        return Response.json({ items: [virtualPatient] })
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
        return Response.json({ items: [] })
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

    await user.type(await screen.findByLabelText('现病史'), '两天前出现发热，伴咽痛。')
    await user.type(screen.getByLabelText('首诊评估'), '急性发热，待检验明确病原')
    await user.click(screen.getByRole('button', { name: '保存首诊草稿' }))
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
    expect(screen.getByRole('combobox', { name: '模拟支付结果' }).textContent).toContain('成功')

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

    await user.click(await screen.findByRole('combobox', { name: '模拟支付结果' }))
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
        return Response.json({ items: [] })
      }
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [{
            allowedCombinationIds: [],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 7600,
            version: 1,
          }],
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
        return Response.json({ items: [] })
      }
      if (url.pathname === '/api/his/v1/catalogs/clinical') {
        return Response.json({
          laboratory: [],
          medications: [{
            allowedCombinationIds: [],
            allowedDoseTexts: ['75 mg'],
            allowedFrequencyCodes: ['BID'],
            defaultDoseText: '75 mg',
            defaultFrequencyCode: 'BID',
            id: 'medication-oseltamivir',
            nameEn: 'Oseltamivir capsules',
            nameZh: '磷酸奥司他韦胶囊',
            priceFen: 7600,
            version: 1,
          }],
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
    expect(screen.getByText('Scenario Run 仍在进行')).toBeTruthy()
    expect(await screen.findByText('部分已发')).toBeTruthy()
    const remainder = await screen.findByRole('spinbutton', {
      name: '本次发放数量 · 磷酸奥司他韦胶囊',
    }) as HTMLInputElement
    expect(remainder.value).toBe('6')
    await user.click(screen.getByRole('button', { name: '确认发药' }))

    expect(await screen.findByText('Scenario Run 已完成')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '已发药' }))
    expect((await screen.findAllByText('CM-RX-20260824-0001')).length).toBeGreaterThan(0)
    expect(screen.getByText('库存 990')).toBeTruthy()
  })
})
