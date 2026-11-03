// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
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
