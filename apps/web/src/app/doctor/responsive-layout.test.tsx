// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { DoctorCasePanel } from './responsive-layout.tsx'

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
