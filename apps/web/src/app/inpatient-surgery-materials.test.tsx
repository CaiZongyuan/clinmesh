// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryMaterials } from './inpatient-surgery-materials.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const charge = { id: 'charge-1', priceFen: 10000, unit: '根', synthetic: true, trigger: 'execution' }
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0600', display: 'PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...charge, unit: '次' } }
const request = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 1, status: 'completed', plannedProcedure: procedure, plannedFor: '2026-11-03T00:00:00Z', reason: '合成计划', requestedAt: '2026-11-03T00:00:00Z', requestedBy: 'doctor', organizationId: 'org-1' })
const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: admission.id, requestId: request.id, actualProcedure: procedure, performedAt: '2026-11-03T00:00:00Z', performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术', materials: [{ id: 'use-1', item: { id: 'wire', version: 1, display: '导丝', chargeDefinition: charge }, quantity: 2, amountFen: 20000 }], materialHistory: [{ id: 'use-1', item: { id: 'wire', version: 1, display: '导丝', chargeDefinition: charge }, quantity: 2, amountFen: 20000, recordedAt: '2026-11-03T00:00:00Z', recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '初次记录', reservationId: null, chargeId: 'charge-1', correction: null }] })
const usage = { requestId: request.id, executionId: execution.id, procedureDisplay: 'PCI', materialId: 'wire', catalogVersion: 1, display: '导丝', unit: '根', plannedQuantity: 1, actualQuantity: 2, remainingQuantity: 0, unplanned: false, excessQuantity: 1, usedFen: 20000, additionalFen: 10000 }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mountCorrections(history = execution.materialHistory) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={{ ...execution, materialHistory: history }} request={request} catalog={{ procedures: [request.plannedProcedure], materials: [history[0]!.item] }} reservations={[]} dataReady running={false} inDialog refresh={() => Promise.resolve()} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return userEvent.setup()
}

it('共同依据与逐项覆盖可核对，清空选择保留人工输入，清空输入另行确认', async () => {
  const second = { ...execution.materialHistory[0]!, id: 'use-2', quantity: 1, note: '另一笔原用量' }
  const user = mountCorrections([...execution.materialHistory, second])
  await user.click(screen.getByRole('button', { name: '更正 导丝 × 2' }))
  await user.click(screen.getByRole('button', { name: '更正 导丝 × 1' }))
  await user.type(screen.getByRole('textbox', { name: '共同更正依据' }), '合成共同更正依据')
  await user.type(screen.getByRole('textbox', { name: '逐项更正依据 导丝 × 1' }), '第二笔单独核实')
  await user.click(screen.getByRole('button', { name: '清空选择' }))
  expect(screen.getByRole('region', { name: '待更正清单' }).textContent).toContain('已选 0')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '共同更正依据' }).value).toBe('合成共同更正依据')
  await user.click(screen.getByRole('checkbox', { name: '选择更正 导丝 × 2' }))
  await user.click(screen.getByRole('checkbox', { name: '选择更正 导丝 × 1' }))
  await user.click(screen.getByRole('button', { name: '集中核对更正' }))
  const preview = screen.getByRole('region', { name: '更正核对清单' })
  expect(preview.textContent).toContain('导丝 × 2 → 撤销这笔，不替换 · 最终依据：合成共同更正依据')
  expect(preview.textContent).toContain('导丝 × 1 → 撤销这笔，不替换 · 最终依据：第二笔单独核实')
  await user.click(screen.getByRole('button', { name: '返回编辑' }))
  await user.click(screen.getByRole('button', { name: '清空更正输入' }))
  expect(screen.getByRole('alertdialog', { name: '丢弃未提交更正输入？' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '保留输入' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '逐项更正依据 导丝 × 1' }).value).toBe('第二笔单独核实')
  await user.click(screen.getByRole('button', { name: '清空更正输入' }))
  await user.click(screen.getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('textbox', { name: '共同更正依据' })).toBeNull()
})

