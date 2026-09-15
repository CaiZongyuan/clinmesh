// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceHistoryDetail } from './source-history-detail.tsx'

afterEach(cleanup)

describe('source history details', () => {
  it('shows observation components, units, ranges and zero results', () => {
    render(<SourceHistoryDetail locale="zh-CN" resource={{
      resourceType: 'Observation', code: { text: '血压' }, status: 'final',
      effectiveDateTime: '2026-07-01T09:00:00+08:00',
      component: [{ code: { text: '收缩压' }, valueQuantity: { value: 120, unit: 'mmHg' },
        referenceRange: [{ low: { value: 90, unit: 'mmHg' }, high: { value: 140, unit: 'mmHg' } }] }],
      valueInteger: 0,
    }} />)
    expect(screen.getByText('最终')).toBeTruthy()
    expect(screen.getByText('2026/07/01 09:00:00')).toBeTruthy()
    expect(screen.getByText('收缩压')).toBeTruthy()
    expect(screen.getByText('120 mmHg')).toBeTruthy()
    expect(screen.getByText(/90 mmHg — 140 mmHg/)).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
  })

  it('shows medication name, dose, route and frequency', () => {
    render(<SourceHistoryDetail locale="zh-CN" resource={{
      resourceType: 'MedicationRequest', medicationCodeableConcept: { text: '合成示例药品' },
      status: 'active', authoredOn: '2026-07-01', dosageInstruction: [{
        text: '饭后服用', route: { text: '口服' }, timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
        doseAndRate: [{ doseQuantity: { value: 1, unit: '片' } }],
      }],
    }} />)
    expect(screen.getByRole('heading', { name: '合成示例药品' })).toBeTruthy()
    expect(screen.getByText('饭后服用')).toBeTruthy()
    expect(screen.getByText(/口服.*2 次/)).toBeTruthy()
    expect(screen.getByText('1 片')).toBeTruthy()
  })

  it('renders false results and preserves unrecognized resources without inventing fields', () => {
    const { rerender } = render(<SourceHistoryDetail locale="en-US" resource={{ resourceType: 'Observation', valueBoolean: false }} />)
    expect(screen.getByText('No')).toBeTruthy()
    rerender(<SourceHistoryDetail locale="zh-CN" resource={{ resourceType: 'Observation', valueQuantity: { value: 37.5, unit: 'Cel' } }} />)
    expect(screen.getByText('37.5 °C')).toBeTruthy()
    rerender(<SourceHistoryDetail locale="en-US" resource={{ resourceType: 'Device', custom: { text: '<script>example</script>' } }} />)
    expect(screen.getByRole('heading', { name: 'Device' })).toBeTruthy()
    expect(screen.queryByText('Status')).toBeNull()
    expect(screen.getByText('Raw JSON').closest('details')?.open).toBe(false)
    expect(document.querySelector('script')).toBeNull()
  })

  it('keeps one-sided reference limits and dosage intervals explicit', () => {
    render(<SourceHistoryDetail locale="zh-CN" resource={{
      resourceType: 'MedicationRequest', dosageInstruction: [{ timing: { repeat: {
        frequency: 1, frequencyMax: 2, period: 4, periodMax: 6, periodUnit: 'h',
      } }, doseAndRate: [{ doseRange: { high: { value: 2, unit: '片' } } }] }],
      referenceRange: [{ low: { value: 5, unit: 'mg/L' } }],
    }} />)
    expect(screen.getByText('≥ 5 mg/L')).toBeTruthy()
    expect(screen.getByText('≤ 2 片')).toBeTruthy()
    expect(screen.getByText('每4–6 小时 / 1–2 次')).toBeTruthy()
  })

  it('tolerates missing and malformed optional clinical fields', () => {
    render(<SourceHistoryDetail locale="zh-CN" resource={{ resourceType: 'Condition',
      code: { coding: [null, { display: '合成诊断' }] }, clinicalStatus: { coding: [{ code: 'resolved' }] },
      onsetDateTime: { invalid: true }, note: [null, { text: '已复查' }],
    }} />)
    expect(screen.getByRole('heading', { name: '合成诊断' })).toBeTruthy()
    expect(screen.getByText('已缓解')).toBeTruthy()
    expect(screen.getByText('已复查')).toBeTruthy()
    expect(screen.queryByText('发生时间')).toBeNull()
    expect(screen.queryByText('[object Object]')).toBeNull()
  })
})
