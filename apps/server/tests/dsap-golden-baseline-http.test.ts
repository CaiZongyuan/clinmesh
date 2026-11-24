import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runDsapGoldenBaseline } from '../src/application/scenario-data/dsap-golden-baseline-runner.ts'

const currentDir = dirname(fileURLToPath(import.meta.url))
const frozenBaselinePath = resolve(currentDir, '../reference-data/dsap-golden-baseline.json')
const LEGACY_HOSPITAL_NAME = '仁' + '和'

describe('DSAP Frozen Pre-Migration Golden Baseline HTTP Verification', () => {
  it('reproduces the frozen pre-migration golden baseline with zero diff across all 10 cases, 4 gates, and strict investigation rules', async () => {
    const frozenText = readFileSync(frozenBaselinePath, 'utf8')
    expect(frozenText.endsWith('\n') && !frozenText.endsWith('\n\n')).toBe(true)
    expect(frozenText.includes(LEGACY_HOSPITAL_NAME)).toBe(false)

    const frozen = JSON.parse(frozenText) as unknown
    const actual = await runDsapGoldenBaseline()

    expect(actual.baselinePack.hospital.name).toBe('ClinMesh 临床仿真医院')
    expect(actual.baselinePack.llmInvocationCount).toBe(0)
    expect(actual.baselinePack.frozenCaseIds).toHaveLength(10)
    expect(JSON.stringify(actual).includes(LEGACY_HOSPITAL_NAME)).toBe(false)

    expect(actual.unprepopulatedEnforcement).toMatchObject({
      caseId: 'trap-low-risk-chest-wall-pain-v1',
      unprepopulatedFailures: {
        examinationTte: {
          generationError: { code: 'INVESTIGATION_UNSUPPORTED', message: '本病例未预置该检查' },
          status: 'generation-failed',
        },
        panelCoagulation: {
          generationError: { code: 'INVESTIGATION_UNSUPPORTED', message: '本病例未预置该检查' },
          status: 'generation-failed',
        },
        singleLabTsh: {
          generationError: { code: 'INVESTIGATION_UNSUPPORTED', message: '本病例未预置该检查' },
          status: 'generation-failed',
        },
      },
    })

    expect(actual.stageResolution).toMatchObject({
      caseId: 'cardio-nstemi-chest-pain-v1',
      followUp: {
        hsCtni: { code: '2100404B', interpretation: 'normal', value: 12 },
        ldl: { code: '2000404A', interpretation: 'normal', value: 1.25 },
      },
      initial: {
        hsCtni: { code: '2100404B', interpretation: 'high', value: 680 },
      },
      repeat: {
        hsCtni: { code: '2100404B', interpretation: 'high', value: 1450 },
      },
    })

    expect(actual).toEqual(frozen)
  }, 120_000)
})
