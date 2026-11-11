// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryDetails } from './inpatient-surgery-details.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const time = '2026-11-03T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '51.2300', display: '腹腔镜下胆囊切除术', category: '手术', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const materials = ['合成钛夹', '合成缝线'].map((display, index) => ({ id: `material-${index + 1}`, version: 1, display, chargeDefinition: { id: `material-price-${index + 1}`, priceFen: 2000, unit: '枚', synthetic: true, trigger: 'execution' } }))
const plan = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 3, status: 'requested', plannedProcedure: procedure, plannedFor: time, reason: '合成计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1' })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

type Post = { path: string; key: string | null; body: { input: Record<string, unknown> } }
function mount(options: { locale?: WorkspaceLocale; materials?: typeof materials; reservations?: () => InpatientMaterialReservation[]; get?: (path: string) => Response | undefined; post?: (post: Post, count: number) => Response | Promise<Response> } = {}) {
  const posts: Post[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (init?.method === 'POST') {
      const post = { path, key: new Headers(init.headers).get('idempotency-key'), body: JSON.parse(String(init.body)) }
      posts.push(post)
      return options.post?.(post, posts.length) ?? Response.json({ auditId: `audit-${posts.length}`, requestId: `receipt-${posts.length}`, effects: [], warnings: [], data: { admissionId: admission.id, encounterVersion: '1', reservations: options.reservations?.() ?? [], reservationSets: [] } })
    }
    const custom = options.get?.(path)
    if (custom) return custom
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [plan], executions: [], inProgress: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: options.materials ?? materials })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: options.reservations?.() ?? [], reservationSets: [] })
    throw new Error(`Unexpected ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => undefined)
    const locale = options.locale ?? 'zh-CN'
    return <><InpatientWriteRecovery write={write} locale={locale} /><InpatientSurgeryDetails admission={admission} session={session} locale={locale} write={write} plan={plan} estimate={undefined} selection={undefined} onOpenUsage={undefined} /></>
  }
  return { ...render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>), client, posts }
}

async function addMaterials(user: ReturnType<typeof userEvent.setup>, displays = materials.map(item => item.display)) {
  await user.click(await screen.findByRole('button', { name: '添加预留耗材' }))
  const picker = screen.getByRole('dialog', { name: '选择预留耗材' })
  for (const display of displays) await user.click(within(picker).getByRole('button', { name: `加入${display}` }))
  await user.click(within(picker).getByRole('button', { name: '完成选择' }))
}

it('坏稿只在同键成功回执证明计划归属且明确确认后丢弃，另一手术坏稿仍保留', async () => {
  const row = inpatientMaterialReservationSchema.parse({ id: 'reservation-original', admissionId: admission.id, requestId: plan.id,
    materialId: materials[0]!.id, materialDisplay: materials[0]!.display, quantity: 3, consumedQuantity: 1, version: 2,
    priceFen: 2000, status: 'reserved', reason: '合成新增理由', createdAt: time })
  const reason = '只释放核对后的余量', receiptKeys: string[] = []
  let receiptAvailable = true
  const options = {
    reservations: () => [row],
    post: () => { throw new TypeError('合成响应丢失') },
    get: (path: string) => {
      if (!path.includes('/command-receipts?')) return undefined
      const idempotencyKey = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!
      receiptKeys.push(idempotencyKey)
      if (!receiptAvailable) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执暂不可见' } }, { status: 404 })
      return Response.json({ operationId: 'inpatient.drg.reservation.release', idempotencyKey, status: 'completed', response: {
        auditId: 'audit-original', requestId: 'receipt-original', warnings: [],
        effects: [{ kind: 'updated', reference: 'InpatientMaterialReservation/reservation-original', versionId: '3' }],
        data: { admissionId: admission.id, encounterVersion: '1', reservations: [{ ...row, status: 'released', version: 3, releaseReason: reason, remainingQuantity: 0 }] },
      } })
    },
  }
  const user = userEvent.setup(), original = mount(options)
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const release = within(screen.getByRole('region', { name: '释放预留' }))
  await user.type(await release.findByRole('textbox', { name: '释放预留共同理由' }), reason)
  await user.click(await release.findByRole('checkbox', { name: /选择合成钛夹/ }))
  await user.click(release.getByRole('button', { name: '审阅释放预留' }))
  await user.click(screen.getByRole('button', { name: '确认释放所选预留' }))
  await screen.findByRole('button', { name: '核查并恢复原预留请求' })
  original.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
  const otherKey = key.replace('request-1', 'request-other')
  sessionStorage.setItem(key, '{broken-original')
  sessionStorage.setItem(otherKey, '{broken-other')
  const recovery = mount(options)
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  receiptAvailable = false
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await waitFor(() => expect(receiptKeys).toHaveLength(2))
  expect(sessionStorage.getItem(key)).toBe('{broken-original')
  receiptAvailable = true
  await user.click(await screen.findByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull())
  expect(sessionStorage.getItem(otherKey)).toBe('{broken-other')
  expect(recovery.posts).toHaveLength(0)
  expect(receiptKeys).toEqual(Array(4).fill(original.posts[0]!.key))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原住院操作' })).toBeNull())
})

it.each([
  [409, 'INPATIENT_RESERVATION_CONFLICT', 'RESERVATION_REMAINDER_CHANGED', 'The reservation changed. Review the current remaining quantity before releasing it.'],
  [409, 'INPATIENT_RESERVATION_CONFLICT', 'RESERVATION_NOT_RELEASABLE', 'This item is no longer reserved and cannot be released. Review its current status.'],
  [404, 'INPATIENT_RESERVATION_NOT_FOUND', undefined, 'This reservation was not found in the current admission. Refresh the list and review the item.'],
] as const)('英文逐项释放失败说明可采取的动作并保留输入：%s %s %s', async (status, code, reason, copy) => {
  const row = inpatientMaterialReservationSchema.parse({ id: 'reservation-original', admissionId: admission.id, requestId: plan.id,
    materialId: materials[0]!.id, materialDisplay: materials[0]!.display, quantity: 3, consumedQuantity: 1, version: 2,
    priceFen: 2000, status: 'reserved', reason: '合成新增理由', createdAt: time })
  const user = userEvent.setup(), input = 'Reviewed unused quantity'
  const { posts } = mount({ locale: 'en-US', reservations: () => [row], post: () => Response.json({
    error: { code, reason, message: '合成拒绝原因' },
  }, { status }) })
  await user.click(screen.getByRole('button', { name: 'Manual reservations' }))
  const release = within(screen.getByRole('region', { name: 'Release reservations' }))
  await user.type(await release.findByRole('textbox', { name: 'Common release reason' }), input)
  await user.click(await release.findByRole('checkbox', { name: `Select ${row.materialDisplay}` }))
  await user.click(release.getByRole('button', { name: 'Review release' }))
  await user.click(screen.getByRole('button', { name: 'Confirm selected releases' }))
  const result = within(await screen.findByRole('region', { name: 'Release reservations item results' }))
  await result.findByText(copy)
  expect(result.queryByText('合成拒绝原因')).toBeNull()
  expect(result.getByText(`Reason reviewed for this attempt: ${input}`)).toBeTruthy()
  expect(release.getByRole<HTMLInputElement>('textbox', { name: 'Common release reason' }).value).toBe(input)
  expect(posts).toHaveLength(1)
})

it('未提交坏稿重读仍失败时保留原文，必须确认丢弃才能编辑', async () => {
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user)
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '合成待办')
  view.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
  sessionStorage.setItem(key, '{unreadable-draft')
  mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const create = within(screen.getByRole('region', { name: '新增预留' }))
  const reason = create.getByRole('textbox', { name: '新增预留共同理由' })
  expect(reason.matches(':disabled')).toBe(true)
  await user.click(create.getByRole('button', { name: '重试读取预留清单' }))
  expect(sessionStorage.getItem(key)).toBe('{unreadable-draft')
  await user.click(create.getByRole('button', { name: '丢弃不可读预留清单' }))
  const confirm = within(screen.getByRole('alertdialog', { name: '清空未提交输入？' }))
  await user.click(confirm.getByRole('button', { name: '确认清空输入' }))
  await waitFor(() => expect(reason.matches(':disabled')).toBe(false))
  expect(sessionStorage.getItem(key)).toBeNull()
})

it('固定当前手术同窗连续加入两种预留，关闭与重新挂载保留数量和逐项理由', async () => {
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  await user.click(await screen.findByRole('button', { name: '添加预留耗材' }))
  const picker = screen.getByRole('dialog', { name: '选择预留耗材' })
  await user.click(within(picker).getByRole('button', { name: '加入合成钛夹' }))
  await user.click(within(picker).getByRole('button', { name: '加入合成缝线' }))
  expect(picker.textContent).toContain('已加入 2 / 20 项')
  await user.click(within(picker).getByRole('button', { name: '完成选择' }))
  const first = screen.getByRole('spinbutton', { name: '预留数量 合成钛夹' })
  await user.clear(first); await user.type(first, '3')
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '手术备用')
  await user.type(screen.getByRole('textbox', { name: '逐项理由 合成缝线' }), '缝合操作单独核对')
  await user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '手工预留维护' })).toBeNull())
  view.unmount(); mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '预留数量 合成钛夹' }).value).toBe('3')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '逐项理由 合成缝线' }).value).toBe('缝合操作单独核对')
  expect(screen.queryByRole('combobox', { name: '关联手术计划' })).toBeNull()
})

it('清空选择保留数量和逐项覆盖，非法数量拦截整批，移除只删除指定输入', async () => {
  const user = userEvent.setup(), { posts } = mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user)
  const create = screen.getByRole('region', { name: '新增预留' })
  await user.type(within(create).getByRole('textbox', { name: '新增预留共同理由' }), '同台备用')
  await user.type(within(create).getByRole('textbox', { name: '逐项理由 合成缝线' }), '独立缝合依据')
  const quantity = within(create).getByRole('spinbutton', { name: '预留数量 合成钛夹' })
  await user.clear(quantity); await user.type(quantity, '1001')
  expect(within(create).getByRole('button', { name: '审阅新增预留' }).hasAttribute('disabled')).toBe(true)
  await user.clear(quantity); await user.type(quantity, '4')
  await user.click(within(create).getByRole('button', { name: '清空选择' }))
  expect(within(create).getByRole<HTMLInputElement>('spinbutton', { name: '预留数量 合成钛夹' }).value).toBe('4')
  expect(within(create).getByRole<HTMLInputElement>('textbox', { name: '逐项理由 合成缝线' }).value).toBe('独立缝合依据')
  expect(screen.queryByRole('region', { name: '完整新增待办清单' })).toBeNull()
  await user.click(within(create).getByRole('button', { name: '全选本页可办理项' }))
  const selected = screen.getByRole('region', { name: '完整新增待办清单' })
  expect(selected.textContent).toContain('合成钛夹 · 数量 4 枚 · 最终理由：同台备用')
  expect(selected.textContent).toContain('合成缝线 · 数量 1 枚 · 最终理由：独立缝合依据')
  await user.click(within(create).getByRole('button', { name: '移除合成钛夹' }))
  expect(within(create).queryByRole('spinbutton', { name: '预留数量 合成钛夹' })).toBeNull()
  expect(within(create).getByRole('textbox', { name: '逐项理由 合成缝线' })).toBeDefined()
  expect(posts).toEqual([])
})

it('集中确认逐项办理且第二项明确失败保留输入，其他成功项移出原输入', async () => {
  const three = [...materials, { ...materials[0]!, id: 'material-3', display: '合成导管' }]
  const user = userEvent.setup(), { posts } = mount({ materials: three, post: (post, count) => post.body.input.materialId === 'material-2'
    ? Response.json({ error: { code: 'CATALOG_CONFLICT', message: '合成缝线目录已变化' } }, { status: 409 })
    : Response.json({ auditId: `audit-${count}`, requestId: `receipt-${count}`, effects: [], warnings: [], data: { admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] } }) })
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user, three.map(item => item.display))
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '共同手术备用')
  await user.type(screen.getByRole('textbox', { name: '逐项理由 合成缝线' }), '单独缝合用途')
  await user.click(screen.getByRole('button', { name: '审阅新增预留' }))
  const review = screen.getByRole('region', { name: '确认新增预留清单' })
  expect(review.textContent).toContain('腹腔镜下胆囊切除术')
  expect(review.textContent).toContain('单独缝合用途')
  expect(posts).toEqual([])
  await user.click(within(review).getByRole('button', { name: '确认新增所选预留' }))
  await waitFor(() => expect(posts).toHaveLength(3))
  await waitFor(() => expect(screen.getByRole('region', { name: '新增预留逐项结果' }).textContent).toContain('目录或业务规则已变化，请刷新后重新选择。'))
  expect(posts.map(post => post.body.input.materialId)).toEqual(['material-1', 'material-2', 'material-3'])
  expect(new Set(posts.map(post => post.key)).size).toBe(3)
  expect(posts[1]?.body.input.reason).toBe('单独缝合用途')
  expect(screen.queryByRole('spinbutton', { name: '预留数量 合成钛夹' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: '预留数量 合成导管' })).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '逐项理由 合成缝线' }).value).toBe('单独缝合用途')
})

it('英文逐项结果翻译目录冲突并保留未成功的输入', async () => {
  const serverMessage = '合成目录已变化'
  const user = userEvent.setup()
  const { posts } = mount({ locale: 'en-US', post: () => Response.json({ error: { code: 'CATALOG_CONFLICT', message: serverMessage } }, { status: 409 }) })
  await user.click(screen.getByRole('button', { name: 'Manual reservations' }))
  await user.click(await screen.findByRole('button', { name: 'Add reservation materials' }))
  const picker = screen.getByRole('dialog', { name: 'Choose reservation materials' })
  await user.click(within(picker).getByRole('button', { name: 'Add 合成钛夹' }))
  await user.click(within(picker).getByRole('button', { name: 'Finish selection' }))
  const reason = screen.getByRole<HTMLInputElement>('textbox', { name: 'Common creation reason' })
  await user.type(reason, 'Reviewed for surgery')
  await user.click(screen.getByRole('button', { name: 'Review creation' }))
  await user.click(screen.getByRole('button', { name: 'Confirm selected creations' }))
  const result = within(await screen.findByRole('region', { name: 'Create reservations item results' }))
  expect(await result.findByText('The catalog or workflow rules changed. Refresh and select again.')).toBeTruthy()
  expect(result.queryByText(serverMessage)).toBeNull()
  expect(reason.value).toBe('Reviewed for surgery')
  expect(posts).toHaveLength(1)
})

it('第二项结果未明时停止，恢复原回执后剩余项必须再次核对才发送', async () => {
  const three = [...materials, { ...materials[0]!, id: 'material-3', display: '合成导管' }], receiptKeys: string[] = []
  const result = { auditId: 'audit-synthetic', requestId: 'receipt-synthetic', effects: [], warnings: [], data: { admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] } }
  const user = userEvent.setup(), view = mount({ materials: three,
    post: (post) => { if (post.body.input.materialId === 'material-2') throw new TypeError('合成响应丢失'); return Response.json(result) },
    get: path => { if (!path.startsWith('/api/his/v1/command-receipts?')) return; const key = new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey')!; receiptKeys.push(key); return Response.json({ operationId: 'inpatient.drg.reservation.create', idempotencyKey: key, status: 'completed', response: result }) },
  })
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user, three.map(item => item.display))
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '合成共同依据')
  await user.click(screen.getByRole('button', { name: '审阅新增预留' })); await user.click(screen.getByRole('button', { name: '确认新增所选预留' }))
  await waitFor(() => expect(view.posts).toHaveLength(2))
  const recover = await screen.findByRole('button', { name: '核查并恢复原预留请求' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  expect(screen.queryByRole('spinbutton', { name: '预留数量 合成钛夹' })).toBeNull()
  await user.click(recover)
  const remaining = await screen.findByRole('button', { name: '核对剩余待办理项' })
  expect(view.posts).toHaveLength(2)
  expect(receiptKeys).toEqual([view.posts[1]?.key])
  expect(screen.queryByRole('spinbutton', { name: '预留数量 合成缝线' })).toBeNull()
  await user.click(remaining)
  expect(screen.getByRole('region', { name: '确认新增预留清单' }).textContent).toContain('合成导管')
  await user.click(screen.getByRole('button', { name: '确认新增所选预留' }))
  await waitFor(() => expect(view.posts).toHaveLength(3))
  expect(view.posts.map(post => post.body.input.materialId)).toEqual(['material-1', 'material-2', 'material-3'])
})

it('释放保留逐项原预留和最终理由，审阅后资料变化拦截整批并允许逐项取消旧输入', async () => {
  let reservations = materials.map((item, index) => inpatientMaterialReservationSchema.parse({ id: `reservation-${index + 1}`, admissionId: admission.id, requestId: plan.id,
    materialId: item.id, materialDisplay: item.display, unit: '枚', catalogVersion: 1, quantity: 5 + index, consumedQuantity: 2, remainingQuantity: 3 + index,
    version: 4, priceFen: 2000, status: 'reserved', reason: '原合成手术备用', createdAt: time }))
  const other = inpatientMaterialReservationSchema.parse({ ...reservations[0]!, id: 'reservation-other', requestId: 'request-other', materialDisplay: '另一手术独立预留' })
  const user = userEvent.setup(), { client, posts } = mount({ reservations: () => [...reservations, other] })
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const release = await screen.findByRole('region', { name: '释放预留' })
  await user.type(within(release).getByRole('textbox', { name: '释放预留共同理由' }), '手术方案调整释放')
  await user.type(await within(release).findByRole('textbox', { name: '逐项理由 合成缝线' }), '单项余量无需备用')
  await user.click(within(release).getByRole('button', { name: '全选本页可办理项' }))
  expect(release.textContent).not.toContain('另一手术独立预留')
  await user.click(within(release).getByRole('button', { name: '审阅释放预留' }))
  const review = screen.getByRole('region', { name: '确认释放预留清单' })
  expect(review.textContent).toContain('原量 5 · 已用 2 · 余量 3')
  expect(review.textContent).toContain('原预留理由：原合成手术备用')
  expect(review.textContent).toContain('单项余量无需备用')
  reservations = [{ ...reservations[0]!, version: 5, consumedQuantity: 3, remainingQuantity: 2 }, reservations[1]!]
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await waitFor(() => expect(within(review).getByRole('button', { name: '确认释放所选预留' }).hasAttribute('disabled')).toBe(true))
  expect(posts).toEqual([])
  await user.click(within(review).getByRole('button', { name: '取消' }))
  await user.click(within(release).getByRole('button', { name: '取消选择合成钛夹' }))
  await user.click(within(release).getByRole('checkbox', { name: '选择合成钛夹' }))
  await user.click(within(release).getByRole('button', { name: '审阅释放预留' }))
  await user.click(screen.getByRole('button', { name: '确认释放所选预留' }))
  await waitFor(() => expect(posts).toHaveLength(2))
  expect(posts.map(post => [post.path, post.body.input.expectedReservationVersion, post.body.input.reason])).toEqual(expect.arrayContaining([
    ['/api/his/v1/inpatient/admissions/admission-1/drg/reservations/reservation-1/release', 5, '手术方案调整释放'],
    ['/api/his/v1/inpatient/admissions/admission-1/drg/reservations/reservation-2/release', 4, '单项余量无需备用'],
  ]))
})

it('释放完成后回读真实逐项理由，已完成记录和结果不被当前共同输入替代', async () => {
  let reservations = ['合成支架', '合成球囊'].map((display, index) => inpatientMaterialReservationSchema.parse({ id: `reservation-${index + 1}`, admissionId: admission.id, requestId: plan.id,
    materialId: `material-${index + 1}`, materialDisplay: display, unit: '枚', quantity: 4, consumedQuantity: 1, remainingQuantity: 3,
    version: 2, priceFen: 2000, status: 'reserved', reason: '原合成手术预留', createdAt: time }))
  const user = userEvent.setup(), { client, posts } = mount({ reservations: () => reservations, post: (post, count) => {
    reservations = reservations.map(item => post.path.endsWith(`/${item.id}/release`) ? { ...item, status: 'released', remainingQuantity: 0, version: item.version + 1, releaseReason: String(post.body.input.reason) } : item)
    return Response.json({ auditId: `audit-${count}`, requestId: `receipt-${count}`, effects: [], warnings: [], data: { admissionId: admission.id, encounterVersion: '1', reservations, reservationSets: [] } })
  } })
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const release = await screen.findByRole('region', { name: '释放预留' })
  const commonReason = within(release).getByRole('textbox', { name: '释放预留共同理由' })
  await user.type(commonReason, '手术调整共同释放')
  await user.type(await within(release).findByRole('textbox', { name: '逐项理由 合成球囊' }), '球囊单项覆盖释放依据')
  await user.click(within(release).getByRole('button', { name: '全选本页可办理项' }))
  await user.click(within(release).getByRole('button', { name: '审阅释放预留' }))
  await user.click(screen.getByRole('button', { name: '确认释放所选预留' }))
  await waitFor(() => expect(posts).toHaveLength(2))
  const results = screen.getByRole('region', { name: '释放预留逐项结果' })
  await waitFor(() => expect(results.textContent?.match(/已成功，已移出原输入/g)).toHaveLength(2))
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await waitFor(() => expect(within(release).getByRole('article', { name: '释放预留 合成球囊' }).textContent).toContain('已应用释放理由：球囊单项覆盖释放依据'))
  const balloon = within(release).getByRole('article', { name: '释放预留 合成球囊' })
  const stent = within(release).getByRole('article', { name: '释放预留 合成支架' })
  expect(stent.textContent).toContain('已应用释放理由：手术调整共同释放')
  expect(within(balloon).queryByRole('textbox', { name: '逐项理由 合成球囊' })).toBeNull()
  expect(balloon.textContent).not.toContain('最终理由：')
  expect(results.textContent).toContain('已应用理由：球囊单项覆盖释放依据')
  await user.clear(commonReason); await user.type(commonReason, '下一批新的共同理由')
  expect(balloon.textContent).toContain('已应用释放理由：球囊单项覆盖释放依据')
  expect(balloon.textContent).not.toContain('下一批新的共同理由')
  expect(results.textContent).toContain('已应用理由：球囊单项覆盖释放依据')
})

it('服务器已释放时保留失效的已选原输入，取消后展示真实完成理由', async () => {
  let reservation = inpatientMaterialReservationSchema.parse({ id: 'reservation-1', admissionId: admission.id, requestId: plan.id,
    materialId: 'material-1', materialDisplay: '合成球囊', unit: '枚', quantity: 3, consumedQuantity: 0, remainingQuantity: 3,
    version: 1, priceFen: 2000, status: 'reserved', reason: '原合成手术预留', createdAt: time })
  const user = userEvent.setup(), { client, posts } = mount({ reservations: () => [reservation] })
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const release = await screen.findByRole('region', { name: '释放预留' })
  await user.type(await within(release).findByRole('textbox', { name: '逐项理由 合成球囊' }), '本人尚未发送的理由')
  await user.click(within(release).getByRole('checkbox', { name: '选择合成球囊' }))
  reservation = { ...reservation, status: 'released', remainingQuantity: 0, version: 2, releaseReason: '另一已完成释放的实际理由' }
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await waitFor(() => expect(within(release).getByRole('button', { name: '审阅释放预留' }).hasAttribute('disabled')).toBe(true))
  expect(within(release).getByRole<HTMLInputElement>('textbox', { name: '逐项理由 合成球囊' }).value).toBe('本人尚未发送的理由')
  await user.click(within(release).getByRole('button', { name: '取消选择合成球囊' }))
  const completed = within(release).getByRole('article', { name: '释放预留 合成球囊' })
  expect(completed.textContent).toContain('已应用释放理由：另一已完成释放的实际理由')
  expect(within(completed).queryByRole('textbox')).toBeNull()
  expect(posts).toEqual([])
})

it('跨页保留明确选择，全选本页超过20项时整体阻止并保留原19项', async () => {
  const reservations = Array.from({ length: 25 }, (_, index) => inpatientMaterialReservationSchema.parse({ id: `reservation-${index + 1}`, admissionId: admission.id, requestId: plan.id,
    materialId: 'material-1', materialDisplay: `合成预留${String(index + 1).padStart(2, '0')}`, unit: '枚', quantity: 2, consumedQuantity: 0, remainingQuantity: 2,
    version: 1, priceFen: 2000, status: 'reserved', reason: '原合成备用', createdAt: time }))
  const user = userEvent.setup(), { posts } = mount({ reservations: () => reservations })
  await user.click(screen.getByRole('button', { name: '手工预留维护' }))
  const release = await screen.findByRole('region', { name: '释放预留' })
  await user.type(within(release).getByRole('textbox', { name: '释放预留共同理由' }), '释放共同依据')
  await user.click(within(release).getByRole('button', { name: '全选本页可办理项' }))
  await user.click(within(release).getByRole('button', { name: '下一页待办' }))
  await user.click(within(release).getByRole('button', { name: '全选本页可办理项' }))
  expect(release.textContent).toContain('已选择 20 / 20 项')
  await user.click(within(release).getByRole('checkbox', { name: '选择合成预留11' }))
  await user.click(within(release).getByRole('button', { name: '下一页待办' }))
  await user.click(within(release).getByRole('button', { name: '全选本页可办理项' }))
  expect(release.textContent).toContain('选择将超过20项上限，原选择与输入已保留')
  expect(release.textContent).toContain('已选择 19 / 20 项')
  const selected = screen.getByRole('region', { name: '完整释放待办清单' })
  expect(within(selected).getAllByRole('button', { name: /^取消选择/ })).toHaveLength(19)
  await user.type(within(release).getByRole('textbox', { name: '搜索当前手术预留' }), '合成预留01')
  expect(within(release).getByRole('checkbox', { name: '选择合成预留01' }).getAttribute('aria-checked')).toBe('true')
  expect(within(selected).getAllByRole('button', { name: /^取消选择/ })).toHaveLength(19)
  expect(posts).toEqual([])
})

it('资料读取失败保留输入与旧列表并阻提交，重试成功后重新核对', async () => {
  let failCatalog = false
  const user = userEvent.setup(), { client, posts } = mount({ get: path => failCatalog && path.endsWith('/surgery-catalog') ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成目录暂不可用' } }, { status: 503 }) : undefined })
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user)
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '资料失败仍保留')
  failCatalog = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '新增预留共同理由' }).value).toBe('资料失败仍保留')
  expect(screen.getByRole('spinbutton', { name: '预留数量 合成钛夹' })).toBeDefined()
  expect(await screen.findByRole('button', { name: '重试预留资料' })).toBeDefined()
  expect(screen.getByRole('button', { name: '审阅新增预留' }).hasAttribute('disabled')).toBe(true)
  expect(posts).toEqual([])
  failCatalog = false
  await user.click(screen.getByRole('button', { name: '重试预留资料' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '审阅新增预留' }).hasAttribute('disabled')).toBe(false))
})

it('清空输入必须确认且存储失败在确认窗内保留原数量与理由', async () => {
  const user = userEvent.setup(), { posts } = mount()
  await user.click(screen.getByRole('button', { name: '手工预留维护' })); await addMaterials(user)
  await user.type(screen.getByRole('textbox', { name: '新增预留共同理由' }), '清空失败不能丢失')
  const create = screen.getByRole('region', { name: '新增预留' })
  await user.click(within(create).getByRole('button', { name: '清空未提交输入' }))
  const confirm = screen.getByRole('alertdialog', { name: '清空未提交输入？' })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '新增预留共同理由', hidden: true }).value).toBe('清空失败不能丢失')
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成存储故障') })
  await user.click(within(confirm).getByRole('button', { name: '确认清空输入' }))
  expect(within(confirm).getByRole('alert').textContent).toContain('原输入已保留')
  remove.mockRestore()
  await user.click(within(confirm).getByRole('button', { name: '保留输入' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '新增预留共同理由' }).value).toBe('清空失败不能丢失')
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '预留数量 合成钛夹' }).value).toBe('1')
  expect(posts).toEqual([])
})
