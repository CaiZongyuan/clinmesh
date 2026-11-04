// @vitest-environment jsdom
import { doctorCaseDetailSchema, doctorQueueSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorQueueModule } from './doctor-queue-module.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

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

function renderQueue(onSelectCase = () => {}) {
  const data = queuePage()
  data.items[0]!.registrationNumber = 'CM-OP-20261104-000001'
  return render(
    <DoctorQueueModule
      activeCaseId={data.items[0]!.caseId}
      messages={messages}
      navigation={<div data-testid="queue-navigation">在诊 待诊 完诊</div>}
      onQueuePageChange={() => {}}
      onSelectCase={onSelectCase}
      queueData={{ items: data.items, page: data.page, pageSize: data.pageSize, total: data.total }}
      queueError={null}
      queuePending={false}
      queueView="active"
    />,
  )
}

describe('DoctorQueueModule 紧凑布局', () => {
  it('不再有独立的「在诊 + 计数」标题行', () => {
    renderQueue()
    expect(screen.queryByRole('heading', { name: '在诊', level: 2 })).toBeNull()
  })

  it('队列导航不再重复显示当前队列总数', () => {
    renderQueue()
    expect(screen.getByTestId('queue-navigation')).toBeTruthy()
    expect(screen.queryByLabelText(messages.doctorQueueCount.replace('{count}', '1'))).toBeNull()
  })

  it('病例卡片仍按原有可访问名称可选', () => {
    renderQueue()
    expect(screen.getByRole('button', { name: '选择病例 孙兵' })).toBeTruthy()
  })

  it('在患者卡内复制完整门诊号，复制不改变病例选择', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const select = vi.fn()
    renderQueue(select)
    await user.click(screen.getByRole('button', { name: '复制门诊号 CM-OP-20261104-000001' }))
    expect(copy).toHaveBeenCalledWith('CM-OP-20261104-000001')
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(messages.registrationNumberCopied)
    await user.click(screen.getByRole('button', { name: '选择病例 孙兵' }))
    expect(select).toHaveBeenCalledWith('queue-compact-0')
  })

})
