// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'
import { createDraftDiscard } from './draft-discard.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '合成医生', email: 'synthetic@example.test' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-1', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const items = ['白细胞计数', '血红蛋白'].map((display, index) => ({ id: `lab-${index}`, display, kind: 'laboratory', version: 1, priceFen: 100, available: true, indicationCodes: ['screening'] }))
const clients: QueryClient[] = []

it('住院功能检查分类保留两项指征并按examination类型逐项开立', async () => {
  const functional = ['常规十二导联心电图', '经胸超声心动图'].map((display, index) => ({ id: `exam-${index}`, display, kind: 'examination', version: 1, priceFen: 3000, available: true, indicationCodes: [] }))
  const inputs: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: functional })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] })
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/admissions/admission-1')) return Response.json({ admission })
    if (path.endsWith('/investigations/issue')) {
      inputs.push(JSON.parse(String(init?.body)).input)
      return Response.json({ auditId: 'audit-1', requestId: 'command-1', effects: [], warnings: [], data: { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] } })
    }
    throw new Error(`Unexpected ${path}`)
  }))
  const user = userEvent.setup(); mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
  await user.click(dialog.getByRole('button', { name: '功能检查' }))
  for (const item of functional) await user.click(dialog.getByRole('button', { name: `选择${item.display}` }))
  for (const input of dialog.getAllByRole('textbox', { name: '检查指征' })) await user.type(input, '合成心功能评估')
  await user.click(dialog.getByRole('button', { name: '开立所选功能检查（2）' }))
  await vi.waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs).toEqual(functional.map(item => ({ encounterVersion: admission.versionId, catalogVersion: 1, selection: { kind: 'examination', serviceId: item.id, indication: '合成心功能评估' } })))
})
function mount(current = admission, currentSession = session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Subject() {
    const write = useInpatientWriteIntent(currentSession, () => undefined)
    return <><InpatientWriteRecovery write={write} locale="zh-CN" /><InpatientInvestigations admission={current} session={currentSession} locale="zh-CN" write={write} /></>
  }
  return render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>)
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })

it('退出清理删除失败后重挂不回显住院检查私稿，持久标记补清理后可保存新输入', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup(), original = mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  await user.click(screen.getByRole('button', { name: '选择白细胞计数' }))
  const prefix = 'clinmesh.inpatient-investigation-drafts:v1:'
  const key = Object.keys(sessionStorage).find(key => key.startsWith(prefix))!
  expect(key).toBeDefined()
  const remove = Storage.prototype.removeItem
  const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, target) {
    if (target.startsWith(prefix)) throw new DOMException('合成退出删除失败', 'SecurityError')
    remove.call(this, target)
  })
  try {
    await act(async () => { await expect(signOut()).resolves.toBeUndefined() })
    expect(sessionStorage.getItem(key)).not.toBeNull()
    original.unmount()
    const unavailable = mount()
    await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
    expect(within(screen.getByRole('dialog', { name: '开立住院检查' })).queryByRole('checkbox')).toBeNull()
    unavailable.unmount()
    denied.mockRestore()
    // 新实例没有原 guard 的内存状态，只能依据退出留下的持久标记补清理。
    expect(createDraftDiscard(prefix).read(key)).toBeNull()
    const restored = mount()
    await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: '选择血红蛋白' }))
    restored.unmount()
    mount()
    await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
    const dialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1)
    expect(dialog.getByRole('region', { name: '待开：血红蛋白' })).toBeDefined()
    expect(dialog.queryByRole('region', { name: '待开：白细胞计数' })).toBeNull()
  } finally { denied.mockRestore() }
})

it('连续加入两项同类检查、清空选择不丢待开清单，关闭重开和重新挂载均恢复且隔离患者', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  const view = mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  let dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  await user.click(within(dialog).getByRole('button', { name: '选择血红蛋白' }))
  expect(within(dialog).getByRole('button', { name: '开立所选检验（2）' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '清空选择' }))
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  await user.click(within(dialog).getByRole('button', { name: '关闭' }))
  view.unmount()
  const other = mount({ ...admission, id: 'admission-2', patientId: 'patient-2' })
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  other.unmount()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  await user.click(within(dialog).getByRole('button', { name: '全选本页可办理项目' }))
  expect(within(dialog).getByRole('button', { name: '开立所选检验（2）' }).hasAttribute('disabled')).toBe(false)
})

