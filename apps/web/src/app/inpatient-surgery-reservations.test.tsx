// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryDetails } from './inpatient-surgery-details.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-03T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '51.2300', display: '腹腔镜下胆囊切除术', category: '手术', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const materials = ['合成钛夹', '合成缝线'].map((display, index) => ({ id: `material-${index + 1}`, version: 1, display, chargeDefinition: { id: `material-price-${index + 1}`, priceFen: 2000, unit: '枚', synthetic: true, trigger: 'execution' } }))
const plan = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 3, status: 'requested', plannedProcedure: procedure, plannedFor: time, reason: '合成计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1' })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

function mount() {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [plan], executions: [], inProgress: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    throw new Error(`Unexpected ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientSurgeryDetails admission={admission} session={session} locale="zh-CN" write={write} plan={plan} estimate={undefined} selection={undefined} onOpenUsage={undefined} />
  }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

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
