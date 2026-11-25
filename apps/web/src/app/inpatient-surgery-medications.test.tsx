// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SYNTHETIC_PACKAGE_INSERT_DISCLAIMER } from '@clinmesh/contracts/medication-safety'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import {
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryExecutionSchema,
  inpatientSurgeryRequestSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { buildSurgicalMedicationPackages } from '@clinmesh/core/inpatient-surgery-medications'
import { SurgeryExecuteComposer } from './inpatient-surgery-execute-composer.tsx'
import { InpatientSurgeryMaterials } from './inpatient-surgery-materials.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function makeSession(roleCode: 'inpatient-doctor' | 'ward-nurse' | 'medical-records'): SessionContext {
  return {
    actor: {
      actorId: roleCode,
      workspaceId: 'workspace-demo',
      epoch: 'epoch-1',
      scenarioRunId: 'run-1',
      practitionerRoleId: `role-${roleCode}`,
      roleCode,
    },
    user: { id: roleCode, name: roleCode, email: `${roleCode}@demo.clinmesh.local` },
    availableRoles: [],
  }
}

const admission = inpatientAdmissionSchema.parse({
  id: 'admission-1',
  patientId: 'patient-1',
  patientName: '合成患者',
  inpatientNumber: 'ZY-001',
  admissionRoute: 'direct',
  wardId: 'ward-1',
  organizationId: 'org-1',
  status: 'admitted',
  financialStatus: 'open',
  recordStatus: 'open',
  registeredAt: '2026-11-24T00:00:00+08:00',
  depositFen: 0,
  chargesFen: 0,
  versionId: '1',
})

const angioProc = {
  id: 'hospital-surgery-7',
  version: 1,
  coding: {
    system: 'urn:clinmesh:classification:icd-9-cm-3-clinical' as const,
    version: '3.0' as const,
    code: '88.5500',
    display: '单根导管的冠状动脉造影术',
    category: '诊断性操作' as const,
    releaseId: 'clinmesh-surgery-subset-2026-10-20' as const,
    sourceUrl: 'https://example.com/s',
    sourceSha256: 'a'.repeat(64),
    sourceLocator: 's',
  },
  chargeDefinition: {
    id: 'hospital-charge-surgery-7',
    priceFen: 80000,
    unit: '次',
    synthetic: true as const,
    trigger: 'execution' as const,
  },
}

const appendectomyProc = {
  ...angioProc,
  id: 'hospital-surgery-4',
  coding: { ...angioProc.coding, code: '47.0100', display: '腹腔镜下阑尾切除术', category: '手术' as const },
  chargeDefinition: { ...angioProc.chargeDefinition, id: 'hospital-charge-surgery-4', priceFen: 200000 },
}

const baseStockMedications = [
  {
    id: 'medication-pci-iohexol',
    version: 1,
    code: 'XV08ABD107B002010100014',
    display: '碘海醇注射液',
    unit: 'mL',
    priceFen: 150,
    strength: '30 g/100 mL',
    packageDescription: '100mL/瓶',
    defaultRouteCode: 'IV' as const,
    allowedRouteCodes: ['IV' as const, 'IVGTT' as const],
    doses: [{ doseText: '50 mL', quantity: 50 }],
    doseBasis: { amount: 1, unit: 'mL' },
    maxDoseQuantity: 100,
  },
  {
    id: 'medication-pci-heparin',
    version: 1,
    code: 'XB01ABG047B002010100651',
    display: '肝素钠注射液',
    unit: 'mL',
    priceFen: 200,
    strength: '6250 IU',
    packageDescription: '10支/盒',
    defaultRouteCode: 'IV' as const,
    allowedRouteCodes: ['IV' as const, 'IVGTT' as const, 'IH' as const],
    doses: [{ doseText: '1 mL', quantity: 1 }],
    doseBasis: { amount: 6250, unit: 'IU' },
    maxDoseQuantity: 2,
  },
  {
    id: 'medication-surgical-lidocaine',
    version: 1,
    code: 'SURGICAL-LIDOCAINE',
    display: '盐酸利多卡因注射液',
    unit: 'mL',
    priceFen: 120,
    strength: '100 mg',
    packageDescription: '5mL:100mg×5支/盒',
    defaultRouteCode: 'IH' as const,
    allowedRouteCodes: ['IH' as const, 'IM' as const, 'IV' as const],
    doses: [
      { doseText: '5 mL', quantity: 5 },
      { doseText: '100 mg', quantity: 5 },
    ],
    doseBasis: { amount: 20, unit: 'mg' },
    maxDoseQuantity: 20,
    packageInsert: {
      disclaimer: SYNTHETIC_PACKAGE_INSERT_DISCLAIMER,
      genericName: '盐酸利多卡因注射液',
      specificationAndForm: '注射剂 · 5mL:100mg（20 mg/mL） · 5支/盒',
      indicationsSummary: '介入血管穿刺局部浸润麻醉。',
      dosageAndAdministration: '皮下局部浸润常规单次 5 mL（100 mg）。',
      contraindications: '对酰胺类局麻药过敏禁用。',
      precautions: '推注前必须回抽无回血。',
      adverseReactions: '偶见头晕、口唇麻木。',
    },
  },
]