it('确定的部分失败保留输入并只重试失败项，退出登录清除未提交待开清单', async () => {
  let fail = true
  const issued: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/investigations/issue')) {
      const body = JSON.parse(String(init?.body))
      issued.push(body.input.selection.catalogItemId)
      if (body.input.selection.catalogItemId === 'lab-1' && fail) return Response.json({ error: { code: 'INPATIENT_INVESTIGATION_CATALOG_CONFLICT', message: 'Synthetic conflict' } }, { status: 409 })
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] } })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  const view = mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  await user.click(within(dialog).getByRole('button', { name: '选择血红蛋白' }))
  await user.click(within(dialog).getByRole('button', { name: '开立所选检验（2）' }))
  await vi.waitFor(() => expect(issued).toEqual(['lab-0', 'lab-1']))
  expect(await within(dialog).findByText('已成功开立 1 项')).toBeDefined()
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
  fail = false
  await user.click(within(dialog).getByRole('button', { name: '开立所选检验（1）' }))
  await within(dialog).findByText('已成功开立 2 项')
  expect(issued).toEqual(['lab-0', 'lab-1', 'lab-1'])
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  view.unmount()
  await signOut()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('检查与检验分别选择，缺指征阻止提交且清空待开清单须确认', async () => {
  const imaging = { ...items[0]!, id: 'imaging-1', kind: 'imaging', display: '合成胸部检查', indicationCodes: [] }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [...items, imaging] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  await user.click(within(dialog).getByRole('button', { name: '检查' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成胸部检查' }))
  expect(within(dialog).queryByRole('button', { name: '开立所选检验（1）' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '开立所选检查（1）' }).hasAttribute('disabled')).toBe(true)
  await user.type(within(dialog).getByRole('textbox', { name: '检查指征' }), '合成咳嗽待查')
  expect(within(dialog).getByRole('button', { name: '开立所选检查（1）' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '清空待开清单' }))
  await user.click(screen.getByRole('button', { name: '保留待开清单' }))
  expect(within(dialog).getByRole('textbox', { name: '检查指征' }).getAttribute('value')).toBe('合成咳嗽待查')
  await user.click(within(dialog).getByRole('button', { name: '清空待开清单' }))
  await user.click(screen.getByRole('button', { name: '确认清空' }))
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: '检验' }))
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
})

it('恢复回执读取被拒时继续保留原操作身份，不允许换键重复开立', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.includes('/command-receipts?')) return Response.json({ error: { code: 'ROLE_NOT_ALLOWED', message: 'Synthetic receipt access rejection' } }, { status: 403 })
    if (path.endsWith('/investigations/issue')) { posts++; throw new TypeError('Synthetic response loss') }
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  await user.click(within(dialog).getByRole('button', { name: '开立所选检验（1）' }))
  const recover = await within(dialog).findByRole('button', { name: '恢复原开立：白细胞计数' })
  await user.click(recover)
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: '恢复原开立：白细胞计数' }).hasAttribute('disabled')).toBe(false))
  expect(posts).toBe(1)
  expect(within(dialog).getByRole('button', { name: '开立所选检验（0）' }).hasAttribute('disabled')).toBe(true)
})

