// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientReferral } from './inpatient-referral.tsx'

const session: SessionContext = {
  actor: { actorId: 'synthetic-doctor', epoch: 'epoch-1', workspaceId: 'workspace-demo', scenarioRunId: 'run-1', roleCode: 'outpatient-doctor', practitionerRoleId: 'role-doctor' },
  user: { id: 'synthetic-doctor', name: '合成医生', email: 'doctor@example.test' }, availableRoles: [],
}
const context = {
  patient: { id: 'synthetic-patient', identifier: 'SYN-1', name: '合成患者', synthetic: true as const, versionId: '1' },
  registrationNumber: 'CM-OP-20260824-000001',
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('shows the current patient, missing diagnosis and sole ward before counting the admission reason', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <InpatientReferral {...context} encounterId="synthetic-encounter" encounterVersion="3" locale="zh-CN" session={session} />
  </QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '开具住院证' }))
  const dialog = within(screen.getByRole('dialog', { name: '开具住院证' }))
  expect(dialog.getByText('合成患者')).toBeTruthy()
  expect(dialog.getByText('CM-OP-20260824-000001')).toBeTruthy()
  expect(dialog.getByText('尚未确认诊断')).toBeTruthy()
  expect(await dialog.findByText('住院病区')).toBeTruthy()
  expect(dialog.getByLabelText('收治病区').textContent).toContain('住院病区')
  expect(dialog.queryByRole('combobox', { name: '收治病区' })).toBeNull()
  expect(dialog.getByText('0 / 2000')).toBeTruthy()
  expect((dialog.getByRole('button', { name: '确认开具住院证' }) as HTMLButtonElement).disabled).toBe(true)
  await user.type(dialog.getByLabelText('住院原因'), '持续发热需住院观察')
  expect(dialog.getByText('9 / 2000')).toBeTruthy()
  expect((dialog.getByRole('button', { name: '确认开具住院证' }) as HTMLButtonElement).disabled).toBe(false)
  await user.click(dialog.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows the confirmed diagnoses and allows choosing between real receiving wards', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ wards: [
    { id: 'ward-general', name: '普通病区', organizationId: 'organization-inpatient' },
    { id: 'ward-specialist', name: '专科病区', organizationId: 'organization-inpatient' },
  ], beds: [] })))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <InpatientReferral {...context} encounterId="synthetic-encounter" encounterVersion="3" locale="zh-CN" session={session}
      diagnosisConfirmation={{ id: 'synthetic-confirmation', confirmedAt: '2026-08-24T09:00:00+08:00', provenanceId: 'synthetic-provenance', revisionNumber: 1,
        entries: [{ catalogItemId: 'synthetic-diagnosis', code: 'SYN-D1', display: '合成已确认诊断', system: 'urn:synthetic:diagnosis', role: 'primary', conditionId: 'synthetic-condition', conditionVersion: '1' }] }} />
  </QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '开具住院证' }))
  const dialog = within(screen.getByRole('dialog', { name: '开具住院证' }))
  expect(dialog.getByText('合成已确认诊断')).toBeTruthy()
  expect(dialog.queryByText('尚未确认诊断')).toBeNull()
  const wards = await dialog.findByRole('combobox', { name: '收治病区' })
  await user.click(wards)
  await user.click(await screen.findByRole('option', { name: '专科病区' }))
  expect(wards.textContent).toContain('专科病区')
})

it('keeps the dialog open while issuing, then allows leaving an unknown outcome and recovering the original receipt', async () => {
  let release: () => void = () => undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  const posts: Array<{ key: string | null; body: unknown }> = []
  let receiptKey: string | null = null
  const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: {
    referral: { id: 'synthetic-referral', patientId: context.patient.id, patientName: context.patient.name, patientVersion: '1',
      encounterId: 'synthetic-encounter', wardId: 'ward-general', reason: '持续发热需住院观察', status: 'issued', issuedAt: '2026-08-24T09:00:00+08:00' },
  } }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/inpatient/catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'http://synthetic.local').searchParams
      receiptKey = query.get('idempotencyKey')
      return Response.json({ operationId: 'inpatient.referral.issue', idempotencyKey: receiptKey, status: 'completed', response })
    }
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) })
    await pending
    throw new TypeError('synthetic committed response loss')
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <InpatientReferral {...context} encounterId="synthetic-encounter" encounterVersion="3" locale="zh-CN" session={session} />
  </QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '开具住院证' }))
  const dialog = within(screen.getByRole('dialog', { name: '开具住院证' }))
  await dialog.findByText('住院病区')
  await user.type(dialog.getByLabelText('住院原因'), '持续发热需住院观察')
  await user.click(dialog.getByRole('button', { name: '确认开具住院证' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(dialog.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
  await user.click(dialog.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('dialog', { name: '开具住院证' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: '开具住院证' })).toBeTruthy()
  await user.click(dialog.getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('dialog', { name: '开具住院证' })).toBeTruthy()

  release()
  await dialog.findByRole('alert')
  expect(dialog.getByRole('button', { name: '取消' })).toHaveProperty('disabled', false)
  await user.click(dialog.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user.click(screen.getByRole('button', { name: '开具住院证' }))
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await screen.findByRole('status', { name: '住院证交接' })
  expect(posts).toEqual([{ key: receiptKey, body: { input: {
    encounterId: 'synthetic-encounter', encounterVersion: '3', wardId: 'ward-general', reason: '持续发热需住院观察',
  } } }])
  expect(receiptKey).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