it('当前页全选只加入可见原笔，跨页保留完整清单，超过20项明确阻止', async () => {
  const history = Array.from({ length: 21 }, (_, index) => ({ ...execution.materialHistory[0]!, id: `use-${index}`, quantity: index + 1, note: `合成原用量${index + 1}` }))
  const user = mountCorrections(history)
  await user.click(screen.getByRole('button', { name: '全选当前页可更正记录' }))
  expect(screen.getByRole('region', { name: '待更正清单' }).textContent).toContain('10/20')
  expect(screen.queryByRole('article', { name: '导丝 × 11' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(screen.getByRole('button', { name: '全选当前页可更正记录' }))
  expect(screen.getByRole('region', { name: '待更正清单' }).textContent).toContain('20/20')
  expect(screen.getByRole('article', { name: '导丝 × 1' })).toBeDefined()
  expect(screen.getByRole('article', { name: '导丝 × 20' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(screen.getByRole('button', { name: '全选当前页可更正记录' }))
  expect(screen.getByRole('alert').textContent).toContain('每次最多20笔')
  expect(screen.queryByRole('article', { name: '导丝 × 21' })).toBeNull()
  await user.type(screen.getByRole('textbox', { name: '搜索原耗材记录' }), '合成原用量21')
  expect(screen.getByRole('region', { name: '待更正清单' }).textContent).toContain('已选 20')
})

it('任何选中行的数量缺失阻止集中核对，改数量仍需明确选择预留', async () => {
  const user = mountCorrections()
  await user.click(screen.getByRole('button', { name: '更正 导丝 × 2' }))
  screen.getByRole('combobox', { name: '更正方式 导丝 × 2' }).focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '改数量' }))
  await user.type(screen.getByRole('textbox', { name: '共同更正依据' }), '重新核实实际数量')
  await user.clear(screen.getByRole('spinbutton', { name: '更正后数量 导丝 × 2' }))
  expect(screen.getByRole('button', { name: '集中核对更正' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: '替换预留 导丝 × 2' }).textContent).toContain('额外使用，不消耗预留')
  await user.type(screen.getByRole('spinbutton', { name: '更正后数量 导丝 × 2' }), '1')
  expect(screen.getByRole('button', { name: '集中核对更正' }).hasAttribute('disabled')).toBe(false)
})

it('同台两笔既有用量可连续准备更正且保留各自输入', async () => {
  const second = { ...execution.materialHistory[0]!, id: 'use-2', item: { ...execution.materialHistory[0]!.item, id: 'balloon', display: '球囊' }, quantity: 1, note: '球囊原登记' }
  const currentExecution = { ...execution, materialHistory: [...execution.materialHistory, second] }
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={currentExecution} request={request} catalog={{ procedures: [request.plannedProcedure], materials: [execution.materialHistory[0]!.item, second.item] }} reservations={[]} dataReady running={false} inDialog refresh={() => Promise.resolve()} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '更正 导丝 × 2' }))
  await user.type(screen.getByRole('textbox', { name: '逐项更正依据 导丝 × 2' }), '导丝误记')
  await user.click(screen.getByRole('button', { name: '更正 球囊 × 1' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '逐项更正依据 导丝 × 2' }).value).toBe('导丝误记')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '逐项更正依据 球囊 × 1' }).value).toBe('')
  expect(screen.getByRole('region', { name: '待更正清单' }).textContent).toContain('2/20')
})