const catalog = inpatientSurgeryCatalogSchema.parse({
  procedures: [angioProc, appendectomyProc],
  materials: [],
  locations: [],
  practitioners: [],
  baseStockMedications,
  medicationPackages: buildSurgicalMedicationPackages(baseStockMedications),
  nursingBindings: [
    {
      serviceId: 'hospital-service-intraoperative-interventional-nursing',
      serviceVersion: 1,
      display: '术中介入专科护理',
      unit: '次',
      priceFen: 8000,
      procedureIds: ['hospital-surgery-7'],
    },
  ],
})

const readyRequest = inpatientSurgeryRequestSchema.parse({
  id: 'request-angio',
  admissionId: admission.id,
  version: 3,
  status: 'ready',
  plannedProcedure: angioProc,
  plannedFor: '2026-11-24T10:00:00+08:00',
  preopOrderPolicy: 'continue-active',
  reason: '合成冠脉造影准备',
  requestedAt: '2026-11-24T08:00:00+08:00',
  requestedBy: 'inpatient-doctor',
  organizationId: 'org-1',
})

it('整台补录支持一键套用台内用药套餐、查看说明书、校验整数换算并免填常规备注提交', async () => {
  const doctorSession = makeSession('inpatient-doctor')
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/auth/context') return Response.json(doctorSession)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        posts.push({ path, body })
        return Response.json({
          auditId: 'audit-1',
          requestId: 'receipt-1',
          effects: [],
          warnings: [],
          data: {
            admissionId: admission.id,
            encounterVersion: '2',
            virtualTime: '2026-11-24T10:00:00+08:00',
            requests: [{ ...readyRequest, status: 'completed', version: 4 }],
            executions: [],
            inProgress: [],
          },
        })
      }
      throw new Error(`Unexpected fetch ${path}`)
    }),
  )

  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(doctorSession, () => undefined)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    return (
      <SurgeryExecuteComposer
        admission={admission}
        session={doctorSession}
        request={readyRequest}
        catalog={catalog}
        reservations={[]}
        dataReady
        onRetry={() => undefined}
        locale="zh-CN"
        write={write}
        open
        focused
        onOpenChange={() => undefined}
        returnFocus={triggerRef}
      />
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()

  expect(screen.getByText(/术中介入专科护理/)).toBeDefined()
  await user.click(screen.getByRole('button', { name: /冠脉造影\/PCI 对比剂与抗凝套餐/ }))
  expect(screen.getByLabelText('碘海醇注射液剂量')).toBeDefined()
  expect(screen.getByLabelText('肝素钠注射液剂量')).toBeDefined()

  // 添加盐酸利多卡因并查看合成说明书摘要
  screen.getByLabelText('选择台内基数药').focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: /盐酸利多卡因注射液/ }))
  await user.click(screen.getByRole('button', { name: '添加台内药' }))

  const doseInput = screen.getByLabelText<HTMLInputElement>('盐酸利多卡因注射液剂量')
  await user.clear(doseInput)
  await user.type(doseInput, '30 mg')
  expect(screen.getByRole('button', { name: '记录实际手术' }).hasAttribute('disabled')).toBe(true)

  await user.clear(doseInput)
  await user.type(doseInput, '100 mg')
  expect(screen.getByRole('button', { name: '记录实际手术' }).hasAttribute('disabled')).toBe(false)

  await user.click(screen.getByRole('button', { name: '查看盐酸利多卡因注射液说明书' }))
  expect((await screen.findByText('药品说明书摘要')).textContent).toContain('药品说明书摘要')
  expect(screen.getByText(SYNTHETIC_PACKAGE_INSERT_DISCLAIMER)).toBeDefined()
  await user.keyboard('{Escape}')

  // 无需填写常规备注即可提交整台补录
  expect(screen.queryByLabelText('补录依据')).toBeNull()
  await user.click(screen.getByRole('button', { name: '记录实际手术' }))

  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({
    path: `/api/his/v1/inpatient/admissions/${admission.id}/surgeries/execute`,
    body: {
      input: {
        requestId: readyRequest.id,
        expectedRequestVersion: readyRequest.version,
        procedureId: 'hospital-surgery-7',
        catalogVersion: 1,
        materials: [],
        medications: [
          { medicationId: 'medication-pci-iohexol', catalogVersion: 1, doseText: '50 mL', quantity: 50, routeCode: 'IV' },
          { medicationId: 'medication-pci-heparin', catalogVersion: 1, doseText: '1 mL', quantity: 1, routeCode: 'IV' },
          {
            medicationId: 'medication-surgical-lidocaine',
            catalogVersion: 1,
            doseText: '100 mg',
            quantity: 5,
            routeCode: 'IH',
          },
        ],
      },
    },
  })
})