it('目录版本冲突后刷新目录并保留输入，重新选择当前项目后可完成开立', async () => {
  let catalogVersion = 1
  const imaging = { ...items[0]!, id: 'imaging-1', kind: 'imaging', display: '合成胸部检查', indicationCodes: [] }
  const issuedVersions: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [{ ...imaging, version: catalogVersion }] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/investigations/issue')) {
      const body = JSON.parse(String(init?.body))
      issuedVersions.push(body.input.catalogVersion)
      if (body.input.catalogVersion !== catalogVersion) return Response.json({ error: { code: 'INPATIENT_INVESTIGATION_CATALOG_CONFLICT', message: 'Synthetic catalog version conflict' } }, { status: 409 })
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] } })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '检查' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成胸部检查' }))
  await user.type(within(dialog).getByRole('textbox', { name: '检查指征' }), '合成咳嗽待查')
  catalogVersion = 2
  await user.click(within(dialog).getByRole('button', { name: '开立所选检查（1）' }))
  await within(dialog).findByText('目录或价格已变化，请移除后重新选择')
  expect(within(dialog).getByRole('textbox', { name: '检查指征' }).getAttribute('value')).toBe('合成咳嗽待查')
  expect(within(dialog).getByRole('button', { name: '开立所选检查（1）' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '移除项目' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成胸部检查' }))
  await user.type(within(dialog).getByRole('textbox', { name: '检查指征' }), '合成咳嗽待查')
  await user.click(within(dialog).getByRole('button', { name: '开立所选检查（1）' }))
  await within(dialog).findByText('已成功开立 1 项')
  expect(issuedVersions).toEqual([1, 2])
})

it.each(['actorId', 'scenarioRunId', 'locationId', 'organizationId', 'practitionerId'] as const)('Actor 的 %s 变化后不恢复旧未知开立，回到原上下文仍按原键取回执', async field => {
  let currentSession = session
  let posts = 0
  let originalKey: string | null = null
  const receiptKeys: string[] = []
  const response = { auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] } }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(currentSession)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/investigations/issue')) {
      posts++; originalKey = new Headers(init?.headers).get('idempotency-key')
      throw new TypeError('Synthetic committed response loss')
    }
    if (path.includes('/command-receipts?')) {
      const query = new URL(path, 'http://synthetic.local').searchParams
      receiptKeys.push(query.get('idempotencyKey')!)
      expect(currentSession).toEqual(session)
      return Response.json({ operationId: 'inpatient.investigation.issue', idempotencyKey: query.get('idempotencyKey'), status: 'completed', response })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  const original = mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  let dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '选择白细胞计数' }))
  await user.click(within(dialog).getByRole('button', { name: '开立所选检验（1）' }))
  await within(dialog).findByRole('button', { name: '恢复原开立：白细胞计数' })
  original.unmount()
  currentSession = { ...session, actor: { ...session.actor, [field]: 'synthetic-remapped' } }
  const remapped = mount(admission, currentSession)
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  expect(within(dialog).queryByRole('button', { name: '恢复原开立：白细胞计数' })).toBeNull()
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  expect(receiptKeys).toEqual([])
  remapped.unmount()
  currentSession = session
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  dialog = screen.getByRole('dialog', { name: '开立住院检查' })
  await user.click(within(dialog).getByRole('button', { name: '恢复原开立：白细胞计数' }))
  await within(dialog).findByText('已成功开立 1 项')
  expect(receiptKeys).toEqual([originalKey])
  expect(posts).toBe(1)
})

it('全局恢复查原检查回执一次并同步已关闭待开清单', async () => {
  const posts: string[] = [], receipts: string[] = []
  const data = { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items })
    if (path.endsWith('/investigations')) return Response.json(data)
    if (path.endsWith('/investigations/issue')) {
      posts.push(new Headers(init?.headers).get('idempotency-key')!)
      throw new TypeError('Synthetic response loss')
    }
    if (path.includes('/command-receipts?')) {
      const idempotencyKey = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!
      receipts.push(idempotencyKey)
      return Response.json({ operationId: 'inpatient.investigation.issue', idempotencyKey, status: 'completed',
        response: { auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data } })
    }
    throw new Error(path)
  }))
  const user = userEvent.setup(); mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = () => within(screen.getByRole('dialog', { name: '开立住院检查' }))
  await user.click(dialog().getByRole('button', { name: '选择白细胞计数' }))
  await user.click(dialog().getByRole('button', { name: '选择血红蛋白' }))
  await user.click(dialog().getByRole('button', { name: '开立所选检验（2）' }))
  await dialog().findByRole('button', { name: '恢复原开立：白细胞计数' })
  await user.click(dialog().getByRole('button', { name: '关闭' }))
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  await dialog().findByText('已成功开立 1 项')
  expect(dialog().getAllByRole('checkbox')).toHaveLength(1)
  expect(dialog().getByRole('button', { name: '开立所选检验（1）' }).hasAttribute('disabled')).toBe(false)
  expect(posts).toHaveLength(1)
  expect(receipts).toEqual(posts)
})

