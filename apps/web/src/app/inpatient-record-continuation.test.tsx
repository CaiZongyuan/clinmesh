// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInpatientRecordContinuation } from './inpatient-record-continuation.tsx'
import { completeInpatientReviewDraft } from './inpatient-review-draft.ts'

const session: SessionContext = { actor: { actorId: 'coder', workspaceId: 'workspace', epoch: 'epoch', scenarioRunId: 'run', practitionerRoleId: 'role', roleCode: 'medical-records' }, user: { id: 'account', name: '合成病案员', email: 'coder@demo.clinmesh.local' }, availableRoles: [] }
const reviewCommand = { operation: 'inpatient.record.review' as const, input: { admissionId: 'admission-1' } }
const archiveCommand = { operation: 'inpatient.record.archive' as const, input: { admissionId: 'admission-1' } }

const items = [1, 2, 3].map(id => inpatientAdmissionSchema.parse({ id: `admission-${id}`, patientId: `patient-${id}`, patientName: `合成病案${id}`, inpatientNumber: `ZY-${id}`, admissionRoute: 'direct', wardId: 'ward', organizationId: 'org', status: 'cleared', financialStatus: 'settled', recordStatus: 'open', registeredAt: '2026-11-03T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '1' }))
const target = items[1]!
function targetRecord() {
  const snapshot = {
    patient: { patientId: target.patientId, patientVersion: '1', identifier: 'SYN', name: target.patientName, gender: 'female', birthDate: '1980-01-01', recordNumber: null, admissionCount: 1 },
    stay: { admissionId: target.id, inpatientNumber: target.inpatientNumber, admissionRoute: 'direct', registeredAt: target.registeredAt, dischargeWardId: 'ward', dischargeOrganizationId: 'org', transfers: [], events: [] },
    clinical: { diagnosis: { revision: 1, entries: [] }, operations: [], mainProcedureExecutionId: null },
    fees: { admissionId: target.id, encounterVersion: '1', status: 'cleared', financialStatus: 'settled', charges: [], chargesFen: 0, depositFen: 0, balanceFen: 0, fingerprint: 'b'.repeat(64), transactions: [], categoryNetFen: {} },
  }
  return { admissionId: target.id, recordNumber: null, sourcesHash: 'a'.repeat(64), snapshot, revision: { revision: 1, sourcesHash: 'a'.repeat(64), snapshot, actorId: 'doctor', practitionerRoleId: 'role', recordedAt: '2026-11-03T09:00:00+08:00' }, reviews: [], reviewCurrent: false }
}
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it.each([false, true])('冻结审核下一位，当前归档与队列重排不改目标；目标失格=%s', async invalid => {
  const select = vi.fn(), refresh = vi.fn(async () => undefined), reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    reads.push(path)
    return Response.json(path.endsWith('/admissions') ? { items: items.map(item => item.id === target.id && invalid ? { ...item, recordStatus: 'reviewed' } : item) } : targetRecord())
  }))
  function Subject({ filtered = false }) {
    const write = { blocked: false, mutation: { reset: vi.fn() } }
    const continuation = useInpatientRecordContinuation(session, 'admission-1', filtered ? [items[2]!, items[0]!] : items, filtered ? 'archived' : 'open', write, select, refresh, true)
    return <><button onClick={() => continuation.beforeAction(reviewCommand)}>办理本份审核</button><button onClick={() => continuation.beforeAction(archiveCommand)}>办理本份归档</button>{continuation.content}</>
  }
  const user = userEvent.setup(), mounted = render(<Subject />)
  await user.click(screen.getByRole('button', { name: '办理本份审核' }))
  act(() => completeInpatientReviewDraft(reviewCommand, { accountId: session.user.id, actor: session.actor }))
  await screen.findByRole('button', { name: '下一份：合成病案2' })
  mounted.unmount()
  render(<Subject filtered />)
  await user.click(screen.getByRole('button', { name: '办理本份归档' }))
  act(() => completeInpatientReviewDraft(archiveCommand, { accountId: session.user.id, actor: session.actor }))
  await user.click(screen.getByRole('button', { name: '下一份：合成病案2' }))
  if (invalid) {
    await screen.findByText('目标病案状态已变化，请刷新队列后重新选择')
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '下一份：合成病案2' })).toBeDefined()
  } else await waitFor(() => expect(select).toHaveBeenCalledExactlyOnceWith(target.id, 'open'))
  expect(reads.filter(path => path.endsWith('/record'))).toEqual([`/api/his/v1/inpatient/admissions/${target.id}/record`])
  expect(refresh).toHaveBeenCalledOnce()
})
