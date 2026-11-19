import { calculateCkdEpi2021Egfr } from '@clinmesh/core/clinical-scores'
import { nonIschemicPciFindings } from '@clinmesh/core/clinical-quality'
import { describe, expect, it } from 'vitest'
import {
  AuthoredCasePackCompileError,
  compileAuthoredCase,
  compileAuthoredCasePack,
} from '../src/application/scenario-data/authored-case-pack-compiler.ts'
import {
  cardiorenalAuthoredCasePackDefinition,
  compiledCardiorenalAuthoredCasePack,
} from '../src/application/scenario-data/cardiorenal-authored-case-pack.ts'
import { buildTruthStagePriority } from '../src/application/scenario-data/truth-stage.ts'

describe('AuthoredCasePackCompiler', () => {
  it('compiles all 5 specialist cases deterministically with male/female, 0/1 stents, visible history, and exact clinical math', () => {
    const second = compileAuthoredCasePack(cardiorenalAuthoredCasePackDefinition)
    expect(second.contentHash).toBe(compiledCardiorenalAuthoredCasePack.contentHash)
    expect(compiledCardiorenalAuthoredCasePack.cases).toHaveLength(5)

    const genders = new Set(compiledCardiorenalAuthoredCasePack.cases.map(c => c.definition.patient.gender))
    expect(genders).toEqual(new Set(['male', 'female']))

    const stents = new Set(compiledCardiorenalAuthoredCasePack.cases.map(c => c.definition.plannedStentCount))
    expect(stents).toEqual(new Set([0, 1]))

    const entries = compiledCardiorenalAuthoredCasePack.cases.map(c => [c.definition.id, c.definition.recommendedEntry])
    expect(entries).toEqual([
      ['cardio-nstemi-chest-pain-v1', 'outpatient'],
      ['cardio-elective-lad-pci-v1', 'inpatient'],
      ['cardio-borderline-ffr-gdmt-v1', 'inpatient'],
      ['cardio-cad-ckd3b-hydration-pci-v1', 'inpatient'],
      ['renal-t2dm-htn-ckd4-control-v1', 'outpatient'],
    ])

    for (const item of compiledCardiorenalAuthoredCasePack.cases) {
      expect(item.compiled.visibleHistory.length).toBeGreaterThan(0)
      expect(item.compiled.hiddenResourceReferences.length).toBeGreaterThan(0)
    }

    // Case 4: 68yo male, Scr 175 -> eGFR 36.1 (G3b); repeat Scr 168 -> eGFR 37.9 (G3b)
    const case4Egfr = calculateCkdEpi2021Egfr({
      ageYears: 68,
      serumCreatinine: { unit: 'umol/L', value: 175 },
      sex: 'male',
    })
    expect(case4Egfr.tierCode).toBe('G3b')
    expect(case4Egfr.value).toBeCloseTo(36.1, 1)

    const case4RepeatEgfr = calculateCkdEpi2021Egfr({
      ageYears: 68,
      serumCreatinine: { unit: 'umol/L', value: 168 },
      sex: 'male',
    })
    expect(case4RepeatEgfr.tierCode).toBe('G3b')
    expect(case4RepeatEgfr.value).toBeCloseTo(37.9, 1)

    // Case 5: 64yo female, Scr 184.6 -> eGFR 26.0 (G4, <30 red-line)
    const case5Egfr = calculateCkdEpi2021Egfr({
      ageYears: 64,
      serumCreatinine: { unit: 'umol/L', value: 184.6 },
      sex: 'female',
    })
    expect(case5Egfr.tierCode).toBe('G4')
    expect(case5Egfr.value).toBeCloseTo(26.0, 1)
    expect(case5Egfr.value).toBeLessThan(30)

    // Case 3: borderline LAD 60% FFR 0.86 triggers PCI_NON_ISCHEMIC_LESION
    const case3 = compiledCardiorenalAuthoredCasePack.cases[2]!.definition
    expect(case3.patient.gender).toBe('female')
    expect(case3.angiography?.qca).toBeUndefined()
    const pciAlerts = nonIschemicPciFindings(case3.angiography!.vessels, {
      label: '冠脉造影报告',
      reference: 'DiagnosticReport/angio-case-3',
      versionId: '1',
    })
    expect(pciAlerts.map(item => item.code)).toEqual(['PCI_NON_ISCHEMIC_LESION'])

    // Case 5: outpatient-only, no angiography
    expect(compiledCardiorenalAuthoredCasePack.cases[4]!.definition.angiography).toBeUndefined()
  })

  it('rejects a persona that leaks an undiagnosed hidden condition', () => {
    const baseCase = cardiorenalAuthoredCasePackDefinition.cases[0]!
    expect(() => compileAuthoredCase({
      ...baseCase,
      persona: {
        ...baseCase.persona,
        content: {
          ...baseCase.persona.content,
          openingStatement: '医生，我得了急性非ST段抬高型心肌梗死。',
        },
      },
    })).toThrowError(AuthoredCasePackCompileError)
  })

  it('rejects visible history timestamps at or after indexDateTime and duplicate exam stages', () => {
    const baseCase = compiledCardiorenalAuthoredCasePack.cases[0]!.definition
    expect(() => compileAuthoredCase({
      ...baseCase,
      visibleHistory: [{
        ...baseCase.visibleHistory[0]!,
        encounterDateTime: baseCase.indexDateTime,
      }],
    })).toThrowError(/VISIBLE_HISTORY_AFTER_INDEX|must precede indexDateTime/)

    expect(() => compileAuthoredCase({
      ...baseCase,
      ecgs: [baseCase.ecgs[0]!, baseCase.ecgs[0]!],
    })).toThrowError(/duplicate ECG entries/)
  })

  it('rejects duplicate case IDs or patient IDs within a pack', () => {
    const first = cardiorenalAuthoredCasePackDefinition.cases[0]!
    expect(() => compileAuthoredCasePack({
      ...cardiorenalAuthoredCasePackDefinition,
      cases: [first, { ...first, patient: { ...first.patient, id: 'other-patient' } }],
    })).toThrowError(/Duplicate authored case id/)

    expect(() => compileAuthoredCasePack({
      ...cardiorenalAuthoredCasePackDefinition,
      cases: [first, { ...first, id: 'other-case-id' }],
    })).toThrowError(/Duplicate authored patient id/)
  })

  it('never routes post-discharge revisits into inpatient repeat stage truth', () => {
    expect(buildTruthStagePriority({ isInpatient: false, isRepeat: false, isRevisit: true })).toEqual(['follow-up', undefined])
    expect(buildTruthStagePriority({ isInpatient: false, isRepeat: true, isRevisit: true })).toEqual(['follow-up', undefined])
    expect(buildTruthStagePriority({ isInpatient: true, isRepeat: true, isRevisit: false })).toEqual(['repeat', 'inpatient', 'initial', undefined])
    expect(buildTruthStagePriority({ isInpatient: false, isRepeat: true, isRevisit: false })).toEqual(['repeat', 'initial', undefined])
  })
})
