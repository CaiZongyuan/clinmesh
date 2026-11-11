// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const medication = { id: 'medication-example', display: '合成药品', version: 1, priceFen: 100, unit: '片',
  doses: [{ doseText: '5 mg', quantity: 1 }], doseBasis: { amount: 5, unit: 'mg' }, maxDoseQuantity: 2, frequencyCodes: ['QD'], lots: [] }

const service = { id: 'service-example', display: '合成护理项目', version: 1, priceFen: 500, unit: '次' }

function mount(target = admission, active = true, actor = session, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  function Clinical({ enabled }: { enabled: boolean }) {
    const write = useInpatientWriteIntent(actor, () => undefined)
    return <><InpatientWriteRecovery write={write} locale={locale} /><InpatientClinical admission={target} active={enabled} session={actor} locale={locale} write={write} /></>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const element = (enabled: boolean) => <QueryClientProvider client={client}><Clinical enabled={enabled} /></QueryClientProvider>
  const view = render(element(active))
  return { ...view, setActive: (enabled: boolean) => view.rerender(element(enabled)) }
}
function reads(path: string) {
  if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [medication], services: [service] })
  if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1, coding: { id: 'diagnosis-1', code: 'I10', display: '合成高血压', system: 'https://example.test/icd', version: '1', sourceLocator: 'synthetic-fixture' } }] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
  if (path.includes('/catalog-search?')) return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 1, items: [{ id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication }] })
  if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
  throw new Error(`Unexpected read ${path}`)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

it('页面只保留入口，弹窗连续添加药品与护理并独立编辑，关闭和刷新后保留', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reads(path)))
  const user = userEvent.setup(), view = mount()
  await screen.findByRole('button', { name: '开立医嘱' })
  expect(screen.queryByRole('textbox', { name: '医嘱项目' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '开立医嘱' }))
  let dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  await user.click(await within(dialog).findByRole('button', { name: /选择合成药品/ }))
  await user.click(within(dialog).getByRole('button', { name: /选择合成护理项目/ }))
  const drug = within(dialog).getByRole('region', { name: '待开：合成药品' })
  await user.clear(within(drug).getByRole('textbox', { name: '每次剂量' }))
  await user.type(within(drug).getByRole('textbox', { name: '每次剂量' }), '10 mg')
  await user.click(within(drug).getByRole('button', { name: '临时' }))
  expect(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '关闭' }))
  view.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  expect(within(dialog).getByRole('textbox', { name: '每次剂量' }).getAttribute('value')).toBe('10 mg')
  expect(within(within(dialog).getByRole('region', { name: '待开：合成药品' })).getByRole('button', { name: '临时' }).getAttribute('aria-pressed')).toBe('true')
})

async function addBoth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  const dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  await user.click(await within(dialog).findByRole('button', { name: '选择合成药品' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成护理项目' }))
  return dialog
}
const success = () => ({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: {
  admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0,
} })

it('集中开立允许确定的部分失败，成功行移出并且只重试保留原输入的失败行', async () => {
  const issued: Array<Record<string, unknown>> = []
  let fail = true
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/orders/issue')) {
      const input = JSON.parse(String(init?.body)).input
      issued.push(input)
      if (input.selection.kind === 'service' && fail) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '合成护理目录冲突' } }, { status: 409 })
      return Response.json(success())
    }
    return reads(path)
  }))
  const user = userEvent.setup(); mount()
  const dialog = await addBoth(user)
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }))
  await within(dialog).findByText('已成功开立 1 项')
  await within(dialog).findByRole('alert')
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
  expect(issued).toHaveLength(2)
  fail = false
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await within(dialog).findByText('已成功开立 2 项')
  expect(issued).toHaveLength(3)
  expect(issued[2]).toEqual(issued[1])
})