it('分步术中登记台内基数药、完术预览展示联动护理费，且医生/护士/病案三岗位只读查看一致', async () => {
  const doctorSession = makeSession('inpatient-doctor')
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/auth/context') return Response.json(doctorSession)
      if (path.endsWith('/drg/agent')) {
        return Response.json({
          admissionId: admission.id,
          taskId: null,
          status: 'inactive',
          basisFingerprint: null,
          stage: null,
          missing: [],
          failureCode: null,
          costs: null,
          usage: [],
          analysis: null,
          confirmedPlan: null,
          planHistory: [],
        })
      }
      if (path.endsWith('/material-estimates')) {
        return Response.json({ admissionId: admission.id, estimates: [] })
      }
      if (path.endsWith('/surgeries/preview-completion')) {
        return Response.json({
          fingerprint: 'f'.repeat(64),
          materials: [],
          retainedReservations: [],
          materialDeltaFen: 0,
          procedureAmountFen: 80000,
          nursingAmountFen: 8000,
          linkedNursing: {
            serviceId: 'hospital-service-intraoperative-interventional-nursing',
            serviceVersion: 1,
            display: '术中介入专科护理',
            unit: '次',
            amountFen: 8000,
          },
          totalDeltaFen: 88000,
          preopOrderPolicy: 'continue-active',
          autoStopPreopOrders: [],
        })
      }
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) })
        return Response.json({
          auditId: 'audit-med',
          requestId: 'receipt-med',
          effects: [],
          warnings: [],
          data: {
            admissionId: admission.id,
            encounterVersion: '2',
            virtualTime: '2026-11-24T10:05:00+08:00',
            requests: [{ ...readyRequest, version: 4 }],
            executions: [],
            inProgress: [],
          },
        })
      }
      throw new Error(`Unexpected fetch ${path}`)
    }),
  )

  const runningExecution = inpatientSurgeryExecutionSchema.parse({
    id: 'exec-running',
    admissionId: admission.id,
    requestId: readyRequest.id,
    actualProcedure: angioProc,
    performedAt: '2026-11-24T10:00:00+08:00',
    performedBy: 'inpatient-doctor',
    practitionerRoleId: 'role-inpatient-doctor',
    organizationId: 'org-1',
    note: '按计划开始手术',
    materials: [],
    materialHistory: [],
  })

  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  clients.push(client)
  function RunningHarness() {
    const write = useInpatientWriteIntent(doctorSession, () => undefined)
    return (
      <InpatientActionProvider stage="surgery">
        <InpatientSurgeryMaterials
          admission={admission}
          session={doctorSession}
          locale="zh-CN"
          write={write}
          execution={runningExecution}
          request={readyRequest}
          catalog={catalog}
          reservations={[]}
          dataReady
          running
          refresh={() => Promise.resolve()}
        />
        <InpatientActionOutlet />
      </InpatientActionProvider>
    )
  }
  render(
    <QueryClientProvider client={client}>
      <RunningHarness />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: '带入：碘海醇注射液 50 mL' }))
  await user.click(screen.getByRole('button', { name: '登记台内药' }))
  await waitFor(() =>
    expect(posts).toContainEqual({
      path: `/api/his/v1/inpatient/admissions/${admission.id}/surgeries/record-medication`,
      body: {
        input: {
          requestId: readyRequest.id,
          expectedRequestVersion: readyRequest.version,
          executionId: runningExecution.id,
          medication: {
            medicationId: 'medication-pci-iohexol',
            catalogVersion: 1,
            doseText: '50 mL',
            quantity: 50,
            routeCode: 'IV',
          },
        },
      },
    }),
  )

  // 打开完术核实窗口，验证联动护理费展示
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '核实最终耗材并完成手术' }).hasAttribute('disabled')).toBe(false),
  )
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  expect(await screen.findByText(/术中专科护理/)).toBeDefined()
  expect(screen.getByText(/术中介入专科护理/)).toBeDefined()
  expect(screen.getByText('¥880.00')).toBeDefined()
  cleanup()

  // 三岗位只读查看已完成手术的台内用药与术中专科护理
  const completedExecution = inpatientSurgeryExecutionSchema.parse({
    ...runningExecution,
    completedAt: '2026-11-24T10:30:00+08:00',
    medications: [
      {
        id: 'med-use-1',
        administrationId: 'admin-1',
        medicationId: 'medication-pci-iohexol',
        catalogVersion: 1,
        display: '碘海醇注射液',
        doseText: '50 mL',
        quantity: 50,
        unit: 'mL',
        routeCode: 'IV',
        priceFen: 150,
        amountFen: 7500,
        recordedAt: '2026-11-24T10:05:00+08:00',
        recordedBy: 'inpatient-doctor',
        practitionerRoleId: 'role-inpatient-doctor',
        note: '按本台手术台内基数用药登记',
        chargeId: 'charge-med-1',
      },
    ],
    linkedNursing: {
      serviceId: 'hospital-service-intraoperative-interventional-nursing',
      serviceVersion: 1,
      display: '术中介入专科护理',
      unit: '次',
      amountFen: 8000,
      chargeId: 'charge-nursing-1',
    },
  })

  for (const role of ['inpatient-doctor', 'ward-nurse', 'medical-records'] as const) {
    const roleSession = makeSession(role)
    const roleClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    clients.push(roleClient)
    function ReadOnlyHarness() {
      const write = useInpatientWriteIntent(roleSession, () => undefined)
      return (
        <InpatientSurgeryMaterials
          admission={admission}
          session={roleSession}
          locale="zh-CN"
          write={write}
          execution={completedExecution}
          request={{ ...readyRequest, status: 'completed' }}
          catalog={catalog}
          reservations={[]}
          dataReady
          running={false}
          inDialog
          refresh={() => Promise.resolve()}
        />
      )
    }
    render(
      <QueryClientProvider client={roleClient}>
        <ReadOnlyHarness />
      </QueryClientProvider>,
    )
    expect(screen.getByText('碘海醇注射液')).toBeDefined()
    expect(screen.getAllByText('¥75.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/术中介入专科护理/)).toBeDefined()
    expect(screen.getByText('¥80.00')).toBeDefined()
    cleanup()
  }
})