it('实际更正命令成功后同一登记区刷新规则费用板，不产生模型命令', async () => {
  let current = usage
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent')) return Response.json({ admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: null, missing: [], failureCode: null, costs: null, usage: [current], analysis: null, confirmedPlan: null, planHistory: [] })
    if (path.endsWith('/drg/record-checks')) return Response.json({ admissionId: admission.id, admissionVersion: '1', encounterVersion: '1', fingerprint: 'a'.repeat(64), status: 'complete', simulation: null, issues: [], sources: [], paymentStatus: 'grouping-incomplete', paymentMessage: '分组尚未完成', missing: [] })
    if (init?.method === 'POST') {
      posts.push(path)
      expect(JSON.parse(String(init.body)).input).toMatchObject({ executionId: execution.id, materialUseId: 'use-1', note: '更正误记的导丝用量' })
      current = { ...usage, actualQuantity: 0, remainingQuantity: 1, excessQuantity: 0, usedFen: 0, additionalFen: 0 }
      return Response.json({ data: { admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T00:00:00Z', requests: [request], executions: [{ ...execution, materials: [], materialHistory: [] }], inProgress: [] }, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness({ currentExecution }: { currentExecution: typeof execution }) {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={currentExecution} request={request} catalog={undefined} reservations={[]} dataReady={false} running refresh={() => Promise.resolve()} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  const view = render(<QueryClientProvider client={client}><Harness currentExecution={execution} /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: '本台耗材' })
  const row = await within(panel).findByRole('row', { name: /导丝/ })
  expect(panel.textContent).toContain('已登记耗材 ¥200.00')
  expect(panel.textContent).toContain('术式费 ¥100.00 在完成手术时计入')
  const user = userEvent.setup()
  await user.click(within(row).getByRole('button', { name: /更正/ }))
  await user.type(screen.getByRole('textbox', { name: '逐项更正依据 导丝 × 2' }), '更正误记的导丝用量')
  await user.click(screen.getByRole('button', { name: '集中核对更正' }))
  await user.click(screen.getByRole('button', { name: '确认更正' }))
  await waitFor(() => expect(posts).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/surgeries/correct-material`]))
  view.rerender(<QueryClientProvider client={client}><Harness currentExecution={{ ...execution, materials: [], materialHistory: [] }} /></QueryClientProvider>)
  expect(panel.textContent).toContain('已登记耗材 ¥0.00')
})

it('术中从耗材行一键登记计划用量，说明带出原计划依据', async () => {
  const posts: Array<{ path: string; input: unknown }> = []
  const empty = { ...execution, materials: [], materialHistory: [] }
  const activeRequest = { ...request, status: 'ready' as const }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent')) return Response.json({ admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: null, missing: [], failureCode: null,
      costs: null, usage: [], analysis: null, confirmedPlan: null, planHistory: [], intraoperativePlans: [{ requestId: request.id, reference: 'InpatientMaterialPlan/plan-1', items: [
        { materialId: 'wire', catalogVersion: 1, display: '导丝', unit: '根', quantity: 1, unitPriceFen: 10000, estimatedFen: 10000,
          quantityBasis: '原计划一根导丝用于通过病变', reason: '医生已核实', evidenceIds: ['evidence-wire'] },
      ] }] })
    if (init?.method === 'POST') {
      posts.push({ path, input: JSON.parse(String(init.body)).input })
      return Response.json({ data: { admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T00:00:00Z', requests: [activeRequest], executions: [], inProgress: [empty] }, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => Promise.resolve())
    return <InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={empty} request={activeRequest}
      catalog={{ procedures: [procedure], materials: [execution.materialHistory[0]!.item] }} reservations={[{ id: 'reservation-1', admissionId: admission.id, requestId: request.id,
        materialId: 'wire', materialDisplay: '导丝', unit: '根', specification: null, quantity: 1, catalogVersion: 1, consumedQuantity: 0, remainingQuantity: 1, version: 3,
        priceFen: 10000, status: 'reserved', reason: '原计划预留', createdAt: '2026-11-03T00:00:00Z' }]} dataReady running refresh={() => Promise.resolve()} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await screen.findByText('原计划一根导丝用于通过病变')
  await userEvent.setup().click(screen.getByRole('button', { name: '用 1 根 导丝' }))
  await waitFor(() => expect(posts).toEqual([{ path: `/api/his/v1/inpatient/admissions/${admission.id}/surgeries/record-material`, input: {
    requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id, note: '按计划 · 原计划一根导丝用于通过病变',
    material: { materialId: 'wire', catalogVersion: 1, quantity: 1, reservationId: 'reservation-1', expectedReservationVersion: 3 },
  } }]))
})

it.each([
  ['queued', '助手正在核对这笔计划外使用…'],
  ['succeeded', '本笔用于分支保护，已超出原计划；后续用量仍需按原计划核实。'],
  ['failed', '助手未能说明'],
] as const)('偏离行先显示确定性金额，助手%s不阻断完成与原因登记', async (status, message) => {
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent')) return Response.json({ admissionId: admission.id, taskId: 'followup-1', status: 'stale', basisFingerprint: 'a'.repeat(64), stage: 'intraoperative', missing: [], failureCode: null,
      costs: { fingerprint: 'c'.repeat(64), components: { formalChargesFen: 20000, pendingOrdersFen: 20000, remainingMaterialsFen: 0, plannedSurgeryFen: 10000, projectedTotalFen: 50000 },
        currentGrouping: null, projectedGrouping: null, currentPaymentReference: { parameterSetId: 'synthetic-payment', parameterVersion: '1', drgCode: 'SYN', referenceFen: 100000, note: '合成参考' },
        projectedPaymentReference: null, currentDifferenceFen: 50000, projectedDifferenceFen: null, paymentStatus: 'available', paymentMessage: '合成参考', exceptionAlert: 'below-threshold' },
      usage: [usage], analysis: null, confirmedPlan: null, planHistory: [], intraoperativePlans: [{ requestId: request.id, reference: 'InpatientMaterialPlan/plan-1', items: [
        { materialId: 'wire', catalogVersion: 1, display: '导丝', unit: '根', quantity: 1, unitPriceFen: 10000, estimatedFen: 10000, quantityBasis: '医生确认原计划一根', reason: '已核实', evidenceIds: ['evidence-wire'] },
      ] }], intraoperativeReviews: [{ materialUseId: 'use-1', executionId: execution.id, requestId: request.id, taskId: 'review-1', reasons: ['excess'], status,
        explanation: status === 'succeeded' ? message : null, costExplanation: null, failureCode: status === 'failed' ? 'INPATIENT_DRG_AGENT_FAILED' : null }] })
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)).input)
      return Response.json({ data: { admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T00:00:00Z', requests: [request], executions: [], inProgress: [execution] }, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => Promise.resolve())
    return <InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={execution} request={{ ...request, status: 'ready' }}
      catalog={{ procedures: [procedure], materials: [execution.materialHistory[0]!.item] }} reservations={[]} dataReady running refresh={() => Promise.resolve()} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await screen.findByText(message)
  expect(screen.getByText('本笔金额 ¥200.00')).toBeDefined()
  expect(screen.getByText('做完预计总费用 ¥500.00')).toBeDefined()
  expect(screen.getByText('离支付参考还剩 ¥500.00')).toBeDefined()
  expect(screen.getByRole('button', { name: '核实最终耗材并完成手术' }).hasAttribute('disabled')).toBe(false)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '再用 1 根 导丝' }))
  expect(screen.getByRole('button', { name: '登记这笔' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '分支保护' }))
  const reason = screen.getByRole<HTMLInputElement>('textbox', { name: '计划外再用 1 根，说明原因' })
  expect(reason.value).toBe('分支保护')
  await user.type(reason, '，术者已核实')
  await user.click(screen.getByRole('button', { name: '登记这笔' }))
  await waitFor(() => expect(posts).toEqual([{ requestId: request.id, expectedRequestVersion: request.version, executionId: execution.id,
    note: '分支保护，术者已核实', material: { materialId: 'wire', catalogVersion: 1, quantity: 1 } }]))
})