it.each(['row', 'global', 'global-rejected', 'global-unreadable'])('丢响应后恢复原开立并结算清单：%s', async mode => {
  const global = mode !== 'row'
  const posts: Array<{ key: string | null; input: unknown }> = []
  let receiptReads = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      receiptReads++
      expect(new URL(path, 'http://localhost').searchParams.get('idempotencyKey')).toBe(posts[0]?.key)
      if (mode === 'global-rejected') return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Not found' } }, { status: 404 })
      return Response.json({ operationId: 'inpatient.order.issue', idempotencyKey: posts[0]?.key, status: 'completed', response: success() })
    }
    if (path.endsWith('/orders/issue')) {
      posts.push({ key: new Headers(init?.headers).get('idempotency-key'), input: JSON.parse(String(init?.body)).input })
      if (posts.length === 1) throw new TypeError('Synthetic response loss')
      if (mode === 'global-rejected' && posts.length === 2) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '合成目录拒绝' } }, { status: 409 })
      return Response.json(success())
    }
    return reads(path)
  }))
  const user = userEvent.setup(), first = mount()
  let dialog = await addBoth(user)
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }))
  await within(dialog).findByRole('button', { name: '恢复原开立：合成药品' })
  expect(posts).toHaveLength(1)
  if (global) {
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-order-drafts:v1:'))!
    if (mode === 'global-unreadable') sessionStorage.setItem(key, '{synthetic-corrupted')
    await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
    if (mode === 'global-unreadable') {
      await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
      expect(sessionStorage.getItem(key)).toBe('{synthetic-corrupted')
      await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
      await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
      expect(within(screen.getByRole('dialog', { name: '开立医嘱' })).queryByRole('checkbox')).toBeNull()
      expect(sessionStorage.getItem(key)).toBeNull()
      expect(posts).toHaveLength(1); expect(receiptReads).toBe(2)
      return
    }
  } else { first.unmount(); mount() }
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  if (!global) await user.click(within(dialog).getByRole('button', { name: '恢复原开立：合成药品' }))
  if (mode === 'global-rejected') {
    await within(dialog).findByText(/合成目录拒绝/)
    expect(within(dialog).queryByRole('button', { name: '恢复原开立：合成药品' })).toBeNull()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
    expect(posts).toHaveLength(2); expect(posts[0]).toEqual(posts[1]); expect(receiptReads).toBe(1)
    return
  }
  await within(dialog).findByText('已成功开立 1 项')
  expect(posts).toHaveLength(1); expect(receiptReads).toBe(1)
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await within(dialog).findByText('已成功开立 2 项')
  expect(posts).toHaveLength(2)
  expect(posts[0]?.key).not.toBe(posts[1]?.key)
})

it('清空选择保留输入，清空草稿须确认，跨患者隔离且退出清理', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/sign-out' ? Response.json({}) : reads(path)))
  const user = userEvent.setup(), view = mount()
  let dialog = await addBoth(user)
  await user.click(within(dialog).getByRole('button', { name: '清空选择' }))
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  expect(within(dialog).getByRole('button', { name: '开立所选医嘱（0）' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '清空待开清单' }))
  await user.click(screen.getByRole('button', { name: '保留待开清单' }))
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  view.unmount()
  const other = mount({ ...admission, id: 'admission-2', patientId: 'patient-2' })
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  other.unmount()
  const original = mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
  original.unmount(); await signOut(); mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
})

const simulation = { admissionId: 'admission-1', evaluatedAt: '2026-08-24T09:00:00+08:00', fingerprint: 'a'.repeat(64), rulesId: 'synthetic-rules', rulesVersion: '1',
  formal: { chargesFen: 5000, items: [] }, committed: { items: [] }, reserved: { items: [] }, draft: { items: [{ kind: 'medication', id: 'medication-2', display: '合成降压药', quantity: 1, estimatedFen: 1500 }], missing: [] },
  coverage: { coveredFen: 5000, estimatedTotalFen: 6500, coveredRatioBp: 7692, note: '合成' }, grouping: { formal: { status: 'grouped', drgCode: 'FR59', mdcCode: 'MDCF', adrgCode: 'FR5', steps: [], reason: null }, projected: null, note: '合成' },
  paymentReference: null, incompleteness: { costMissing: true, paymentReferenceMissing: true } }

it('第一项成功后下一条费用预计持久过期，刷新不会静默接受新依据，重新预计后才能补开', async () => {
  const issued: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/simulation')) return Response.json({ ...simulation, fingerprint: (issued.length ? 'b' : 'a').repeat(64) })
    if (path.endsWith('/orders/issue')) { issued.push(JSON.parse(String(init?.body)).input); return Response.json(success()) }
    return reads(path)
  }))
  const user = userEvent.setup(), first = mount()
  let dialog = await addBoth(user)
  for (const name of ['合成药品', '合成护理项目']) await user.click(within(within(dialog).getByRole('region', { name: `待开：${name}` })).getByRole('button', { name: '费用预计' }))
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }).hasAttribute('disabled')).toBe(false))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }))
  await within(dialog).findByText('已成功开立 1 项')
  expect(issued).toHaveLength(1)
  expect(issued[0]).toMatchObject({ expectedDrgFingerprint: 'a'.repeat(64) })
  expect(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }).hasAttribute('disabled')).toBe(true)
  first.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  expect(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '重新预计' }))
  await vi.waitFor(() => expect(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }).hasAttribute('disabled')).toBe(false))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await within(dialog).findByText('已成功开立 2 项')
  expect(issued).toHaveLength(2)
  expect(issued[1]).toMatchObject({ expectedDrgFingerprint: 'b'.repeat(64) })
})

