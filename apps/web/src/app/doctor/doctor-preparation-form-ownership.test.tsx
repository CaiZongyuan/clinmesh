// @vitest-environment jsdom
import { doctorRecommendationStateSchema } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DoctorRecommendationsPanel, type ManualPreparedItem } from './doctor-recommendations.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

it.each(['empty', 'older'] as const)('restores unsaved form-owned edits after remounting from an %s persisted draft', async persisted => {
  const state = doctorRecommendationStateSchema.parse({ caseId: 'synthetic-case', kind: 'prescription',
    encounterId: 'synthetic-encounter', encounterVersion: '1', inputFingerprint: 'a'.repeat(64),
    generation: 1, status: 'ready', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(state)))
  const item: ManualPreparedItem = { label: '医生原选药品', value: { source: 'manual', kind: 'prescription',
    catalogItemId: 'synthetic-medication-a', doseText: '5 mg', frequencyCode: 'QD', courseDays: 7, quantity: 7 } }
  function ManualForm({ initial }: { initial: ManualPreparedItem[] }) {
    const [items, setItems] = useState(initial)
    return <><output aria-label="原表单剂量">{items.map(item => item.value.kind === 'prescription' ? item.value.doseText : '').join(',')}</output>
      <DoctorRecommendationsPanel caseId="synthetic-case" kind="prescription" enabled scope="synthetic-scope"
        manualItems={items} onManualChange={item => { setItems([item]); return true }} />
    </>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = (show: boolean, initial: ManualPreparedItem[]) => <QueryClientProvider client={client}>
    <DoctorPreparationProvider caseId="synthetic-case" scope="synthetic-scope" detail={undefined} enabled inputRevision="1">
      {show ? <ManualForm initial={initial} /> : null}
    </DoctorPreparationProvider>
  </QueryClientProvider>
  const mounted = render(view(true, [item])); const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: '选择医生原选药品' })
  await user.click(screen.getByRole('button', { name: '调整' }))
  fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  expect(screen.getByLabelText('原表单剂量').textContent).toBe('10 mg')
  mounted.rerender(view(false, []))
  mounted.rerender(view(true, persisted === 'empty' ? [] : [item]))
  expect(screen.getByRole('checkbox', { name: '选择医生原选药品' })).toBeTruthy()
  await waitFor(() => expect(screen.getByLabelText('原表单剂量').textContent).toBe('10 mg'))
})

it.each(['remove', 'replace'] as const)('does not restore a cached row after the physician form chooses to %s it', async change => {
  const state = doctorRecommendationStateSchema.parse({ caseId: 'synthetic-case', kind: 'prescription',
    encounterId: 'synthetic-encounter', encounterVersion: '1', inputFingerprint: 'a'.repeat(64),
    generation: 1, status: 'ready', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] })
  const submitted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/actions/confirm')) {
      submitted.push(JSON.parse(String(init?.body)))
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-command', effects: [], warnings: [],
        data: { kind: 'prescription', draftVersion: 2, encounterVersion: '1', recordIds: ['synthetic-prescription'] } })
    }
    return Response.json(state)
  }))
  const item: ManualPreparedItem = { label: '医生原选药品', value: { source: 'manual', kind: 'prescription',
    catalogItemId: 'synthetic-medication-a', doseText: '5 mg', frequencyCode: 'QD', courseDays: 7, quantity: 7 } }
  const replacement: ManualPreparedItem = { label: '医生更换药品', value: { ...item.value, kind: 'prescription', source: 'manual',
    catalogItemId: 'synthetic-medication-b', doseText: '20 mg', frequencyCode: 'QD', courseDays: 7, quantity: 7 } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = (manualItems: ManualPreparedItem[]) => <QueryClientProvider client={client}>
    <DoctorRecommendationsPanel caseId="synthetic-case" kind="prescription" enabled scope="synthetic-scope"
      encounter={{ id: 'synthetic-encounter', versionId: '1' }} onManualChange={() => true} manualItems={manualItems} />
  </QueryClientProvider>
  const mounted = render(view([item])); const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: '选择医生原选药品' })
  await user.click(screen.getByRole('button', { name: '调整' }))
  fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  mounted.rerender(view([{ ...item, value: { ...item.value, kind: 'prescription', source: 'manual',
    catalogItemId: 'synthetic-medication-a', doseText: '10 mg', frequencyCode: 'QD', courseDays: 7, quantity: 7 } }]))
  expect(screen.getByText(/10 mg/)).toBeTruthy()
  mounted.rerender(view(change === 'remove' ? [] : [replacement]))
  expect(screen.queryByRole('checkbox', { name: '选择医生原选药品' })).toBeNull()
  const issue = screen.getByRole('button', { name: /^开具处方/ })
  if (change === 'remove') {
    expect(issue).toHaveProperty('disabled', true)
    expect(submitted).toHaveLength(0)
  } else {
    expect(screen.getByRole('checkbox', { name: '选择医生更换药品' }).getAttribute('aria-checked')).toBe('true')
    await user.click(issue)
    await waitFor(() => expect(submitted).toEqual([{ expectedVersions: { 'Encounter/synthetic-encounter': '1' }, input: {
      expectedDraftVersion: 0, selections: [replacement.value],
    } }]))
  }
})
