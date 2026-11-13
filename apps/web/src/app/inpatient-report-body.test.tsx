// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { laboratoryReportSchema } from '@clinmesh/contracts/his'
import { LaboratoryReportVersion } from './doctor/laboratory-page.tsx'
import { InpatientLabReportTable } from './inpatient-report-body.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

afterEach(cleanup)

const sampleReport = laboratoryReportSchema.parse({
  conclusion: '心脏标志物与电解质异常',
  diagnosticReportId: 'dr-1',
  diagnosticReportVersion: '1',
  issuedAt: '2026-11-12T08:00:00+08:00',
  results: [
    {
      code: '2100404B',
      critical: true,
      display: '高敏心肌肌钙蛋白I测定',
      interpretation: 'high',
      observationId: 'obs-hs-ctni',
      referenceRange: { high: 34, text: '≤ 34 ng/L' },
      unit: { code: 'ng/L', display: 'ng/L', system: 'http://unitsofmeasure.org' },
      value: 280,
    },
    {
      code: '1400605A',
      critical: false,
      display: '钾测定',
      interpretation: 'normal',
      observationId: 'obs-k',
      referenceRange: { high: 5.3, low: 3.5, text: '3.5 - 5.3 mmol/L' },
      unit: { code: 'mmol/L', display: 'mmol/L', system: 'http://unitsofmeasure.org' },
      value: 4.2,
    },
  ],
  revisionNumber: 1,
  specimenId: 'sp-1',
  status: 'final',
})

it('renders compact critical badge in inpatient and outpatient laboratory report tables only when critical is true', () => {
  const { rerender } = render(<InpatientLabReportTable locale="zh-CN" report={sampleReport} />)
  expect(screen.getAllByText('危急值')).toHaveLength(1)
  expect(screen.getByText('偏高 ↑')).toBeDefined()

  rerender(<InpatientLabReportTable locale="en-US" report={sampleReport} />)
  expect(screen.getAllByText('Critical')).toHaveLength(1)

  rerender(
    <LaboratoryReportVersion
      current
      locale="zh-CN"
      messages={getWorkspaceMessages('zh-CN')}
      report={sampleReport}
    />,
  )
  expect(screen.getAllByText('危急值')).toHaveLength(1)
})