it('保留挂载的页签切走后不发送下一条，返回仍能看到尚未发送的草稿', async () => {
  let release!: () => void, posts = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/orders/issue')) { posts++; await gate; return Response.json(success()) }
    return reads(path)
  }))
  const user = userEvent.setup(), view = mount()
  const dialog = await addBoth(user)
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }))
  await vi.waitFor(() => expect(posts).toBe(1))
  view.setActive(false); release()
  await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: '开立医嘱' })).toBeNull())
  view.setActive(true)
  await screen.findByText('已成功开立 1 项')
  expect(posts).toBe(1)
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
})

it('发送前落盘失败时不发 Command，保留可见输入且允许确认丢弃后恢复', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/orders/issue')) { posts++; return Response.json(success()) }
    return reads(path)
  }))
  const user = userEvent.setup(); mount()
  const dialog = await addBoth(user)
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota') })
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（2）' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('已停止开立')
  expect(posts).toBe(0)
  expect(within(dialog).getByRole('textbox', { name: '每次剂量' }).getAttribute('value')).toBe('5 mg')
  storage.mockRestore()
  await user.click(within(dialog).getByRole('button', { name: '清空待开清单' }))
  await user.click(screen.getByRole('button', { name: '确认清空' }))
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
})

it('未选中行迟到的重新预计不能撤销另一条医嘱成功后的过期状态', async () => {
  let calls = 0, posts = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/simulation')) {
      const call = ++calls
      if (call === 3) await held
      return Response.json({ ...simulation, fingerprint: (call === 1 ? 'a' : 'b').repeat(64) })
    }
    if (path.endsWith('/orders/issue')) { posts++; return Response.json(success()) }
    return reads(path)
  }))
  const user = userEvent.setup(); mount()
  const dialog = await addBoth(user), nursing = within(dialog).getByRole('region', { name: '待开：合成护理项目' })
  await user.click(within(nursing).getByRole('checkbox'))
  await user.click(within(nursing).getByRole('button', { name: '费用预计' }))
  await vi.waitFor(() => expect(within(nursing).getByRole('button', { name: '重新预计' })).toBeDefined(), { timeout: 4500 })
  await user.click(within(nursing).getByRole('button', { name: '重新预计' }))
  await vi.waitFor(() => expect(calls).toBe(3))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await within(dialog).findByText('已成功开立 1 项')
  release()
  await vi.waitFor(() => expect(within(nursing).getByRole('button', { name: '重新预计' }).hasAttribute('disabled')).toBe(false))
  expect(within(nursing).getByRole('alert').textContent).toContain('评估已过期')
  expect(posts).toBe(1)
}, 10_000)

it.each(['remove', 'access'] as const)('退出清理被拒后重新登录不会恢复旧医嘱，清理恢复后可保存新输入（%s）', async failure => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/sign-out' ? Response.json({}) : reads(path)))
  const user = userEvent.setup(), original = mount()
  await addBoth(user)
  original.unmount()
  const denied = failure === 'remove'
    ? vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除被拒') })
    : vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('合成存储访问被拒') })
  await expect(signOut()).resolves.toBeUndefined()
  const blocked = mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  blocked.unmount(); denied.mockRestore()
  const restored = mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  const dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  await user.click(await within(dialog).findByRole('button', { name: '选择合成护理项目' }))
  restored.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(screen.getByRole('region', { name: '待开：合成护理项目' })).toBeTruthy()
})

it('英文医嘱目录拒绝使用本地化提示并保留原行', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/orders/issue')) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '合成中文错误原文' } }, { status: 409 })
    return reads(path)
  }))
  const user = userEvent.setup(); mount(admission, true, session, 'en-US')
  await user.click(await screen.findByRole('button', { name: 'Issue order' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Issue order' }))
  await user.click(await dialog.findByRole('button', { name: /Select 合成药品/ }))
  await user.click(dialog.getByRole('button', { name: /Issue selected orders/ }))
  await dialog.findByText(/check the indication, allergy information, dose and current catalog.*review before retrying/i)
  expect(screen.queryByText(/合成中文错误原文/)).toBeNull()
  expect(dialog.getAllByRole('checkbox')).toHaveLength(1)
})
