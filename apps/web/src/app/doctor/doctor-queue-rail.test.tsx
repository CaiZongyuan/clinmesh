// @vitest-environment jsdom
import { doctorCaseDetailSchema, doctorQueueSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorQueueRail } from './doctor-queue-rail.tsx'

afterEach(() => { cleanup() })

const messages = getWorkspaceMessages('zh-CN')

function queuePage() {
  const detail = doctorCaseDetailSchema.parse({
    registrationNumber: null,
    allergies: [],
    caseId: 'queue-compact-0',
    consultation: { turns: [], version: 1 },
    encounter: { id: 'queue-encounter-0', status: 'in-progress', versionId: '1' },
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
    patient: {
      id: 'queue-patient-0', identifier: 'SYN-QUEUE-0', name: '孙兵',
      gender: 'male', synthetic: true, versionId: '1',
    },
    presentation: {
      chiefComplaint: '不舒服', summary: '不舒服',
      vitalSigns: {
        temperatureC: 37, pulseBpm: 92, respirationBpm: 18,
        bloodPressure: { systolicMmHg: 118, diastolicMmHg: 78 }, oxygenSaturationPct: 98,
      },
    },
    priorFacts: [], status: 'first-visit', taskId: 'queue-task-0', taskVersion: '1',
  })
  return doctorQueueSchema.parse({
    items: [{ ...detail, encounterId: detail.encounter.id, encounterVersion: '1' }],
    page: 1, pageSize: 20, total: 1, hasNextPage: false,
  })
}

function renderRail(overrides?: { onSelectCase?: (caseId: string) => void }) {
  const data = queuePage()
  return render(
    <DoctorQueueRail
      activeCaseId={data.items[0]!.caseId}
      messages={messages}
      navigation={<div data-testid="queue-navigation">在诊 待诊 完诊</div>}
      onQueuePageChange={() => {}}
      onSelectCase={overrides?.onSelectCase ?? (() => {})}
      queueData={{ items: data.items, page: data.page, pageSize: data.pageSize, total: data.total }}
      queueError={null}
      queuePending={false}
      queueView="active"
    />,
  )
}

it('presents the collapsed rail handle with a scannable queue count and no patient list', () => {
  renderRail()
  const handle = screen.getByRole('button', { name: '候诊队列 · 1 例' })
  expect(handle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: '选择病例 孙兵' })).toBeNull()
})

it('expands the patient list on the handle and collapses after selecting a case', async () => {
  const user = userEvent.setup()
  const onSelectCase = vi.fn()
  renderRail({ onSelectCase })
  await user.click(screen.getByRole('button', { name: '候诊队列 · 1 例' }))
  expect(screen.getByRole('button', { name: '选择病例 孙兵' })).toBeTruthy()
  expect(screen.getByTestId('queue-navigation')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '选择病例 孙兵' }))
  expect(onSelectCase).toHaveBeenCalledWith('queue-compact-0')
  expect(screen.queryByRole('button', { name: '选择病例 孙兵' })).toBeNull()
})
