// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const medication = { id: 'medication-example', display: '合成药品', version: 1, priceFen: 100, unit: '片',
  doses: [{ doseText: '5 mg', quantity: 1 }], doseBasis: { amount: 5, unit: 'mg' }, maxDoseQuantity: 2, frequencyCodes: ['QD'], lots: [] }

function mount() {
  function Clinical() {
    return <InpatientClinical admission={admission} session={session} locale="zh-CN" write={useInpatientWriteIntent(session, () => undefined)} />
  }
  sessionStorage.clear()
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Clinical /></QueryClientProvider>)
}
function reads(path: string) {
  if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [medication], services: [] })
  if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
  if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
  throw new Error(`Unexpected read ${path}`)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('医生可编辑每次剂量，明确换算数量并阻止不整片或超上限提交', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reads(path)))
  mount()
  const user = userEvent.setup()
  const item = await screen.findByRole('combobox', { name: '医嘱项目' })
  item.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '合成药品' }))
  const dose = screen.getByRole('textbox', { name: '每次剂量' })
  await user.clear(dose)
  await user.type(dose, '10 mg')
  expect(screen.getByText('每次2片')).toBeDefined()
  expect(screen.getByRole('button', { name: '签发医嘱' }).hasAttribute('disabled')).toBe(false)
  await user.clear(dose)
  await user.type(dose, '7.5 mg')
  expect(screen.getByText('本次用量无法换算为完整制剂数量')).toBeDefined()
  expect(screen.getByRole('button', { name: '签发医嘱' }).hasAttribute('disabled')).toBe(true)
  await user.clear(dose)
  await user.type(dose, '3片')
  expect(screen.getByText('本次用量超过已声明的每次上限')).toBeDefined()
})

it('非法剂量单位显示错误，医生改回合法值后可以继续签发', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reads(path)))
  mount()
  const user = userEvent.setup()
  const item = await screen.findByRole('combobox', { name: '医嘱项目' })
  item.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '合成药品' }))
  const dose = screen.getByRole('textbox', { name: '每次剂量' })
  await user.clear(dose)
  await user.type(dose, '1 constructor')
  expect(screen.getByText('本次剂量单位与已声明的换算不匹配')).toBeDefined()
  expect(screen.getByRole('button', { name: '签发医嘱' }).hasAttribute('disabled')).toBe(true)
  await user.clear(dose)
  await user.type(dose, '10 mg')
  expect(screen.queryByText('本次剂量单位与已声明的换算不匹配')).toBeNull()
  expect(screen.getByText('每次2片')).toBeDefined()
  expect(screen.getByRole('button', { name: '签发医嘱' }).hasAttribute('disabled')).toBe(false)
})

it('共享目录按来源分页并展示缺项，只有完整院内映射可以选择', async () => {
  const searches: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (!path.includes('/catalog-search?')) return reads(path)
    const url = new URL(path, 'http://localhost')
    searches.push(url)
    const source = url.searchParams.get('source'), page = Number(url.searchParams.get('page'))
    return Response.json({ kind: 'medication', source, page, pageSize: 20, total: source === 'hospital' ? 21 : 1,
      items: source === 'reference' ? [{ id: 'reference-incomplete', display: '待补合成产品', status: 'incomplete', missingFields: ['unit', 'price'] }]
        : page === 1 ? [{ id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication }]
          : [{ id: 'inactive-medication', display: '停用产品', status: 'inactive', missingFields: [] }] })
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '搜索共享药品目录' }))
  const hospital = screen.getByRole('region', { name: '院内药品' }), reference = screen.getByRole('region', { name: '参考药品' })
  await within(reference).findByText('缺发药单位、缺院内价格')
  expect(within(reference).getByRole('button', { name: '选择待补合成产品' }).hasAttribute('disabled')).toBe(true)
  await user.click(await within(hospital).findByRole('button', { name: '下一页' }))
  await within(hospital).findByText('已停用')
  expect(searches.filter(url => url.searchParams.get('source') === 'reference').map(url => url.searchParams.get('page'))).toEqual(['1'])
  await user.click(screen.getByRole('button', { name: '搜索药品' }))
  await user.click(await within(hospital).findByRole('button', { name: '选择合成药品' }))
  expect(screen.getByRole('textbox', { name: '每次剂量' })).toBeDefined()
})

it('目录加载失败保留失败与重试入口，恢复后的无结果另行说明', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (!path.includes('/catalog-search?')) return reads(path)
    const url = new URL(path, 'http://localhost'), source = url.searchParams.get('source')
    if (source === 'reference' && fail) return Response.json({ error: { code: 'REFERENCE_DATA_UNAVAILABLE', message: 'Reference unavailable' } }, { status: 503 })
    return Response.json({ kind: 'medication', source, page: 1, pageSize: 20, total: 0, items: [] })
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '搜索共享药品目录' }))
  const reference = screen.getByRole('region', { name: '参考药品' })
  expect((await within(reference).findByRole('alert')).textContent).toContain('目录查询失败')
  expect(within(reference).queryByText('没有匹配项目')).toBeNull()
  fail = false
  await user.click(within(reference).getByRole('button', { name: '重试目录查询' }))
  await within(reference).findByText('没有匹配项目')
  expect(within(reference).queryByRole('alert')).toBeNull()
})