it('大型检验目录默认聚焦常用组合并展示标本管与细项数，切换术前常规单项可一键整类加入并自动去重', async () => {
  const purple = {
    capColor: 'purple' as const,
    code: 'edta-k2-purple' as const,
    collectionRequirementEn: 'Invert 8 times',
    collectionRequirementZh: '静脉采血 · 立即颠倒混匀 8 次，勿剧烈摇晃',
    containerNameEn: 'EDTA-K2 purple-top tube',
    containerNameZh: 'EDTA-K2 紫头管',
    mergeable: true,
    specimenCategoryEn: 'Whole blood',
    specimenCategoryZh: '全血',
  }
  const yellow = {
    capColor: 'yellow' as const,
    code: 'sst-yellow' as const,
    collectionRequirementEn: 'Invert 5 times',
    collectionRequirementZh: '静脉采血 · 颠倒混匀 5 次后静置促凝分离血清',
    containerNameEn: 'SST yellow-top tube',
    containerNameZh: '促凝黄头管',
    mergeable: true,
    specimenCategoryEn: 'Serum',
    specimenCategoryZh: '血清',
  }
  const blue = {
    capColor: 'blue' as const,
    code: 'citrate-blue' as const,
    collectionRequirementEn: 'Fill to mark',
    collectionRequirementZh: '严格采足刻度 · 立即颠倒混匀 5–8 次',
    containerNameEn: 'Sodium citrate blue-top tube (1:9)',
    containerNameZh: '枸橼酸钠蓝头管 (1:9)',
    mergeable: true,
    specimenCategoryEn: 'Citrated plasma',
    specimenCategoryZh: '抗凝血浆',
  }
  const preopNames = ['白细胞计数', '血红蛋白', '血小板计数', '肌酐（质量浓度）', '国际标准化比值 INR', '丙氨酸氨基转移酶', '天冬氨酸氨基转移酶', '钾', '钠']
  const largeCatalog = [
    { id: 'panel-cbc', display: '血常规（五分类）', kind: 'laboratory' as const, version: 1, priceFen: 2500, available: true, indicationCodes: ['clinical-evaluation'], isPanel: true, memberCount: 8, laboratoryCategory: 'hematology-coagulation' as const, specimen: '全血', specimenContainer: purple },
    { id: 'panel-liver', display: '肝功能', kind: 'laboratory' as const, version: 1, priceFen: 5500, available: true, indicationCodes: ['clinical-evaluation'], isPanel: true, memberCount: 8, laboratoryCategory: 'biochemistry' as const, specimen: '血清、血浆', specimenContainer: yellow },
    { id: 'panel-coag', display: '凝血功能', kind: 'laboratory' as const, version: 1, priceFen: 6500, available: true, indicationCodes: ['clinical-evaluation'], isPanel: true, memberCount: 6, laboratoryCategory: 'hematology-coagulation' as const, specimen: '血浆', specimenContainer: blue },
    ...preopNames.map((display, idx) => ({
      id: `hospital-lab-pci-${idx + 1}`,
      display,
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 800,
      available: true,
      indicationCodes: ['clinical-assessment'],
      isPanel: false,
      laboratoryCategory: 'preop-routine' as const,
      specimen: idx < 3 ? '全血' : idx === 4 ? '枸橼酸盐抗凝血浆' : '血清',
      specimenContainer: idx < 3 ? purple : idx === 4 ? blue : yellow,
    })),
    { id: 'test-esr', display: '红细胞沉降率测定', kind: 'laboratory' as const, version: 1, priceFen: 1500, available: true, indicationCodes: ['clinical-evaluation'], isPanel: false, laboratoryCategory: 'hematology-coagulation' as const, specimen: '全血', specimenContainer: purple },
    { id: 'test-alt', display: '谷丙转氨酶单项', kind: 'laboratory' as const, version: 1, priceFen: 800, available: true, indicationCodes: ['clinical-evaluation'], isPanel: false, laboratoryCategory: 'biochemistry' as const, specimen: '血清', specimenContainer: yellow },
  ]
  const issuedIds: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: largeCatalog })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] })
    if (path.endsWith('/investigations/issue')) {
      issuedIds.push(JSON.parse(String(init?.body)).input.selection.catalogItemId)
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] } })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
  const categoryBar = dialog.getByRole('group', { name: '检验分类' })
  expect(within(categoryBar).getByRole('button', { name: '常用组合' }).getAttribute('aria-pressed')).toBe('true')
  expect(dialog.getByRole('button', { name: '选择肝功能' })).toBeDefined()
  expect(dialog.getAllByText(/组合 · 8 项/)).toHaveLength(2)
  expect(dialog.queryByRole('button', { name: '选择红细胞沉降率测定' })).toBeNull()

  const search = dialog.getByRole('textbox', { name: '搜索检查检验目录' })
  await user.type(search, '红细胞沉降率')
  expect(dialog.getByRole('button', { name: '选择红细胞沉降率测定' })).toBeDefined()
  await user.clear(search)

  await user.click(within(categoryBar).getByRole('button', { name: '术前常规单项' }))
  expect(dialog.getByRole('button', { name: '选择白细胞计数' })).toBeDefined()
  // 切换分类后再输入搜索词时，自动切回「全部」跨分类检索并同步页签高亮状态
  await user.type(search, '肝功能')
  expect(within(categoryBar).getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true')
  expect(dialog.getByRole('button', { name: '选择肝功能' })).toBeDefined()
  await user.clear(search)
  expect(within(categoryBar).getByRole('button', { name: '术前常规单项' }).getAttribute('aria-pressed')).toBe('true')
  await user.click(dialog.getByRole('button', { name: '选择白细胞计数' }))
  await user.click(dialog.getByRole('button', { name: '加入本类可开项目（8）' }))
  expect(dialog.getAllByRole('checkbox')).toHaveLength(9)
  expect(dialog.getByRole('button', { name: '加入本类可开项目（0）' }).hasAttribute('disabled')).toBe(true)

  await user.click(dialog.getByRole('button', { name: '开立所选检验（9）' }))
  await vi.waitFor(() => expect(issuedIds).toHaveLength(9))
  expect(new Set(issuedIds).size).toBe(9)
})