it('套餐含未安装品规时显示不可用原因且不阻断其余可用项，并在过敏红线拦截时展示质控红线摘要', async () => {
  const doctorSession = makeSession('inpatient-doctor')
  const withoutIohexol = baseStockMedications.filter(item => item.id !== 'medication-pci-iohexol')
  const partialCatalog = inpatientSurgeryCatalogSchema.parse({
    ...catalog,
    baseStockMedications: withoutIohexol,
    medicationPackages: buildSurgicalMedicationPackages(withoutIohexol),
  })
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/auth/context') return Response.json(doctorSession)
      if (path.endsWith('/drg/agent')) {
        return Response.json({
          admissionId: admission.id,
          taskId: null,
          status: 'inactive',
          basisFingerprint: null,
          stage: null,
          missing: [],
          failureCode: null,
          costs: null,
          usage: [],
          analysis: null,
          confirmedPlan: null,
          planHistory: [],
        })
      }
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) })
        return new Response(
          JSON.stringify({
            error: {
              code: 'CATALOG_CONFLICT',
              reason: 'MEDICATION_ALLERGY_CONFLICT',
              message: '药品与已确认的有效药物过敏冲突',
              correlationId: crypto.randomUUID(),
              clinicalQuality: {
                gate: 'inpatient-order',
                evaluatedAt: '2026-11-24T10:00:00+08:00',
                status: 'blocked',
                redLines: [
                  {
                    code: 'MEDICATION_ALLERGY_CONFLICT',
                    tier: 'red-line',
                    catalogItemId: 'medication-pci-heparin',
                    message: '患者对肝素钠注射液存在已确认有效药物过敏，严禁给药。',
                    evidence: [],
                  },
                ],
                alerts: [],
              },
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`Unexpected fetch ${path}`)
    }),
  )

  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(doctorSession, () => undefined)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    return (
      <SurgeryExecuteComposer
        admission={admission}
        session={doctorSession}
        request={readyRequest}
        catalog={partialCatalog}
        reservations={[]}
        dataReady
        onRetry={() => undefined}
        locale="zh-CN"
        write={write}
        open
        focused
        onOpenChange={() => undefined}
        returnFocus={triggerRef}
      />
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()

  expect(screen.getByText('未安装：碘海醇注射液')).toBeDefined()
  await user.click(screen.getByRole('button', { name: /套用套餐：冠脉造影\/PCI 对比剂与抗凝套餐/ }))
  expect(screen.queryByLabelText('碘海醇注射液剂量')).toBeNull()
  expect(screen.getByLabelText('肝素钠注射液剂量')).toBeDefined()

  await user.click(screen.getByRole('button', { name: '记录实际手术' }))
  expect(await screen.findByText('药事安全红线拦截（不可越权）')).toBeDefined()
  expect(screen.getByText(/患者对肝素钠注射液存在已确认有效药物过敏/)).toBeDefined()
  expect(posts).toHaveLength(1)
})
