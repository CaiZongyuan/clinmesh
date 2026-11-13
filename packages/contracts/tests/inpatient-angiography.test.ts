import { describe, expect, it } from 'vitest'
import {
  coronaryVesselFindingSchema,
  inpatientAngiographyReportSchema,
} from '../src/inpatient-angiography.ts'

describe('inpatientAngiographyReportSchema', () => {
  const baseReport = {
    id: '019a0000-0000-7000-8000-000000000001',
    admissionId: '019a0000-0000-7000-8000-000000000002',
    procedureId: '019a0000-0000-7000-8000-000000000003',
    version: 1,
    synthetic: true as const,
    status: 'final' as const,
    targetSite: 'LAD 中段',
    measurements: [
      {
        kind: 'lesion-length' as const,
        object: 'lesion' as const,
        site: 'LAD 中段',
        value: 12,
        unit: 'mm',
        method: '定量冠脉造影（合成）',
        source: {
          reference: 'DiagnosticReport/019a0000-0000-7000-8000-000000000001',
          version: '1',
          note: '本院合成造影报告测量',
          synthetic: true,
        },
      },
    ],
    missing: [],
    issuedAt: '2026-08-24T10:00:00+08:00',
  }

  it('defaults vessels to empty array and conclusion to null for legacy stored report payloads', () => {
    const parsed = inpatientAngiographyReportSchema.parse(baseReport)
    expect(parsed.vessels).toEqual([])
    expect(parsed.conclusion).toBeNull()
    expect(parsed.targetSite).toBe('LAD 中段')
    expect(parsed.measurements).toHaveLength(1)
  })

  it('accepts multi-vessel coronary findings with optional FFR/iFR and no stent sizing measurements', () => {
    const parsed = inpatientAngiographyReportSchema.parse({
      ...baseReport,
      targetSite: null,
      measurements: [],
      vessels: [
        {
          vessel: 'LM',
          segment: 'LM',
          stenosisPercent: 0,
          timiFlow: 3,
          lesionCharacteristics: '管壁光滑，未见明显狭窄',
        },
        {
          vessel: 'LAD',
          segment: 'pLAD',
          stenosisPercent: 60,
          timiFlow: 3,
          lesionCharacteristics: '近段弥漫性轻中度钙化病变',
          ffr: 0.86,
          ifr: 0.92,
        },
        {
          vessel: 'LCX',
          segment: 'mLCX',
          stenosisPercent: 30,
          timiFlow: 3,
          lesionCharacteristics: '偏心斑块，血流正常',
        },
        {
          vessel: 'RCA',
          segment: 'mRCA',
          stenosisPercent: 40,
          timiFlow: 3,
          lesionCharacteristics: '中段局限性斑块',
        },
      ],
      conclusion: '前降支近段中度狭窄，FFR 0.86 阴性，建议优化药物治疗，暂不行 PCI。',
    })
    expect(parsed.vessels).toHaveLength(4)
    expect(parsed.vessels[1]).toMatchObject({
      vessel: 'LAD',
      segment: 'pLAD',
      stenosisPercent: 60,
      timiFlow: 3,
      ffr: 0.86,
      ifr: 0.92,
    })
    expect(parsed.conclusion).toContain('FFR 0.86')
  })

  it('rejects out-of-range stenosis, TIMI flow, or FFR/iFR values', () => {
    expect(() =>
      coronaryVesselFindingSchema.parse({
        vessel: 'LAD',
        segment: 'pLAD',
        stenosisPercent: 105,
        timiFlow: 3,
        lesionCharacteristics: '越界狭窄',
      }),
    ).toThrow()

    expect(() =>
      coronaryVesselFindingSchema.parse({
        vessel: 'LAD',
        segment: 'pLAD',
        stenosisPercent: 60,
        timiFlow: 4,
        lesionCharacteristics: '越界 TIMI',
      }),
    ).toThrow()

    expect(() =>
      coronaryVesselFindingSchema.parse({
        vessel: 'LAD',
        segment: 'pLAD',
        stenosisPercent: 60,
        timiFlow: 3,
        lesionCharacteristics: '越界 FFR',
        ffr: 1.8,
      }),
    ).toThrow()
  })
})
