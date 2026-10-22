// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { DoctorCasePanel, DoctorWorkspaceLayout } from './responsive-layout.tsx'

afterEach(cleanup)

it('retains diagnosis and prescription input across section changes without mounting consultation or record work', () => {
  const consultationMounted = vi.fn(), recordMounted = vi.fn()
  function Draft({ label, onMount }: { label: string; onMount?: () => void }) {
    const [value, setValue] = useState('')
    useEffect(() => { onMount?.() }, [onMount])
    return <input aria-label={label} value={value} onChange={event => setValue(event.currentTarget.value)} />
  }
  render(<Tabs defaultValue="diagnosis">
    <TabsList>{['diagnosis', 'prescription', 'consultation', 'record'].map(value => <TabsTrigger key={value} value={value}>{value}</TabsTrigger>)}</TabsList>
    <DoctorCasePanel keepMounted value="diagnosis"><Draft label="诊断备注" /></DoctorCasePanel>
    <DoctorCasePanel keepMounted value="prescription"><Draft label="药品剂量" /></DoctorCasePanel>
    <DoctorCasePanel value="consultation"><Draft label="问诊输入" onMount={consultationMounted} /></DoctorCasePanel>
    <DoctorCasePanel value="record"><Draft label="病历输入" onMount={recordMounted} /></DoctorCasePanel>
  </Tabs>)
  fireEvent.change(screen.getByRole('textbox', { name: '诊断备注' }), { target: { value: '尚未自动保存的诊断备注' } })
  fireEvent.click(screen.getByRole('tab', { name: 'prescription' }))
  fireEvent.change(screen.getByRole('textbox', { name: '药品剂量' }), { target: { value: '尚未自动保存的药品剂量' } })
  fireEvent.click(screen.getByRole('tab', { name: 'diagnosis' }))
  expect(screen.getByRole('textbox', { name: '诊断备注' })).toHaveProperty('value', '尚未自动保存的诊断备注')
  expect(screen.queryByRole('textbox', { name: '药品剂量' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'prescription' }))
  expect(screen.getByRole('textbox', { name: '药品剂量' })).toHaveProperty('value', '尚未自动保存的药品剂量')
  expect(consultationMounted).not.toHaveBeenCalled()
  expect(recordMounted).not.toHaveBeenCalled()
})

it('mounts the legacy revisit form only in its active section by default', () => {
  const mounted = vi.fn()
  function RevisitForm() {
    useEffect(mounted, [])
    return <input aria-label="复诊评估" id="legacy-revisit-assessment" />
  }
  render(<Tabs defaultValue="diagnosis">
    <TabsList><TabsTrigger value="diagnosis">diagnosis</TabsTrigger><TabsTrigger value="prescription">prescription</TabsTrigger></TabsList>
    <DoctorCasePanel value="diagnosis"><RevisitForm /></DoctorCasePanel>
    <DoctorCasePanel value="prescription"><RevisitForm /></DoctorCasePanel>
  </Tabs>)
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(document.querySelectorAll('#legacy-revisit-assessment')).toHaveLength(1)
  fireEvent.click(screen.getByRole('tab', { name: 'prescription' }))
  expect(document.querySelectorAll('#legacy-revisit-assessment')).toHaveLength(1)
})

describe('DoctorWorkspaceLayout', () => {
  function renderWorkspace(overrides?: { selectedCaseId?: string; suggestions?: { label: string; node: React.ReactNode } }) {
    const props = {
      queueLabel: '候诊队列',
      detailLabel: '病例详情',
      selectedCaseId: overrides?.selectedCaseId,
      suggestions: overrides?.suggestions,
      queue: (showDetail: () => void) => <button onClick={showDetail}>选择患者</button>,
      children: <p>病例内容</p>,
    }
    return render(<DoctorWorkspaceLayout {...props} />)
  }

  it('keeps queue and detail focus on container-query collapse classes', () => {
    const { rerender } = renderWorkspace()
    const queueRegion = document.querySelector('[data-doctor-region="queue"]')
    const detailRegion = document.querySelector('[data-doctor-region="detail"]')
    expect(queueRegion).not.toBeNull()
    expect(detailRegion).not.toBeNull()
    expect(queueRegion?.className).not.toContain('@max-[720px]/doctor-workspace:hidden')
    expect(detailRegion?.className).toContain('@max-[720px]/doctor-workspace:hidden')
    expect(screen.getByRole('button', { name: '候诊队列' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '病例详情' }))
    expect(screen.getByRole('button', { name: '病例详情' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '候诊队列' }).getAttribute('aria-pressed')).toBe('false')
    expect(queueRegion?.className).toContain('@max-[720px]/doctor-workspace:hidden')
    expect(detailRegion?.className).not.toContain('@max-[720px]/doctor-workspace:hidden')

    rerender(<DoctorWorkspaceLayout
      queueLabel="候诊队列"
      detailLabel="病例详情"
      selectedCaseId="case-1"
      queue={showDetail => <button onClick={showDetail}>选择患者</button>}
    ><p>病例内容</p></DoctorWorkspaceLayout>)
    expect(screen.getByRole('button', { name: '病例详情' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('renders no suggestion region or drawer toggle without suggestions', () => {
    renderWorkspace()
    expect(document.querySelectorAll('[data-doctor-region="suggestions"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '诊疗建议' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '诊疗建议' })).toBeNull()
  })

  it('renders the suggestion rail for wide containers and collapses it into a drawer on demand', async () => {
    const user = userEvent.setup()
    renderWorkspace({ suggestions: { label: '诊疗建议', node: <p>完诊还差 2 项</p> } })
    const rail = screen.getByRole('complementary', { name: '诊疗建议' })
    expect(rail.className).toContain('hidden')
    expect(rail.className).toContain('@min-[1080px]/doctor-workspace:block')
    expect(screen.getAllByText('完诊还差 2 项')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: '诊疗建议' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '诊疗建议' }))
    const drawer = await screen.findByRole('dialog', { name: '诊疗建议' })
    expect(within(drawer).getByText('完诊还差 2 项')).toBeTruthy()

    await user.click(within(drawer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: '诊疗建议' })).toBeNull()
    expect(screen.getAllByText('完诊还差 2 项')).toHaveLength(1)
  })
})

it('renders the floating queue rail in place of the queue column when provided', () => {
  render(<DoctorWorkspaceLayout
    detailLabel="病例详情"
    queue={() => <button>选择患者</button>}
    queueFloating={<button>候诊队列 · 3 例</button>}
    queueLabel="候诊队列"
  ><p>病例内容</p></DoctorWorkspaceLayout>)
  expect(document.querySelector('[data-doctor-region="queue"]')).toBeNull()
  expect(document.querySelector('[data-doctor-region="queue-rail"]')).not.toBeNull()
  expect(screen.queryByRole('group', { name: '候诊队列' })).toBeNull()
  expect(screen.getByRole('button', { name: '候诊队列 · 3 例' })).toBeTruthy()
  expect(screen.getByText('病例内容')).toBeTruthy()
})
