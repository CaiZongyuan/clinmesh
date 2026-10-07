// @vitest-environment jsdom
import { doctorCaseDetailSchema, doctorQueueSchema } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorQueueModule } from './doctor-queue-module.tsx'
import { DoctorWorkspaceLayout } from './responsive-layout.tsx'

afterEach(() => { cleanup() })

const messages = getWorkspaceMessages('zh-CN')

function queuePage() {
  const detail = doctorCaseDetailSchema.parse({
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

function renderQueue() {
  const data = queuePage()
  return render(
    <DoctorQueueModule
      activeCaseId={data.items[0]!.caseId}
      messages={messages}
      navigation={<div data-testid="queue-navigation">在诊 待诊 完诊</div>}
      onQueuePageChange={() => {}}
      onSelectCase={() => {}}
      queueData={{ items: data.items, page: data.page, pageSize: data.pageSize, total: data.total }}
      queueError={null}
      queuePending={false}
      queueView="active"
    />,
  )
}

function commonAncestor(a: Element, b: Element): Element | null {
  const seen = new Set<Element>()
  for (let node: Element | null = a; node !== null; node = node.parentElement) seen.add(node)
  for (let node: Element | null = b; node !== null; node = node.parentElement) {
    if (seen.has(node)) return node
  }
  return null
}

describe('DoctorQueueModule 紧凑布局', () => {
  it('不再有独立的「在诊 + 计数」标题行', () => {
    renderQueue()
    expect(screen.queryByRole('heading', { name: '在诊', level: 2 })).toBeNull()
  })

  it('计数徽章与队列导航同处 tab 行，而不是单独一行', () => {
    renderQueue()
    const navigation = screen.getByTestId('queue-navigation')
    const count = screen.getByLabelText(messages.doctorQueueCount.replace('{count}', '1'))
    const shared = commonAncestor(navigation, count)
    expect(shared).not.toBeNull()
    expect(shared).not.toBe(screen.getByRole('complementary', { name: messages.consultationQueue }))
  })

  it('病例卡片仍按原有可访问名称可选', () => {
    renderQueue()
    expect(screen.getByRole('button', { name: '选择病例 孙兵' })).toBeTruthy()
  })

  it('桌面布局中队列列宽为 200px', () => {
    render(
      <DoctorWorkspaceLayout detailLabel="病例详情" queue={() => <div />} queueLabel="候诊队列" selectedCaseId={undefined}>
        <div />
      </DoctorWorkspaceLayout>,
    )
    const grid = document.querySelector('div[style*="grid-template-columns"]')
    expect(grid).not.toBeNull()
    expect(grid!.getAttribute('style')).toContain('200px')
  })
})