it('整类加入超出待开清单 20 项上限时整批提示拦截且不半类混入', async () => {
  const catalog = [
    ...Array.from({ length: 15 }, (_, idx) => ({
      id: `panel-${idx}`,
      display: `合成组合${idx + 1}`,
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 2000,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: true,
      memberCount: 4,
      laboratoryCategory: 'biochemistry' as const,
    })),
    ...Array.from({ length: 8 }, (_, idx) => ({
      id: `preop-${idx}`,
      display: `术前单项${idx + 1}`,
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 800,
      available: true,
      indicationCodes: ['clinical-assessment'],
      isPanel: false,
      laboratoryCategory: 'preop-routine' as const,
    })),
  ]
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: catalog })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
  await user.click(dialog.getByRole('button', { name: '加入本类可开项目（15）' }))
  expect(dialog.getByText(/待开 15 项/)).toBeDefined()
  await user.click(within(dialog.getByRole('group', { name: '检验分类' })).getByRole('button', { name: '术前常规单项' }))
  await user.click(dialog.getByRole('button', { name: '加入本类可开项目（8）' }))
  expect(dialog.getByRole('alert').textContent).toContain('最多保留 20 项')
  expect(dialog.getByText(/待开 15 项/)).toBeDefined()
})

it('整类加入自动按 assayKeys 去重重叠检验组合及其子项，杜绝同分类内重复开立与重复计费', async () => {
  const catalog = [
    {
      id: 'panel-liver-renal',
      display: '肝肾功能',
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 8500,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: true,
      memberCount: 2,
      assayKeys: ['wst#1500104A', 'wst#1700404A'],
      laboratoryCategory: 'biochemistry' as const,
    },
    {
      id: 'panel-liver',
      display: '肝功能',
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 5500,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: true,
      memberCount: 1,
      assayKeys: ['wst#1500104A'],
      laboratoryCategory: 'biochemistry' as const,
    },
    {
      id: 'test-alt',
      display: '丙氨酸氨基转移酶测定',
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 800,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: false,
      assayKeys: ['wst#1500104A'],
      laboratoryCategory: 'biochemistry' as const,
    },
    {
      id: 'test-cr',
      display: '肌酐测定',
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 1000,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: false,
      assayKeys: ['wst#1700404A'],
      laboratoryCategory: 'biochemistry' as const,
    },
    {
      id: 'test-amy',
      display: '淀粉酶测定',
      kind: 'laboratory' as const,
      version: 1,
      priceFen: 1500,
      available: true,
      indicationCodes: ['clinical-evaluation'],
      isPanel: false,
      assayKeys: ['wst#1501204A'],
      laboratoryCategory: 'biochemistry' as const,
    },
  ]
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: catalog })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], examinationRequests: [], sent: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
  await user.click(within(dialog.getByRole('group', { name: '检验分类' })).getByRole('button', { name: '生化/肝肾电解质' }))

  // 5 个候选中：优先保留覆盖更全的「肝肾功能」与独立单项「淀粉酶测定」（共 2 项），跳过被覆盖的「肝功能」「ALT」「肌酐」
  await user.click(dialog.getByRole('button', { name: '加入本类可开项目（2）' }))
  expect(dialog.getByText(/完整已选清单：肝肾功能、淀粉酶测定/)).toBeDefined()
  expect(dialog.getByRole('button', { name: '加入本类可开项目（0）' }).hasAttribute('disabled')).toBe(true)

  // 若医生先单独选择了原子子项 ALT，再点整类加入，则不会叠加包含 ALT 的组合，只补齐未覆盖的肌酐与淀粉酶
  await user.click(dialog.getByRole('button', { name: '清空待开清单' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认清空' }))
  await user.click(dialog.getByRole('button', { name: '选择丙氨酸氨基转移酶测定' }))
  await user.click(dialog.getByRole('button', { name: '加入本类可开项目（2）' }))
  expect(dialog.getByText(/完整已选清单：丙氨酸氨基转移酶测定、肌酐测定、淀粉酶测定/)).toBeDefined()
})
