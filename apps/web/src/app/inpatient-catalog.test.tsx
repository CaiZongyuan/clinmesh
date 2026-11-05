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

const service = { id: 'service-example', display: '合成护理项目', version: 1, priceFen: 500, unit: '次' }

function mount() {
  function Clinical() {
    return <InpatientClinical admission={admission} session={session} locale="zh-CN" write={useInpatientWriteIntent(session, () => undefined)} />
  }
  sessionStorage.clear()
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Clinical /></QueryClientProvider>)
}
function reads(path: string) {
  if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [medication], services: [service] })
  if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1, coding: { id: 'diagnosis-1', code: 'I10', display: '合成高血压', system: 'https://example.test/icd', version: '1', sourceLocator: 'synthetic-fixture' } }] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
  if (path.includes('/catalog-search?')) return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 1, items: [{ id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication }] })
  if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
  throw new Error(`Unexpected read ${path}`)
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function pickMedication(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole('textbox', { name: '医嘱项目' }), '合成')
  await user.click(await within(await screen.findByRole('region', { name: '医嘱项目候选' })).findByRole('button', { name: /合成药品/ }))
}

it('医生可编辑每次剂量，明确换算数量并阻止不整片或超上限提交', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reads(path)))
  mount()
  const user = userEvent.setup()
  await pickMedication(user)
  const dose = screen.getByRole('textbox', { name: '每次剂量' })
  await user.clear(dose)
  await user.type(dose, '10 mg')
  expect(screen.getByText('= 2 片')).toBeDefined()
  expect(screen.getByRole('button', { name: "开立医嘱" }).hasAttribute('disabled')).toBe(false)
  await user.clear(dose)
  await user.type(dose, '7.5 mg')
  expect(screen.getByText('本次用量无法换算为完整制剂数量')).toBeDefined()
  expect(screen.getByRole('button', { name: "开立医嘱" }).hasAttribute('disabled')).toBe(true)
  await user.clear(dose)
  await user.type(dose, '3片')
  expect(screen.getByText('本次用量超过已声明的每次上限')).toBeDefined()
})

it('非法剂量单位显示错误，医生改回合法值后可以继续签发', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => reads(path)))
  mount()
  const user = userEvent.setup()
  await pickMedication(user)
  const dose = screen.getByRole('textbox', { name: '每次剂量' })
  await user.clear(dose)
  await user.type(dose, '1 constructor')
  expect(screen.getByText('本次剂量单位与已声明的换算不匹配')).toBeDefined()
  expect(screen.getByRole('button', { name: "开立医嘱" }).hasAttribute('disabled')).toBe(true)
  await user.clear(dose)
  await user.type(dose, '10 mg')
  expect(screen.queryByText('本次剂量单位与已声明的换算不匹配')).toBeNull()
  expect(screen.getByText('= 2 片')).toBeDefined()
  expect(screen.getByRole('button', { name: "开立医嘱" }).hasAttribute('disabled')).toBe(false)
})

it('药品按院内目录检索，暂不能开立的项目折叠并写明原因，只有完整院内项目可以选择', async () => {
  const searches: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (!path.includes('/catalog-search?')) return reads(path)
    const url = new URL(path, 'http://localhost')
    searches.push(url)
    return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 3, items: [
      { id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication },
      { id: 'incomplete-medication', display: '待补合成产品', status: 'incomplete', missingFields: ['unit', 'price'] },
      { id: 'inactive-medication', display: '停用产品', status: 'inactive', missingFields: [] }] })
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查询' }))
  const suggestions = await screen.findByRole('region', { name: '医嘱项目候选' })
  await user.click(await within(suggestions).findByRole('button', { name: '另有 2 项暂不能开立 · 查看原因' }))
  expect(suggestions.textContent).toContain('待补合成产品暂不能开立：缺发药单位、缺院内价格')
  expect(suggestions.textContent).toContain('停用产品暂不能开立：已停用')
  expect(within(suggestions).queryByRole('button', { name: /待补合成产品|停用产品/ })).toBeNull()
  await user.type(screen.getByRole('textbox', { name: '医嘱项目' }), '合成')
  expect(searches.every(url => url.searchParams.get('source') === 'hospital')).toBe(true)
  expect(searches.at(-1)?.searchParams.get('query')).toBe('合成')
  await user.click(await within(screen.getByRole('region', { name: '医嘱项目候选' })).findByRole('button', { name: /合成药品/ }))
  expect(screen.getByRole('textbox', { name: '每次剂量' }).hasAttribute('disabled')).toBe(false)
})

it('目录加载失败保留护理项目候选与重试入口，恢复后的无结果另行说明', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (!path.includes('/catalog-search?')) return reads(path)
    if (fail) return Response.json({ error: { code: 'REFERENCE_DATA_UNAVAILABLE', message: 'Reference unavailable' } }, { status: 503 })
    return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 0, items: [] })
  }))
  mount()
  const user = userEvent.setup()
  const input = await screen.findByRole('textbox', { name: '医嘱项目' })
  await user.type(input, '合成护理')
  const suggestions = await screen.findByRole('region', { name: '医嘱项目候选' })
  expect((await within(suggestions).findByRole('alert')).textContent).toContain('药品目录查询失败')
  expect(within(suggestions).getByRole('button', { name: /合成护理项目/ })).toBeDefined()
  await user.clear(input)
  await user.type(input, '无此药')
  const emptySuggestions = await screen.findByRole('region', { name: '医嘱项目候选' })
  expect((await within(emptySuggestions).findByRole('alert')).textContent).toContain('药品目录查询失败')
  expect(within(emptySuggestions).queryByText('没有匹配的项目。')).toBeNull()
  fail = false
  await user.click(within(emptySuggestions).getByRole('button', { name: '重试目录查询' }))
  await within(emptySuggestions).findByText('没有匹配的项目。')
  expect(within(emptySuggestions).queryByRole('alert')).toBeNull()
})
