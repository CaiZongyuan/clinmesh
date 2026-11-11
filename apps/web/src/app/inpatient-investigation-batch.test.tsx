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
