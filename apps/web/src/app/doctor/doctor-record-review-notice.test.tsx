// @vitest-environment jsdom
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

it('asks the doctor to review an existing record only when a newer authorized fact exists', async () => {
  const client = new QueryClient()
  clients.push(client)
  const review = vi.fn()
  const recordTime = '2026-10-18T09:00:00+08:00'
  const detail = doctorCaseDetailSchema.parse({
    caseId: 'synthetic-review-case', allergies: [], priorFacts: [], presentation: null, status: 'first-visit', taskId: 'task-review', taskVersion: '1',
    patient: { id: 'patient-review', identifier: 'SYN-REVIEW', name: '合成核对患者', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
    encounter: { id: 'encounter-review', status: 'in-progress', versionId: '1' }, consultation: { version: 1, turns: [] },
  })
  const view = (messageTime: string, caseId = detail.caseId, authoredAt: string | null = recordTime) => <QueryClientProvider client={client}>
    <DoctorPreparationProvider detail={{ ...detail, consultation: { version: 2, turns: [{
      id: 'turn-review', kind: 'text', messageText: '合成患者补充新症状。', actorId: null, practitionerId: null,
      personaRevision: 1, recordedAt: messageTime, reportReference: null, sequence: 1, source: 'patient-agent', speaker: 'patient',
    }] } }} enabled={false} scope="workspace:epoch:doctor:review" inputRevision={messageTime}>
      <DoctorRecordReviewNotice caseId={caseId} authoredAt={authoredAt ?? undefined} locale="zh-CN" onReview={review} />
    </DoctorPreparationProvider></QueryClientProvider>
  const rendered = render(view('2026-10-18T08:59:00+08:00'))
  expect(screen.queryByText('有新资料，请核对这条记录。')).toBeNull()
  rendered.rerender(view('2026-10-18T09:01:00+08:00'))
  expect(screen.getByText('有新资料，请核对这条记录。')).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: '查看记录' }))
  expect(review).toHaveBeenCalledOnce()
  rendered.rerender(view('2026-10-18T09:01:00+08:00', 'other-case'))
  expect(screen.queryByText('有新资料，请核对这条记录。')).toBeNull()
  rendered.rerender(view('2026-10-18T09:01:00+08:00', detail.caseId, null))
  // A record without a trustworthy creation time cannot be declared older than new information.
  expect(screen.queryByText('有新资料，请核对这条记录。')).toBeNull()
})
