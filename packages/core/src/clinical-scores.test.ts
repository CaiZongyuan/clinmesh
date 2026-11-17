import { describe, expect, it } from 'vitest'
import { clinicalScoreBundleSchema } from '@clinmesh/contracts/clinical-scores'
import {
  calculateAscvdLdlTarget,
  calculateCkdEpi2021Egfr,
  calculateCockcroftGaultCrCl,
  calculateGraceAcs,
  calculatePreciseDapt,
  calculateTimiUaNstemi,
  evaluateClinicalScores,
  normalizeCreatinineMgDl,
  normalizeHemoglobinGdl,
  normalizeLipidMmolL,
  normalizeWbc10e9L,
} from './clinical-scores.ts'

describe('clinical-scores unit conversions and physiological bounds', () => {
  it('converts creatinine between umol/L (including μmol/L) and mg/dL and rejects extremes', () => {
    expect(normalizeCreatinineMgDl(88.4, 'umol/L')).toBeCloseTo(1.0, 4)
    expect(normalizeCreatinineMgDl(176.8, 'μmol/L')).toBeCloseTo(2.0, 4)
    expect(normalizeCreatinineMgDl(1.5, 'mg/dL')).toBeCloseTo(1.5, 4)
    expect(() => normalizeCreatinineMgDl(0, 'umol/L')).toThrow(RangeError)
    expect(() => normalizeCreatinineMgDl(5000, 'umol/L')).toThrow(RangeError)
    expect(() => normalizeCreatinineMgDl(1.0, 'mmol/L')).toThrow(RangeError)
  })

  it('converts hemoglobin between g/L and g/dL and rejects extremes', () => {
    expect(normalizeHemoglobinGdl(135, 'g/L')).toBeCloseTo(13.5, 4)
    expect(normalizeHemoglobinGdl(9.8, 'g/dL')).toBeCloseTo(9.8, 4)
    expect(() => normalizeHemoglobinGdl(10, 'g/L')).toThrow(RangeError)
    expect(() => normalizeHemoglobinGdl(300, 'g/L')).toThrow(RangeError)
  })

  it('converts WBC between 10*9/L, 10^9/L, and /uL and rejects extremes', () => {
    expect(normalizeWbc10e9L(8.5, '10*9/L')).toBeCloseTo(8.5, 4)
    expect(normalizeWbc10e9L(12.2, '10^9/L')).toBeCloseTo(12.2, 4)
    expect(normalizeWbc10e9L(11000, '/uL')).toBeCloseTo(11.0, 4)
    expect(() => normalizeWbc10e9L(0.01, '10*9/L')).toThrow(RangeError)
    expect(() => normalizeWbc10e9L(500, '10*9/L')).toThrow(RangeError)
  })

  it('converts lipids between mmol/L and mg/dL and rejects extremes', () => {
    expect(normalizeLipidMmolL(77.34, 'mg/dL', 'ldl')).toBeCloseTo(2.0, 3)
    expect(normalizeLipidMmolL(1.8, 'mmol/L', 'ldl')).toBeCloseTo(1.8, 4)
    expect(normalizeLipidMmolL(50, 'mg/dL', 'hdl')).toBeCloseTo(50 / 38.67, 3)
    expect(() => normalizeLipidMmolL(5, 'mg/dL', 'ldl')).toThrow(RangeError)
    expect(() => normalizeLipidMmolL(2000, 'mg/dL', 'tc')).toThrow(RangeError)
  })
})

