// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientWorkspace } from './inpatient-workspace.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '合成住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = { id: 'admission-1', patientId: 'patient-1', patientName: '合成PCI患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct',
  wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'cleared', financialStatus: 'settled', recordStatus: 'archived',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 5000, chargesFen: 403618, outstandingFen: 0, versionId: '20' }
const clients: QueryClient[] = []
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals() })

it.each([
  { label: '结清归档', recordStatus: 'archived', outstandingFen: 0 },
  { label: '补缴完成未归档', recordStatus: 'open', outstandingFen: 0 },
  { label: '资金或医保待确认', recordStatus: 'open', outstandingFen: null },
  { label: '归档后真实待收', recordStatus: 'archived', outstandingFen: 2300 },
  { label: '旧回执没有当前摘要', recordStatus: 'open', outstandingFen: undefined },
])('$label 时队列和提醒使用当前待收而不比较费用和预交金', async ({ recordStatus, outstandingFen }) => {
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog') || path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, recordStatus, outstandingFen }] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '20', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 403618 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '20', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成非本次读取' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><InpatientWorkspace session={session} locale="zh-CN" /></QueryClientProvider>)
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看合成PCI患者' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  const list = screen.getByRole('button', { name: '查看合成PCI患者' })
  const reminders = screen.getByRole('region', { name: '临床提醒' })
  if (outstandingFen === 2300) {
    expect(reminders.textContent).toContain('当前需补交 ¥23.00')
    expect(within(list).getByText('欠费')).toBeDefined()
  } else {
    expect(reminders.textContent).not.toContain('当前需补交')
    expect(within(list).queryByText('欠费')).toBeNull()
  }
  if (recordStatus === 'archived') expect(within(banner).getByText('已归档 · 只读')).toBeDefined()
  if (outstandingFen === null) expect(within(list).getByText('资金待确认')).toBeDefined()
  if (recordStatus === 'open') {
    expect(reminders.textContent).not.toContain('请提醒患者补缴')
    if (outstandingFen === null) expect(reminders.textContent).toContain('待收费员确认')
    if (outstandingFen === undefined) expect(reminders.textContent).toContain('暂不可用')
  }
})