describe('six deterministic clinical score formulas', () => {
  it('computes CKD-EPI 2021 eGFR identically across umol/L and mg/dL and classifies G1–G5', () => {
    const maleNormal = calculateCkdEpi2021Egfr({
      ageYears: 55,
      serumCreatinine: { unit: 'umol/L', value: 79.56 },
      sex: 'male',
    })
    const maleNormalMgDl = calculateCkdEpi2021Egfr({
      ageYears: 55,
      serumCreatinine: { unit: 'mg/dL', value: 0.9 },
      sex: 'male',
    })
    expect(maleNormal).toEqual(maleNormalMgDl)
    expect(maleNormal.tierCode).toBe('G1')

    const stageG3b = calculateCkdEpi2021Egfr({
      ageYears: 72,
      serumCreatinine: { unit: 'mg/dL', value: 1.8 },
      sex: 'male',
    })
    expect(stageG3b.tierCode).toBe('G3b')
    expect(stageG3b.value).toBeGreaterThanOrEqual(30)
    expect(stageG3b.value).toBeLessThan(45)

    const stageG4 = calculateCkdEpi2021Egfr({
      ageYears: 74,
      serumCreatinine: { unit: 'umol/L', value: 240 },
      sex: 'female',
    })
    expect(stageG4.tierCode).toBe('G4')
    expect(stageG4.value).toBeLessThan(30)

    expect(() =>
      calculateCkdEpi2021Egfr({
        ageYears: 14,
        serumCreatinine: { unit: 'mg/dL', value: 0.8 },
        sex: 'male',
      }),
    ).toThrow(RangeError)
  })

  it('computes Cockcroft-Gault CrCl with sex factor and weight bounds', () => {
    const male = calculateCockcroftGaultCrCl({
      ageYears: 68,
      serumCreatinine: { unit: 'mg/dL', value: 1.0 },
      sex: 'male',
      weightKg: 72,
    })
    expect(male.value).toBe(72)
    expect(male.tierCode).toBe('mild')

    const female = calculateCockcroftGaultCrCl({
      ageYears: 68,
      serumCreatinine: { unit: 'umol/L', value: 88.4 },
      sex: 'female',
      weightKg: 72,
    })
    expect(female.value).toBe(61.2)
    expect(female.tierCode).toBe('mild')

    expect(
      calculateCockcroftGaultCrCl({
        ageYears: 68,
        serumCreatinine: { unit: 'mg/dL', value: 1.0 },
        sex: 'male',
        weightKg: 18,
      }).value,
    ).toBe(18)
    expect(() =>
      calculateCockcroftGaultCrCl({
        ageYears: 68,
        serumCreatinine: { unit: 'mg/dL', value: 1.0 },
        sex: 'male',
        weightKg: 0.5,
      }),
    ).toThrow(RangeError)
  })

  it('computes GRACE ACS admission score across low, intermediate, and high risk strata', () => {
    const low = calculateGraceAcs({
      ageYears: 45,
      cardiacArrestOnAdmission: false,
      elevatedCardiacBiomarker: false,
      heartRateBpm: 72,
      killipClass: 'I',
      serumCreatinine: { unit: 'umol/L', value: 80 },
      stSegmentDeviation: false,
      systolicBpMmHg: 145,
    })
    expect(low.value).toBeLessThanOrEqual(108)
    expect(low.tierCode).toBe('low')

    const intermediate = calculateGraceAcs({
      ageYears: 66,
      cardiacArrestOnAdmission: false,
      elevatedCardiacBiomarker: true,
      heartRateBpm: 88,
      killipClass: 'I',
      serumCreatinine: { unit: 'mg/dL', value: 1.1 },
      stSegmentDeviation: false,
      systolicBpMmHg: 132,
    })
    expect(intermediate.value).toBeGreaterThanOrEqual(109)
    expect(intermediate.value).toBeLessThanOrEqual(140)
    expect(intermediate.tierCode).toBe('intermediate')

    const high = calculateGraceAcs({
      ageYears: 76,
      cardiacArrestOnAdmission: false,
      elevatedCardiacBiomarker: true,
      heartRateBpm: 112,
      killipClass: 'II',
      serumCreatinine: { unit: 'umol/L', value: 150 },
      stSegmentDeviation: true,
      systolicBpMmHg: 105,
    })
    expect(high.value).toBeGreaterThan(140)
    expect(high.tierCode).toBe('high')
  })

  it('computes TIMI UA/NSTEMI 0–7 score across low, intermediate, and high risk strata', () => {
    expect(
      calculateTimiUaNstemi({
        ageYears: 52,
        anginaEpisodes24h: 1,
        aspirinUsedLast7Days: false,
        cadRiskFactorCount: 2,
        elevatedCardiacBiomarker: false,
        knownCoronaryStenosisGe50Pct: false,
        stSegmentDeviation: true,
      }),
    ).toMatchObject({ tierCode: 'low', value: 1 })

    expect(
      calculateTimiUaNstemi({
        ageYears: 68,
        anginaEpisodes24h: 2,
        aspirinUsedLast7Days: true,
        cadRiskFactorCount: 3,
        elevatedCardiacBiomarker: false,
        knownCoronaryStenosisGe50Pct: false,
        stSegmentDeviation: false,
      }),
    ).toMatchObject({ tierCode: 'intermediate', value: 4 })

    expect(
      calculateTimiUaNstemi({
        ageYears: 70,
        anginaEpisodes24h: 3,
        aspirinUsedLast7Days: true,
        cadRiskFactorCount: 3,
        elevatedCardiacBiomarker: true,
        knownCoronaryStenosisGe50Pct: true,
        stSegmentDeviation: true,
      }),
    ).toMatchObject({ tierCode: 'high', value: 7 })
  })

  it('computes PRECISE-DAPT across g/L and g/dL hemoglobin and <25 vs >=25 bleeding cutoff', () => {
    const lowBleed = calculatePreciseDapt({
      ageYears: 56,
      creatinineClearanceMlMin: 88,
      hemoglobin: { unit: 'g/L', value: 142 },
      priorBleedingHistory: 'negative',
      wbc: { unit: '10*9/L', value: 6.8 },
    })
    const lowBleedGdl = calculatePreciseDapt({
      ageYears: 56,
      creatinineClearanceMlMin: 88,
      hemoglobin: { unit: 'g/dL', value: 14.2 },
      priorBleedingHistory: 'negative',
      wbc: { unit: '/uL', value: 6800 },
    })
    expect(lowBleed).toEqual(lowBleedGdl)
    expect(lowBleed.value).toBeLessThan(25)
    expect(lowBleed.tierCode).toBe('low-moderate')

    const highBleed = calculatePreciseDapt({
      ageYears: 78,
      creatinineClearanceMlMin: 38,
      hemoglobin: { unit: 'g/L', value: 102 },
      priorBleedingHistory: 'positive',
      wbc: { unit: '10^9/L', value: 11.5 },
    })
    expect(highBleed.value).toBeGreaterThanOrEqual(25)
    expect(highBleed.tierCode).toBe('high')

    // Published PRECISE-DAPT hemoglobin scale: >=12 g/dL -> 0 pts, <=10 g/dL -> full 15 pts
    expect(
      calculatePreciseDapt({
        ageYears: 50,
        creatinineClearanceMlMin: 100,
        hemoglobin: { unit: 'g/dL', value: 12 },
        priorBleedingHistory: 'negative',
        wbc: { unit: '10*9/L', value: 5 },
      }).value,
    ).toBe(0)
    expect(
      calculatePreciseDapt({
        ageYears: 50,
        creatinineClearanceMlMin: 100,
        hemoglobin: { unit: 'g/dL', value: 10 },
        priorBleedingHistory: 'negative',
        wbc: { unit: '10*9/L', value: 5 },
      }).value,
    ).toBe(15)
    expect(
      calculatePreciseDapt({
        ageYears: 60,
        creatinineClearanceMlMin: 72,
        hemoglobin: { unit: 'g/dL', value: 10 },
        priorBleedingHistory: 'negative',
        wbc: { unit: '10*9/L', value: 9 },
      }),
    ).toMatchObject({ tierCode: 'high' })
  })

  it('stratifies ASCVD LDL-C target per 2023 Chinese lipid guideline ultra-high criteria and 21-cell primary matrix', () => {
    // First uncomplicated ACS with all upgrade factors confirmed negative -> very-high (<1.8 mmol/L), NOT overclassified as ultra-high
    const firstUncomplicatedAcs = calculateAscvdLdlTarget({
      ageYears: 62,
      cadOnsetAgeYears: 62,
      confirmedDiagnosisCodes: ['I21.4'],
      egfrMlMin173m2: 88,
      ldlCholesterol: { unit: 'mg/dL', value: 77.34 },
      sex: 'male',
      smokingStatus: 'never',
    })
    expect(firstUncomplicatedAcs).toMatchObject({
      ldlGoalEvaluation: { atGoal: false, currentLdlMmolL: 2, targetLdlMmolL: 1.8 },
      status: 'complete',
      tierCode: 'very-high',
      value: 1.8,
    })

    // 1 severe ASCVD event + 1 known high-risk factor + unknown smokingStatus (or unknown LDL-C / eGFR / sex / onset) -> stays incomplete!
    expect(
      calculateAscvdLdlTarget({
        ageYears: 62,
        cadOnsetAgeYears: 62,
        confirmedDiagnosisCodes: ['I21.4', 'E11.9'],
        egfrMlMin173m2: 88,
        ldlCholesterol: { unit: 'mmol/L', value: 2.2 },
        sex: 'male',
      }),
    ).toEqual({
      missingInputs: ['smokingStatus'],
      status: 'incomplete',
    })
    expect(
      calculateAscvdLdlTarget({
        ageYears: 62,
        confirmedDiagnosisCodes: ['I21.4', 'E11.9'],
        smokingStatus: 'never',
      }),
    ).toEqual({
      missingInputs: ['sex', 'cadOnsetAge', 'ldlCholesterol', 'serumCreatinine'],
      status: 'incomplete',
    })

    // ACS + >=2 high-risk factors (diabetes + hypertension) OR >=2 severe events -> ultra-high (<1.4 mmol/L)
    const ultraHighAcs = calculateAscvdLdlTarget({
      ageYears: 62,
      confirmedDiagnosisCodes: ['I21.4', 'E11.9', 'I10'],
      ldlCholesterol: { unit: 'mg/dL', value: 77.34 },
      sex: 'male',
    })
    expect(ultraHighAcs).toMatchObject({
      ldlGoalEvaluation: { atGoal: false, currentLdlMmolL: 2, targetLdlMmolL: 1.4 },
      status: 'complete',
      tierCode: 'ultra-high',
      value: 1.4,
    })

    // Two severe ASCVD events of the SAME category (e.g. two confirmed ischemic strokes) -> ultra-high (<1.4 mmol/L)
    const twoIschemicStrokes = calculateAscvdLdlTarget({
      ageYears: 62,
      confirmedDiagnosisCodes: ['I63.9', 'I63.9'],
      ldlCholesterol: { unit: 'mmol/L', value: 2.1 },
      sex: 'female',
    })
    expect(twoIschemicStrokes).toMatchObject({
      status: 'complete',
      tierCode: 'ultra-high',
      value: 1.4,
    })

    // Older patient (70yo man) whose CAD began prematurely (onset age 50 < 55) + diabetes meets 1 severe event + 2 high-risk factors -> ultra-high (<1.4)
    expect(
      calculateAscvdLdlTarget({
        ageYears: 70,
        cadOnsetAgeYears: 50,
        confirmedDiagnosisCodes: ['I21.4', 'E11.9'],
        ldlCholesterol: { unit: 'mmol/L', value: 2.0 },
        sex: 'male',
      }),
    ).toMatchObject({
      status: 'complete',
      tierCode: 'ultra-high',
      value: 1.4,
    })

    // Stable CAD with preserved eGFR -> very-high (<1.8 mmol/L)
    const stableCad = calculateAscvdLdlTarget({
      ageYears: 64,
      confirmedDiagnosisCodes: ['I25.1'],
      egfrMlMin173m2: 72,
      ldlCholesterol: { unit: 'mmol/L', value: 1.62 },
    })
    expect(stableCad).toMatchObject({
      ldlGoalEvaluation: { atGoal: true, currentLdlMmolL: 1.62, targetLdlMmolL: 1.8 },
      status: 'complete',
      tierCode: 'very-high',
      value: 1.8,
    })

    // Diabetes + CKD (eGFR < 60) -> very-high (<1.8 mmol/L) without requiring smoking status
    const dmCkd = calculateAscvdLdlTarget({
      ageYears: 58,
      confirmedDiagnosisCodes: ['E11.2'],
      egfrMlMin173m2: 42,
    })
    expect(dmCkd).toMatchObject({
      status: 'complete',
      tierCode: 'very-high',
      value: 1.8,
    })

    // Primary prevention missing smokingStatus -> incomplete
    const primaryMissingSmoking = calculateAscvdLdlTarget({
      ageYears: 52,
      confirmedDiagnosisCodes: ['I10'],
      egfrMlMin173m2: 86,
      hdlCholesterol: { unit: 'mmol/L', value: 1.2 },
      ldlCholesterol: { unit: 'mmol/L', value: 3.1 },
      sex: 'male',
      systolicBpMmHg: 146,
    })
    expect(primaryMissingSmoking).toEqual({
      missingInputs: ['smokingStatus'],
      status: 'incomplete',
    })

    // 21-cell matrix: hypertensive 52yo male (1 factor) + LDL-C 3.1 (band 1) -> moderate (<2.6 mmol/L)
    const primaryModerateHtn = calculateAscvdLdlTarget({
      ageYears: 52,
      confirmedDiagnosisCodes: ['I10'],
      egfrMlMin173m2: 86,
      hdlCholesterol: { unit: 'mmol/L', value: 1.2 },
      ldlCholesterol: { unit: 'mmol/L', value: 3.1 },
      sex: 'male',
      smokingStatus: 'never',
      systolicBpMmHg: 146,
    })
    expect(primaryModerateHtn).toMatchObject({
      status: 'complete',
      tierCode: 'moderate',
      value: 2.6,
    })

    // 2023 Chinese lipid guideline middle LDL-C band starts at 2.4 mmol/L (2.4–<3.4): hypertensive 50yo male (1 factor) + LDL-C 2.5 -> moderate (<2.6)
    expect(
      calculateAscvdLdlTarget({
        ageYears: 50,
        confirmedDiagnosisCodes: ['I10'],
        egfrMlMin173m2: 88,
        hdlCholesterol: { unit: 'mmol/L', value: 1.2 },
        ldlCholesterol: { unit: 'mmol/L', value: 2.5 },
        sex: 'male',
        smokingStatus: 'never',
        systolicBpMmHg: 144,
      }),
    ).toMatchObject({
      status: 'complete',
      tierCode: 'moderate',
      value: 2.6,
    })

    // 21-cell matrix: non-hypertensive 50yo male smoker with HDL-C 0.8 (3 factors) + LDL-C 4.0 (band 2) -> moderate (<2.6 mmol/L)
    const primaryModerateNoHtn = calculateAscvdLdlTarget({
      ageYears: 50,
      confirmedDiagnosisCodes: [],
      diastolicBpMmHg: 78,
      egfrMlMin173m2: 92,
      hdlCholesterol: { unit: 'mmol/L', value: 0.8 },
      ldlCholesterol: { unit: 'mmol/L', value: 4.0 },
      sex: 'male',
      smokingStatus: 'current',
      systolicBpMmHg: 122,
    })
    expect(primaryModerateNoHtn).toMatchObject({
      status: 'complete',
      tierCode: 'moderate',
      value: 2.6,
    })

    // Isolated diastolic hypertension (130/95 mmHg, DBP >= 90) places patient in hypertensive matrix row: 2 factors + LDL-C 2.8 -> high (<2.6 mmol/L)
    expect(
      calculateAscvdLdlTarget({
        ageYears: 50,
        confirmedDiagnosisCodes: [],
        diastolicBpMmHg: 95,
        egfrMlMin173m2: 92,
        hdlCholesterol: { unit: 'mmol/L', value: 1.3 },
        ldlCholesterol: { unit: 'mmol/L', value: 2.8 },
        sex: 'male',
        smokingStatus: 'current',
        systolicBpMmHg: 130,
      }),
    ).toMatchObject({
      status: 'complete',
      tierCode: 'high',
      value: 2.6,
    })

    // 21-cell matrix: non-hypertensive 38yo female non-smoker (0 factors) + LDL-C 3.0 -> low (<3.4 mmol/L)
    const primaryLow = calculateAscvdLdlTarget({
      ageYears: 38,
      confirmedDiagnosisCodes: [],
      diastolicBpMmHg: 74,
      egfrMlMin173m2: 98,
      hdlCholesterol: { unit: 'mmol/L', value: 1.4 },
      ldlCholesterol: { unit: 'mmol/L', value: 3.0 },
      sex: 'female',
      smokingStatus: 'never',
      systolicBpMmHg: 118,
    })
    expect(primaryLow).toMatchObject({
      status: 'complete',
      tierCode: 'low',
      value: 3.4,
    })

    // Diabetic patient under 40 with preserved eGFR still retains <2.6 mmol/L LDL-C target per 2023 guideline
    const youngDiabetic = calculateAscvdLdlTarget({
      ageYears: 30,
      confirmedDiagnosisCodes: ['E11.9'],
      diastolicBpMmHg: 76,
      egfrMlMin173m2: 105,
      hdlCholesterol: { unit: 'mmol/L', value: 1.2 },
      ldlCholesterol: { unit: 'mmol/L', value: 2.0 },
      sex: 'male',
      smokingStatus: 'never',
      systolicBpMmHg: 120,
    })
    expect(youngDiabetic).toMatchObject({
      status: 'complete',
      tierCode: 'moderate',
      value: 2.6,
    })

    // Sub-1 eGFR (e.g. 90yo woman with creatinine 30 mg/dL -> eGFR 0.9) does not throw in LDL target evaluation
    const subOneEgfrBundle = evaluateClinicalScores({
      ageYears: { source: { label: 'P', reference: 'Patient/p', versionId: '1' }, value: 90 },
      confirmedDiagnoses: [],
      serumCreatinine: { source: { label: 'L', reference: 'Observation/o', versionId: '1' }, value: { unit: 'mg/dL', value: 30 } },
      sex: { source: { label: 'P', reference: 'Patient/p', versionId: '1' }, value: 'female' },
    })
    expect(subOneEgfrBundle.find(item => item.id === 'ckd-epi-2021-egfr')?.value).toBeLessThan(1)
    expect(subOneEgfrBundle.find(item => item.id === 'ascvd-ldl-target')).toMatchObject({
      status: 'complete',
      tierCode: 'very-high',
      value: 1.8,
    })
  })
})

describe('evaluateClinicalScores bundle evaluation', () => {
  it('returns incomplete with exact missingInputs when objective facts are absent and never fabricates defaults', () => {
    const patientSrc = { label: '患者人口学', reference: 'Patient/p-1', versionId: '1' }
    const results = evaluateClinicalScores({
      ageYears: { source: patientSrc, value: 66 },
      confirmedDiagnoses: [],
      sex: { source: patientSrc, value: 'male' },
    })
    expect(results).toHaveLength(6)
    expect(results.every(item => item.status === 'incomplete')).toBe(true)
    expect(results.find(item => item.id === 'ckd-epi-2021-egfr')?.missingInputs).toEqual(['serumCreatinine'])
    expect(results.find(item => item.id === 'cockcroft-gault-crcl')?.missingInputs).toEqual([
      'weightKg',
      'serumCreatinine',
    ])
    expect(results.find(item => item.id === 'grace-acs')?.missingInputs).toEqual([
      'heartRateBpm',
      'systolicBpMmHg',
      'serumCreatinine',
      'killipClass',
      'cardiacArrestOnAdmission',
      'stSegmentDeviation',
      'elevatedCardiacBiomarker',
    ])
    expect(results.find(item => item.id === 'precise-dapt')?.missingInputs).toEqual([
      'weightKg',
      'serumCreatinine',
      'hemoglobin',
      'wbc',
      'priorBleedingHistory',
    ])
  })

  it('evaluates all 6 scores as complete and validates against clinicalScoreBundleSchema when facts are present', () => {
    const patientSrc = { label: 'Patient', reference: 'Patient/p-1', versionId: '2' }
    const vitalSrc = { label: 'Vitals', reference: 'Observation/obs-vital-1', versionId: '1' }
    const labSrc = { label: 'Labs', reference: 'DiagnosticReport/dr-lab-1', versionId: '1' }
    const ecgSrc = { label: 'ECG', reference: 'DiagnosticReport/dr-ecg-1', versionId: '1' }
    const riskSrc = { label: 'Risk', reference: 'Observation/obs-risk-1', versionId: '1' }
    const condSrc = { label: 'Diagnosis', reference: 'Condition/cond-1', versionId: '1' }

    const scores = evaluateClinicalScores({
      ageYears: { source: patientSrc, value: 68 },
      anginaEpisodes24h: { source: riskSrc, value: 2 },
      aspirinUsedLast7Days: { source: riskSrc, value: true },
      cadOnsetAgeYears: { source: condSrc, value: 68 },
      cardiacArrestOnAdmission: { source: riskSrc, value: false },
      confirmedDiagnoses: [{ code: 'I21.4', source: condSrc }],
      elevatedCardiacBiomarker: { source: labSrc, value: true },
      hdlCholesterol: { source: labSrc, value: { unit: 'mmol/L', value: 1.05 } },
      heartRateBpm: { source: vitalSrc, value: 92 },
      hemoglobin: { source: labSrc, value: { unit: 'g/L', value: 132 } },
      killipClass: { source: riskSrc, value: 'II' },
      knownCoronaryRevascularizationOrStenosisGe50: { source: riskSrc, value: false },
      ldlCholesterol: { source: labSrc, value: { unit: 'mmol/L', value: 2.35 } },
      priorBleedingHistory: { source: riskSrc, value: 'negative' },
      serumCreatinine: { source: labSrc, value: { unit: 'umol/L', value: 112 } },
      sex: { source: patientSrc, value: 'male' },
      smokingStatus: { source: riskSrc, value: 'current' },
      stSegmentDeviation: { source: ecgSrc, value: true },
      systolicBpMmHg: { source: vitalSrc, value: 128 },
      totalCholesterol: { source: labSrc, value: { unit: 'mmol/L', value: 4.6 } },
      wbc: { source: labSrc, value: { unit: '10*9/L', value: 9.4 } },
      weightKg: { source: vitalSrc, value: 74 },
    })

    expect(scores.every(item => item.status === 'complete')).toBe(true)
    const parsedBundle = clinicalScoreBundleSchema.parse({
      encounterId: 'enc-1',
      encounterVersion: '3',
      evaluatedAt: '2026-11-16T10:00:00+08:00',
      riskAssessment: {
        effectiveStSegmentDeviation: {
          source: 'ecg-report',
          sourceReference: 'DiagnosticReport/dr-ecg-1',
          value: true,
          versionId: '1',
        },
        observationId: 'obs-risk-1',
        observationVersion: '1',
        provenanceId: 'prov-risk-1',
        recordedAt: '2026-11-16T09:55:00+08:00',
        recordedBy: 'actor-doc-1',
        revision: 1,
        values: {
          anginaEpisodes24h: 2,
          aspirinUsedLast7Days: true,
          cardiacArrestOnAdmission: false,
          killipClass: 'II',
          priorBleedingHistory: 'negative',
          smokingStatus: 'current',
          stSegmentDeviation: null,
        },
      },
      scores,
      vitalSigns: {
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 128 },
        heightCm: 172,
        observationId: 'obs-vital-1',
        observationVersion: '1',
        oxygenSaturationPct: 97,
        pulseBpm: 92,
        recordedAt: '2026-11-16T09:30:00+08:00',
        respirationBpm: 18,
        temperatureC: 36.6,
        weightKg: 74,
      },
    })
    expect(parsedBundle.scores).toHaveLength(6)
    // Acute I21.4 alone does NOT inflate TIMI known coronary stenosis >=50% (age>=65[1] + aspirin[1] + angina>=2[1] + ST[1] + troponin[1] = 5 pts)
    expect(scores.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({ status: 'complete', value: 5 })
    // Adding prior stent Z98.61 or formal >=50% stenosis adds the 6th TIMI point
    const withPriorStent = evaluateClinicalScores({
      ageYears: { source: patientSrc, value: 68 },
      anginaEpisodes24h: { source: riskSrc, value: 2 },
      aspirinUsedLast7Days: { source: riskSrc, value: true },
      confirmedDiagnoses: [{ code: 'I21.4', source: condSrc }, { code: 'Z98.61', source: condSrc }],
      elevatedCardiacBiomarker: { source: labSrc, value: true },
      smokingStatus: { source: riskSrc, value: 'never' },
      stSegmentDeviation: { source: ecgSrc, value: true },
    })
    expect(withPriorStent.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({ status: 'complete', value: 6 })
  })

  it('clamps extreme Cockcroft-Gault CrCl (<1 and >300 mL/min) in PRECISE-DAPT without aborting bundle and restricts TIMI hypertension to confirmed history/therapy', () => {
    const src = { label: 'Source', reference: 'Observation/obs-1', versionId: '1' }
    const ultraLowCrClBundle = evaluateClinicalScores({
      ageYears: { source: src, value: 110 },
      confirmedDiagnoses: [],
      hemoglobin: { source: src, value: { unit: 'g/L', value: 105 } },
      priorBleedingHistory: { source: src, value: 'negative' },
      serumCreatinine: { source: src, value: { unit: 'mg/dL', value: 20 } },
      sex: { source: src, value: 'female' },
      wbc: { source: src, value: { unit: '10*9/L', value: 8.2 } },
      weightKg: { source: src, value: 25 },
    })
    expect(ultraLowCrClBundle.find(item => item.id === 'cockcroft-gault-crcl')).toMatchObject({
      status: 'complete',
      value: 0.4,
    })
    expect(ultraLowCrClBundle.find(item => item.id === 'precise-dapt')).toMatchObject({
      status: 'complete',
      tierCode: 'high',
    })

    const ultraHighCrClBundle = evaluateClinicalScores({
      ageYears: { source: src, value: 20 },
      confirmedDiagnoses: [],
      hemoglobin: { source: src, value: { unit: 'g/L', value: 145 } },
      priorBleedingHistory: { source: src, value: 'negative' },
      serumCreatinine: { source: src, value: { unit: 'mg/dL', value: 0.2 } },
      sex: { source: src, value: 'male' },
      wbc: { source: src, value: { unit: '10*9/L', value: 6.0 } },
      weightKg: { source: src, value: 120 },
    })
    expect(ultraHighCrClBundle.find(item => item.id === 'cockcroft-gault-crcl')?.value).toBeGreaterThan(300)
    expect(ultraHighCrClBundle.find(item => item.id === 'precise-dapt')).toMatchObject({
      status: 'complete',
      tierCode: 'low-moderate',
    })

    // Single elevated SBP (158 mmHg) with DM + current smoking (2 CAD factors) stays incomplete until familyHistoryPrematureCad is known, and resolves to 0 when negative vs 1 when positive
    const transientHighSbpUnknownFamily = evaluateClinicalScores({
      ageYears: { source: src, value: 58 },
      anginaEpisodes24h: { source: src, value: 1 },
      aspirinUsedLast7Days: { source: src, value: false },
      confirmedDiagnoses: [{ code: 'E11.9', source: src }],
      elevatedCardiacBiomarker: { source: src, value: false },
      knownCoronaryRevascularizationOrStenosisGe50: { source: src, value: false },
      smokingStatus: { source: src, value: 'current' },
      stSegmentDeviation: { source: src, value: false },
      systolicBpMmHg: { source: src, value: 158 },
    })
    expect(transientHighSbpUnknownFamily.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: ['familyHistoryPrematureCad'],
      status: 'incomplete',
    })

    // Unknown coronary stenosis history (without prior MI/stent/CABG or angiography) keeps TIMI incomplete
    const unknownStenosis = evaluateClinicalScores({
      ageYears: { source: src, value: 58 },
      anginaEpisodes24h: { source: src, value: 1 },
      aspirinUsedLast7Days: { source: src, value: false },
      confirmedDiagnoses: [],
      elevatedCardiacBiomarker: { source: src, value: false },
      smokingStatus: { source: src, value: 'never' },
      stSegmentDeviation: { source: src, value: false },
    })
    expect(unknownStenosis.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({
      missingInputs: ['knownCoronaryStenosisGe50'],
      status: 'incomplete',
    })

    const transientHighSbpNegativeFamily = evaluateClinicalScores({
      ageYears: { source: src, value: 58 },
      anginaEpisodes24h: { source: src, value: 1 },
      aspirinUsedLast7Days: { source: src, value: false },
      confirmedDiagnoses: [{ code: 'E11.9', source: src }],
      elevatedCardiacBiomarker: { source: src, value: false },
      familyHistoryPrematureCad: { source: src, value: false },
      knownCoronaryRevascularizationOrStenosisGe50: { source: src, value: false },
      smokingStatus: { source: src, value: 'current' },
      stSegmentDeviation: { source: src, value: false },
      systolicBpMmHg: { source: src, value: 158 },
    })
    expect(transientHighSbpNegativeFamily.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({ status: 'complete', value: 0 })

    // Hypertension + diabetes + positive family history of premature CAD (even in a never-smoker) counts as 3 CAD risk factors (+1 pt)
    const positiveFamilyAsThirdFactor = evaluateClinicalScores({
      ageYears: { source: src, value: 58 },
      anginaEpisodes24h: { source: src, value: 1 },
      aspirinUsedLast7Days: { source: src, value: false },
      confirmedDiagnoses: [{ code: 'I10', source: src }, { code: 'E11.9', source: src }],
      elevatedCardiacBiomarker: { source: src, value: false },
      familyHistoryPrematureCad: { source: src, value: true },
      knownCoronaryRevascularizationOrStenosisGe50: { source: src, value: false },
      smokingStatus: { source: src, value: 'never' },
      stSegmentDeviation: { source: src, value: false },
      systolicBpMmHg: { source: src, value: 126 },
    })
    expect(positiveFamilyAsThirdFactor.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({ status: 'complete', value: 1 })

    // Confirmed hypertension diagnosis (I10) or active antihypertensive therapy DOES count as the 3rd CAD risk factor
    const confirmedHtn = evaluateClinicalScores({
      ageYears: { source: src, value: 58 },
      anginaEpisodes24h: { source: src, value: 1 },
      antihypertensiveMedicationActive: { source: src, value: true },
      aspirinUsedLast7Days: { source: src, value: false },
      confirmedDiagnoses: [{ code: 'E11.9', source: src }],
      elevatedCardiacBiomarker: { source: src, value: false },
      knownCoronaryRevascularizationOrStenosisGe50: { source: src, value: false },
      smokingStatus: { source: src, value: 'current' },
      stSegmentDeviation: { source: src, value: false },
      systolicBpMmHg: { source: src, value: 126 },
    })
    expect(confirmedHtn.find(item => item.id === 'timi-ua-nstemi')).toMatchObject({ status: 'complete', value: 1 })
  })
})
