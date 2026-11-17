import type {
  ClinicalScoreId,
  ClinicalScoreMissingInput,
  ClinicalScoreResult,
  ClinicalScoreSourceReference,
  KillipClass,
  LdlGoalEvaluation,
  PriorBleedingHistory,
  SmokingStatus,
} from '@clinmesh/contracts/clinical-scores'

export type ClinicalSex = 'male' | 'female'

export interface UnitQuantityInput {
  unit: string
  value: number
}

export interface SourcedFact<T> {
  source?: ClinicalScoreSourceReference
  value: T
}

export interface ClinicalScoreObjectiveFacts {
  ageYears?: SourcedFact<number>
  anginaEpisodes24h?: SourcedFact<number>
  antihypertensiveMedicationActive?: SourcedFact<boolean>
  aspirinUsedLast7Days?: SourcedFact<boolean>
  cardiacArrestOnAdmission?: SourcedFact<boolean>
  confirmedDiagnoses: Array<{
    code: string
    source: ClinicalScoreSourceReference
  }>
  elevatedCardiacBiomarker?: SourcedFact<boolean>
  hdlCholesterol?: SourcedFact<UnitQuantityInput>
  heartRateBpm?: SourcedFact<number>
  hemoglobin?: SourcedFact<UnitQuantityInput>
  killipClass?: SourcedFact<KillipClass>
  knownCoronaryRevascularizationOrStenosisGe50?: SourcedFact<boolean>
  ldlCholesterol?: SourcedFact<UnitQuantityInput>
  priorBleedingHistory?: SourcedFact<PriorBleedingHistory>
  serumCreatinine?: SourcedFact<UnitQuantityInput>
  sex?: SourcedFact<ClinicalSex>
  smokingStatus?: SourcedFact<SmokingStatus>
  stSegmentDeviation?: SourcedFact<boolean>
  systolicBpMmHg?: SourcedFact<number>
  totalCholesterol?: SourcedFact<UnitQuantityInput>
  wbc?: SourcedFact<UnitQuantityInput>
  weightKg?: SourcedFact<number>
}

const CHOLESTEROL_MG_DL_PER_MMOL_L = 38.67
const CREATININE_UMOL_L_PER_MG_DL = 88.4

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

function roundTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function assertFiniteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} out of physiological bounds [${min}, ${max}]: ${String(value)}`)
  }
  return value
}

export function validateAdultAgeYears(ageYears: number): number {
  return assertFiniteRange(ageYears, 18, 120, 'ageYears')
}

export function validateWeightKg(weightKg: number): number {
  return assertFiniteRange(weightKg, 20, 300, 'weightKg')
}

export function validateHeartRateBpm(heartRateBpm: number): number {
  return assertFiniteRange(heartRateBpm, 20, 300, 'heartRateBpm')
}

export function validateSystolicBpMmHg(systolicBpMmHg: number): number {
  return assertFiniteRange(systolicBpMmHg, 40, 300, 'systolicBpMmHg')
}

/** 血肌酐双轨单位换算：统一折算为 mg/dL（1 mg/dL = 88.4 umol/L），拒绝非法极值。 */
export function normalizeCreatinineMgDl(value: number, rawUnit: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Invalid serum creatinine value: ${String(value)}`)
  }
  const normalizedUnit = rawUnit.trim().replace(/^[μµ]/u, 'u').toLowerCase()
  const mgDl =
    normalizedUnit === 'mg/dl'
      ? value
      : normalizedUnit === 'umol/l'
        ? value / CREATININE_UMOL_L_PER_MG_DL
        : undefined
  if (mgDl === undefined) {
    throw new RangeError(`Unsupported serum creatinine unit: ${rawUnit}`)
  }
  return assertFiniteRange(mgDl, 0.1, 30, 'serumCreatinineMgDl')
}

/** 血红蛋白双轨单位换算：统一折算为 g/dL（1 g/dL = 10 g/L），拒绝非法极值。 */
export function normalizeHemoglobinGdl(value: number, rawUnit: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Invalid hemoglobin value: ${String(value)}`)
  }
  const normalizedUnit = rawUnit.trim().toLowerCase()
  const gDl =
    normalizedUnit === 'g/dl'
      ? value
      : normalizedUnit === 'g/l'
        ? value / 10
        : undefined
  if (gDl === undefined) {
    throw new RangeError(`Unsupported hemoglobin unit: ${rawUnit}`)
  }
  return assertFiniteRange(gDl, 2, 25, 'hemoglobinGdl')
}

/** 白细胞计数双轨单位换算：统一折算为 10^9/L，拒绝非法极值。 */
export function normalizeWbc10e9L(value: number, rawUnit: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Invalid WBC value: ${String(value)}`)
  }
  const normalizedUnit = rawUnit.trim().replace(/^[×x]/iu, '').replace(/[μµ]/gu, 'u').toLowerCase()
  const count10e9L =
    ['10*9/l', '10^9/l', 'g/l', '/nl', '10*3/ul', '10^3/ul', '/mm3', 'k/ul'].includes(normalizedUnit)
      ? value
      : normalizedUnit === '/ul'
        ? value / 1000
        : undefined
  if (count10e9L === undefined) {
    throw new RangeError(`Unsupported WBC unit: ${rawUnit}`)
  }
  return assertFiniteRange(count10e9L, 0.1, 200, 'wbc10e9L')
}

/** 胆固醇（TC / HDL-C / LDL-C）双轨单位换算：统一折算为 mmol/L（1 mmol/L = 38.67 mg/dL），拒绝非法极值。 */
export function normalizeLipidMmolL(
  value: number,
  rawUnit: string,
  kind: 'tc' | 'hdl' | 'ldl' = 'ldl',
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Invalid ${kind} value: ${String(value)}`)
  }
  const normalizedUnit = rawUnit.trim().toLowerCase()
  const mmolL =
    normalizedUnit === 'mmol/l'
      ? value
      : normalizedUnit === 'mg/dl'
        ? value / CHOLESTEROL_MG_DL_PER_MMOL_L
        : undefined
  if (mmolL === undefined) {
    throw new RangeError(`Unsupported lipid unit: ${rawUnit}`)
  }
  const bounds: Record<'tc' | 'hdl' | 'ldl', [number, number]> = {
    hdl: [0.2, 5.0],
    ldl: [0.2, 20.0],
    tc: [1.0, 25.0],
  }
  const [min, max] = bounds[kind]
  return assertFiniteRange(mmolL, min, max, `${kind}MmolL`)
}

export function calculateCkdEpi2021Egfr(input: {
  ageYears: number
  serumCreatinine: UnitQuantityInput
  sex: ClinicalSex
}): {
  tierCode: 'G1' | 'G2' | 'G3a' | 'G3b' | 'G4' | 'G5'
  tierLabelEn: string
  tierLabelZh: string
  unit: 'mL/min/1.73m2'
  value: number
} {
  const age = validateAdultAgeYears(input.ageYears)
  const scrMgDl = normalizeCreatinineMgDl(input.serumCreatinine.value, input.serumCreatinine.unit)
  const kappa = input.sex === 'female' ? 0.7 : 0.9
  const alpha = input.sex === 'female' ? -0.241 : -0.302
  const sexFactor = input.sex === 'female' ? 1.012 : 1.0
  const ratio = scrMgDl / kappa
  const raw =
    142
    * Math.pow(Math.min(ratio, 1), alpha)
    * Math.pow(Math.max(ratio, 1), -1.2)
    * Math.pow(0.9938, age)
    * sexFactor
  const value = roundOneDecimal(raw)
  if (value >= 90) {
    return { tierCode: 'G1', tierLabelEn: 'Normal or high (G1)', tierLabelZh: '正常或偏高 (G1)', unit: 'mL/min/1.73m2', value }
  }
  if (value >= 60) {
    return { tierCode: 'G2', tierLabelEn: 'Mildly decreased (G2)', tierLabelZh: '轻度下降 (G2)', unit: 'mL/min/1.73m2', value }
  }
  if (value >= 45) {
    return { tierCode: 'G3a', tierLabelEn: 'Mild-to-moderate decrease (G3a)', tierLabelZh: '轻中度下降 (G3a)', unit: 'mL/min/1.73m2', value }
  }
  if (value >= 30) {
    return { tierCode: 'G3b', tierLabelEn: 'Moderate-to-severe decrease (G3b)', tierLabelZh: '中重度下降 (G3b)', unit: 'mL/min/1.73m2', value }
  }
  if (value >= 15) {
    return { tierCode: 'G4', tierLabelEn: 'Severely decreased (G4)', tierLabelZh: '重度下降 (G4)', unit: 'mL/min/1.73m2', value }
  }
  return { tierCode: 'G5', tierLabelEn: 'Kidney failure (G5)', tierLabelZh: '肾衰竭期 (G5)', unit: 'mL/min/1.73m2', value }
}

export function calculateCockcroftGaultCrCl(input: {
  ageYears: number
  serumCreatinine: UnitQuantityInput
  sex: ClinicalSex
  weightKg: number
}): {
  tierCode: 'normal' | 'mild' | 'moderate' | 'severe' | 'end-stage'
  tierLabelEn: string
  tierLabelZh: string
  unit: 'mL/min'
  value: number
} {
  const age = validateAdultAgeYears(input.ageYears)
  const weightKg = validateWeightKg(input.weightKg)
  const scrMgDl = normalizeCreatinineMgDl(input.serumCreatinine.value, input.serumCreatinine.unit)
  const sexMultiplier = input.sex === 'female' ? 0.85 : 1.0
  const raw = (((140 - age) * weightKg) / (72 * scrMgDl)) * sexMultiplier
  const value = roundOneDecimal(raw)
  if (value >= 90) {
    return { tierCode: 'normal', tierLabelEn: 'Normal (≥90 mL/min)', tierLabelZh: '正常 (≥90 mL/min)', unit: 'mL/min', value }
  }
  if (value >= 60) {
    return { tierCode: 'mild', tierLabelEn: 'Mild reduction (60–89 mL/min)', tierLabelZh: '轻度减退 (60–89 mL/min)', unit: 'mL/min', value }
  }
  if (value >= 30) {
    return { tierCode: 'moderate', tierLabelEn: 'Moderate reduction (30–59 mL/min)', tierLabelZh: '中度减退 (30–59 mL/min)', unit: 'mL/min', value }
  }
  if (value >= 15) {
    return { tierCode: 'severe', tierLabelEn: 'Severe reduction (15–29 mL/min)', tierLabelZh: '重度减退 (15–29 mL/min)', unit: 'mL/min', value }
  }
  return { tierCode: 'end-stage', tierLabelEn: 'End-stage (<15 mL/min)', tierLabelZh: '极重度减退 (<15 mL/min)', unit: 'mL/min', value }
}

function graceAgePoints(age: number): number {
  if (age < 30) return 0
  if (age < 40) return 8
  if (age < 50) return 25
  if (age < 60) return 41
  if (age < 70) return 58
  if (age < 80) return 75
  if (age < 90) return 91
  return 100
}

function graceHeartRatePoints(hr: number): number {
  if (hr < 50) return 0
  if (hr < 70) return 3
  if (hr < 90) return 9
  if (hr < 110) return 15
  if (hr < 150) return 24
  if (hr < 200) return 38
  return 46
}

function graceSystolicBpPoints(sbp: number): number {
  if (sbp < 80) return 58
  if (sbp < 100) return 53
  if (sbp < 120) return 43
  if (sbp < 140) return 34
  if (sbp < 160) return 24
  if (sbp < 200) return 10
  return 0
}

function graceCreatininePoints(scrMgDl: number): number {
  if (scrMgDl < 0.4) return 1
  if (scrMgDl < 0.8) return 4
  if (scrMgDl < 1.2) return 7
  if (scrMgDl < 1.6) return 10
  if (scrMgDl < 2.0) return 13
  if (scrMgDl < 4.0) return 21
  return 28
}

const GRACE_KILLIP_POINTS: Record<KillipClass, number> = {
  I: 0,
  II: 20,
  III: 39,
  IV: 59,
}

export function calculateGraceAcs(input: {
  ageYears: number
  cardiacArrestOnAdmission: boolean
  elevatedCardiacBiomarker: boolean
  heartRateBpm: number
  killipClass: KillipClass
  serumCreatinine: UnitQuantityInput
  stSegmentDeviation: boolean
  systolicBpMmHg: number
}): {
  tierCode: 'low' | 'intermediate' | 'high'
  tierLabelEn: string
  tierLabelZh: string
  unit: '分'
  value: number
} {
  const age = validateAdultAgeYears(input.ageYears)
  const hr = validateHeartRateBpm(input.heartRateBpm)
  const sbp = validateSystolicBpMmHg(input.systolicBpMmHg)
  const scrMgDl = normalizeCreatinineMgDl(input.serumCreatinine.value, input.serumCreatinine.unit)
  const value =
    graceAgePoints(age)
    + graceHeartRatePoints(hr)
    + graceSystolicBpPoints(sbp)
    + graceCreatininePoints(scrMgDl)
    + GRACE_KILLIP_POINTS[input.killipClass]
    + (input.cardiacArrestOnAdmission ? 39 : 0)
    + (input.stSegmentDeviation ? 28 : 0)
    + (input.elevatedCardiacBiomarker ? 14 : 0)
  if (value <= 108) {
    return { tierCode: 'low', tierLabelEn: 'Low risk (≤108)', tierLabelZh: '低危 (≤108分)', unit: '分', value }
  }
  if (value <= 140) {
    return { tierCode: 'intermediate', tierLabelEn: 'Intermediate risk (109–140)', tierLabelZh: '中危 (109–140分)', unit: '分', value }
  }
  return { tierCode: 'high', tierLabelEn: 'High risk (>140)', tierLabelZh: '高危 (>140分)', unit: '分', value }
}

export function calculateTimiUaNstemi(input: {
  ageYears: number
  anginaEpisodes24h: number
  aspirinUsedLast7Days: boolean
  cadRiskFactorCount: number
  elevatedCardiacBiomarker: boolean
  knownCoronaryStenosisGe50Pct: boolean
  stSegmentDeviation: boolean
}): {
  tierCode: 'low' | 'intermediate' | 'high'
  tierLabelEn: string
  tierLabelZh: string
  unit: '分'
  value: number
} {
  const age = validateAdultAgeYears(input.ageYears)
  const anginaCount = assertFiniteRange(input.anginaEpisodes24h, 0, 100, 'anginaEpisodes24h')
  const riskFactors = assertFiniteRange(input.cadRiskFactorCount, 0, 10, 'cadRiskFactorCount')
  const value =
    (age >= 65 ? 1 : 0)
    + (riskFactors >= 3 ? 1 : 0)
    + (input.knownCoronaryStenosisGe50Pct ? 1 : 0)
    + (input.aspirinUsedLast7Days ? 1 : 0)
    + (anginaCount >= 2 ? 1 : 0)
    + (input.stSegmentDeviation ? 1 : 0)
    + (input.elevatedCardiacBiomarker ? 1 : 0)
  if (value <= 2) {
    return { tierCode: 'low', tierLabelEn: 'Low risk (0–2)', tierLabelZh: '低危 (0–2分)', unit: '分', value }
  }
  if (value <= 4) {
    return { tierCode: 'intermediate', tierLabelEn: 'Intermediate risk (3–4)', tierLabelZh: '中危 (3–4分)', unit: '分', value }
  }
  return { tierCode: 'high', tierLabelEn: 'High risk (5–7)', tierLabelZh: '高危 (5–7分)', unit: '分', value }
}

export function calculatePreciseDapt(input: {
  ageYears: number
  creatinineClearanceMlMin: number
  hemoglobin: UnitQuantityInput
  priorBleedingHistory: PriorBleedingHistory
  wbc: UnitQuantityInput
}): {
  tierCode: 'low-moderate' | 'high'
  tierLabelEn: string
  tierLabelZh: string
  unit: '分'
  value: number
} {
  const age = validateAdultAgeYears(input.ageYears)
  if (!Number.isFinite(input.creatinineClearanceMlMin) || input.creatinineClearanceMlMin < 0) {
    throw new RangeError(
      `creatinineClearanceMlMin out of physiological bounds [0, ∞): ${String(input.creatinineClearanceMlMin)}`,
    )
  }
  const crCl = input.creatinineClearanceMlMin
  const hbGdl = normalizeHemoglobinGdl(input.hemoglobin.value, input.hemoglobin.unit)
  const wbc10e9L = normalizeWbc10e9L(input.wbc.value, input.wbc.unit)

  const hbPoints = (12 - clamp(hbGdl, 5, 12)) * (15 / 7)
  const agePoints = (clamp(age, 50, 90) - 50) * (19 / 40)
  const wbcPoints = clamp(wbc10e9L, 5, 20) - 5
  const renalPoints = (100 - clamp(crCl, 0, 100)) * 0.25
  const bleedPoints = input.priorBleedingHistory === 'positive' ? 26 : 0
  const value = Math.round(hbPoints + agePoints + wbcPoints + renalPoints + bleedPoints)
  if (value >= 25) {
    return { tierCode: 'high', tierLabelEn: 'High bleeding risk (≥25)', tierLabelZh: '高出血风险 (≥25分)', unit: '分', value }
  }
  return { tierCode: 'low-moderate', tierLabelEn: 'Non-high bleeding risk (<25)', tierLabelZh: '非高出血风险 (<25分)', unit: '分', value }
}

function codeMatchesPrefixes(codes: readonly string[], prefixes: readonly string[]): boolean {
  return codes.some(code => {
    const upper = code.trim().toUpperCase()
    return prefixes.some(prefix => upper.startsWith(prefix.toUpperCase()))
  })
}

const ASCVD_ICD10_PREFIXES = [
  'I20',
  'I21',
  'I22',
  'I23',
  'I24',
  'I25',
  'I63',
  'I65',
  'I66',
  'G45',
  'I70',
  'I73.9',
  'Z95.1',
  'Z95.5',
  'Z98.61',
] as const

const ACS_ICD10_PREFIXES = ['I20.0', 'I21', 'I22', 'I23', 'I24'] as const
const DIABETES_ICD10_PREFIXES = ['E10', 'E11', 'E12', 'E13', 'E14'] as const
const HYPERTENSION_ICD10_PREFIXES = ['I10', 'I11', 'I12', 'I13', 'I15'] as const
const DYSLIPIDEMIA_ICD10_PREFIXES = ['E78'] as const

export function hasConfirmedAscvdDiagnosis(codes: readonly string[]): boolean {
  return codeMatchesPrefixes(codes, ASCVD_ICD10_PREFIXES)
}

export function hasConfirmedDiabetesDiagnosis(codes: readonly string[]): boolean {
  return codeMatchesPrefixes(codes, DIABETES_ICD10_PREFIXES)
}

export function hasConfirmedHypertensionDiagnosis(codes: readonly string[]): boolean {
  return codeMatchesPrefixes(codes, HYPERTENSION_ICD10_PREFIXES)
}

export function calculateAscvdLdlTarget(input: {
  ageYears: number
  antihypertensiveTreated?: boolean
  confirmedDiagnosisCodes: readonly string[]
  egfrMlMin173m2?: number
  hdlCholesterol?: UnitQuantityInput
  knownCoronaryRevascularization?: boolean
  ldlCholesterol?: UnitQuantityInput
  sex?: ClinicalSex
  smokingStatus?: SmokingStatus
  systolicBpMmHg?: number
  totalCholesterol?: UnitQuantityInput
}):
  | {
      ldlGoalEvaluation?: LdlGoalEvaluation
      status: 'complete'
      tierCode: 'ultra-high' | 'very-high' | 'high' | 'low-moderate'
      tierLabelEn: string
      tierLabelZh: string
      unit: 'mmol/L'
      value: number
    }
  | {
      missingInputs: ClinicalScoreMissingInput[]
      status: 'incomplete'
    } {
  const age = validateAdultAgeYears(input.ageYears)
  const ldlMmolL =
    input.ldlCholesterol === undefined
      ? undefined
      : normalizeLipidMmolL(input.ldlCholesterol.value, input.ldlCholesterol.unit, 'ldl')
  const tcMmolL =
    input.totalCholesterol === undefined
      ? undefined
      : normalizeLipidMmolL(input.totalCholesterol.value, input.totalCholesterol.unit, 'tc')
  const hdlMmolL =
    input.hdlCholesterol === undefined
      ? undefined
      : normalizeLipidMmolL(input.hdlCholesterol.value, input.hdlCholesterol.unit, 'hdl')
  if (input.systolicBpMmHg !== undefined) validateSystolicBpMmHg(input.systolicBpMmHg)
  if (input.egfrMlMin173m2 !== undefined) assertFiniteRange(input.egfrMlMin173m2, 1, 250, 'egfrMlMin173m2')

  const evaluateGoal = (target: number): LdlGoalEvaluation | undefined =>
    ldlMmolL === undefined
      ? undefined
      : {
          atGoal: ldlMmolL < target,
          currentLdlMmolL: roundTwoDecimals(ldlMmolL),
          targetLdlMmolL: target,
        }

  const hasAscvd = hasConfirmedAscvdDiagnosis(input.confirmedDiagnosisCodes) || input.knownCoronaryRevascularization === true
  const hasAcs = codeMatchesPrefixes(input.confirmedDiagnosisCodes, ACS_ICD10_PREFIXES)
  const hasDiabetes = hasConfirmedDiabetesDiagnosis(input.confirmedDiagnosisCodes)

  // 1. 已确诊 ASCVD 二级预防：ACS 或合并糖尿病/CKD G3b-G5 (eGFR < 45) 判定为超高危 (<1.4 mmol/L)，其余极高危 (<1.8 mmol/L)
  if (hasAscvd) {
    if (hasAcs || hasDiabetes || (input.egfrMlMin173m2 !== undefined && input.egfrMlMin173m2 < 45)) {
      const goal = evaluateGoal(1.4)
      return {
        ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
        status: 'complete',
        tierCode: 'ultra-high',
        tierLabelEn: 'Ultra-high risk (<1.4 mmol/L)',
        tierLabelZh: '超高危（目标 <1.4 mmol/L）',
        unit: 'mmol/L',
        value: 1.4,
      }
    }
    if (input.egfrMlMin173m2 === undefined) {
      return { missingInputs: ['serumCreatinine'], status: 'incomplete' }
    }
    const goal = evaluateGoal(1.8)
    return {
      ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
      status: 'complete',
      tierCode: 'very-high',
      tierLabelEn: 'Very-high risk (<1.8 mmol/L)',
      tierLabelZh: '极高危（目标 <1.8 mmol/L）',
      unit: 'mmol/L',
      value: 1.8,
    }
  }

  // 2. 糖尿病合并 CKD（eGFR < 60）或重度 CKD（eGFR < 30）直接判定极高危 (<1.8 mmol/L)
  if (hasDiabetes) {
    if (input.egfrMlMin173m2 === undefined) {
      return { missingInputs: ['serumCreatinine'], status: 'incomplete' }
    }
    if (input.egfrMlMin173m2 < 60) {
      const goal = evaluateGoal(1.8)
      return {
        ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
        status: 'complete',
        tierCode: 'very-high',
        tierLabelEn: 'Very-high risk (<1.8 mmol/L)',
        tierLabelZh: '极高危（目标 <1.8 mmol/L）',
        unit: 'mmol/L',
        value: 1.8,
      }
    }
    if (age >= 40) {
      const goal = evaluateGoal(2.6)
      return {
        ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
        status: 'complete',
        tierCode: 'high',
        tierLabelEn: 'High risk (<2.6 mmol/L)',
        tierLabelZh: '高危（目标 <2.6 mmol/L）',
        unit: 'mmol/L',
        value: 2.6,
      }
    }
  }

  if (input.egfrMlMin173m2 !== undefined && input.egfrMlMin173m2 < 30) {
    const goal = evaluateGoal(1.8)
    return {
      ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
      status: 'complete',
      tierCode: 'very-high',
      tierLabelEn: 'Very-high risk (<1.8 mmol/L)',
      tierLabelZh: '极高危（目标 <1.8 mmol/L）',
      unit: 'mmol/L',
      value: 1.8,
    }
  }

  // 原发性重度高胆固醇血症或 CKD 3 期（30 <= eGFR < 60）直接高危 (<2.6 mmol/L)
  if (
    (ldlMmolL !== undefined && ldlMmolL >= 4.9)
    || (tcMmolL !== undefined && tcMmolL >= 7.2)
    || (input.egfrMlMin173m2 !== undefined && input.egfrMlMin173m2 < 60)
  ) {
    const goal = evaluateGoal(2.6)
    return {
      ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
      status: 'complete',
      tierCode: 'high',
      tierLabelEn: 'High risk (<2.6 mmol/L)',
      tierLabelZh: '高危（目标 <2.6 mmol/L）',
      unit: 'mmol/L',
      value: 2.6,
    }
  }

  // 3. 低中危一级预防：严禁缺项默认阴性，必须具备吸烟状态、血压、血脂与肾功客观指标
  const missing: ClinicalScoreMissingInput[] = []
  if (input.sex === undefined) missing.push('sex')
  if (input.egfrMlMin173m2 === undefined) missing.push('serumCreatinine')
  if (input.systolicBpMmHg === undefined) missing.push('systolicBpMmHg')
  if (ldlMmolL === undefined && tcMmolL === undefined) missing.push('ldlCholesterol')
  if (hdlMmolL === undefined) missing.push('hdlCholesterol')
  if (input.smokingStatus === undefined) missing.push('smokingStatus')
  if (missing.length > 0) {
    return { missingInputs: missing, status: 'incomplete' }
  }

  const hasHypertension =
    hasConfirmedHypertensionDiagnosis(input.confirmedDiagnosisCodes)
    || input.antihypertensiveTreated === true
    || (input.systolicBpMmHg ?? 0) >= 140
  const ageFactor = input.sex === 'male' ? age >= 45 : age >= 55
  const riskFactors =
    (ageFactor ? 1 : 0)
    + (input.smokingStatus === 'current' ? 1 : 0)
    + ((hdlMmolL ?? 99) < 1.0 ? 1 : 0)

  if (hasHypertension && riskFactors >= 2) {
    const goal = evaluateGoal(2.6)
    return {
      ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
      status: 'complete',
      tierCode: 'high',
      tierLabelEn: 'High risk (<2.6 mmol/L)',
      tierLabelZh: '高危（目标 <2.6 mmol/L）',
      unit: 'mmol/L',
      value: 2.6,
    }
  }

  const goal = evaluateGoal(3.4)
  return {
    ...(goal === undefined ? {} : { ldlGoalEvaluation: goal }),
    status: 'complete',
    tierCode: 'low-moderate',
    tierLabelEn: 'Low-to-moderate risk (<3.4 mmol/L)',
    tierLabelZh: '低/中危（目标 <3.4 mmol/L）',
    unit: 'mmol/L',
    value: 3.4,
  }
}

const SCORE_METADATA: Record<ClinicalScoreId, { titleEn: string; titleZh: string; unit: string }> = {
  'ascvd-ldl-target': {
    titleEn: 'ASCVD Risk & LDL-C Target',
    titleZh: 'ASCVD 分层与 LDL-C 目标值',
    unit: 'mmol/L',
  },
  'ckd-epi-2021-egfr': {
    titleEn: 'CKD-EPI 2021 eGFR',
    titleZh: 'CKD-EPI 2021 估算肾小球滤过率 (eGFR)',
    unit: 'mL/min/1.73m2',
  },
  'cockcroft-gault-crcl': {
    titleEn: 'Cockcroft-Gault CrCl',
    titleZh: 'Cockcroft-Gault 肌酐清除率 (CrCl)',
    unit: 'mL/min',
  },
  'grace-acs': {
    titleEn: 'GRACE ACS Risk Score',
    titleZh: 'GRACE 急性冠脉综合征评分',
    unit: '分',
  },
  'precise-dapt': {
    titleEn: 'PRECISE-DAPT Bleeding Score',
    titleZh: 'PRECISE-DAPT 双抗出血风险评分',
    unit: '分',
  },
  'timi-ua-nstemi': {
    titleEn: 'TIMI UA/NSTEMI Risk Score',
    titleZh: 'TIMI 不稳定型心绞痛/NSTEMI 评分',
    unit: '分',
  },
}

export const MISSING_INPUT_LABELS: Record<ClinicalScoreMissingInput, { en: string; zh: string }> = {
  age: { en: 'Adult age (18–120 y)', zh: '成人年龄（18–120岁）' },
  anginaEpisodes24h: { en: '24h angina episodes', zh: '24h 心绞痛发作次数' },
  aspirinUsedLast7Days: { en: 'Aspirin in past 7d', zh: '近7天阿司匹林使用' },
  cardiacArrestOnAdmission: { en: 'Cardiac arrest on admission', zh: '入院心脏骤停' },
  elevatedCardiacBiomarker: { en: 'Cardiac troponin report', zh: '心肌损伤标志物报告' },
  hdlCholesterol: { en: 'HDL-C report', zh: '高密度脂蛋白胆固醇 (HDL-C)' },
  heartRateBpm: { en: 'Heart rate', zh: '心率/脉搏' },
  hemoglobin: { en: 'Hemoglobin report', zh: '血红蛋白 (Hb)' },
  killipClass: { en: 'Killip class', zh: 'Killip 心功能分级' },
  ldlCholesterol: { en: 'LDL-C / TC report', zh: '低密度脂蛋白或总胆固醇' },
  priorBleedingHistory: { en: 'Prior bleeding history', zh: '既往出血史' },
  serumCreatinine: { en: 'Serum creatinine report', zh: '血肌酐 (SCr)' },
  sex: { en: 'Biological sex', zh: '性别' },
  smokingStatus: { en: 'Smoking status', zh: '明确吸烟状态' },
  stSegmentDeviation: { en: 'ECG ST-segment status', zh: '心电图 ST 段偏移确认' },
  systolicBpMmHg: { en: 'Systolic BP', zh: '收缩压' },
  totalCholesterol: { en: 'Total cholesterol report', zh: '总胆固醇 (TC)' },
  wbc: { en: 'WBC count report', zh: '白细胞计数 (WBC)' },
  weightKg: { en: 'Body weight (kg)', zh: '体重 (kg)' },
}

function dedupeSources(sources: Array<ClinicalScoreSourceReference | undefined>): ClinicalScoreSourceReference[] {
  const seen = new Set<string>()
  const out: ClinicalScoreSourceReference[] = []
  for (const item of sources) {
    if (item === undefined) continue
    const key = `${item.reference}@${item.versionId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function buildIncomplete(
  id: ClinicalScoreId,
  missingInputs: ClinicalScoreMissingInput[],
  sources: Array<ClinicalScoreSourceReference | undefined>,
): ClinicalScoreResult {
  const uniqueMissing = [...new Set(missingInputs)] as [ClinicalScoreMissingInput, ...ClinicalScoreMissingInput[]]
  const meta = SCORE_METADATA[id]
  return {
    id,
    missingInputs: uniqueMissing,
    sourceReferences: dedupeSources(sources),
    status: 'incomplete',
    summaryEn: `Missing required inputs: ${uniqueMissing.map(key => MISSING_INPUT_LABELS[key].en).join(', ')}`,
    summaryZh: `待补齐：${uniqueMissing.map(key => MISSING_INPUT_LABELS[key].zh).join('、')}`,
    tierCode: null,
    tierLabelEn: null,
    tierLabelZh: null,
    titleEn: meta.titleEn,
    titleZh: meta.titleZh,
    unit: meta.unit,
    value: null,
  }
}

function safeParseFact<T, R>(fact: SourcedFact<T> | undefined, parse: (value: T) => R): SourcedFact<R> | undefined {
  if (fact === undefined) return undefined
  try {
    return {
      ...(fact.source === undefined ? {} : { source: fact.source }),
      value: parse(fact.value),
    }
  } catch {
    return undefined
  }
}

/** 从已确认客观临床指标集合确定性计算全部 6 项临床算子，严禁默认正常值或默认阴性凑分。 */
export function evaluateClinicalScores(facts: ClinicalScoreObjectiveFacts): ClinicalScoreResult[] {
  const adultAge = safeParseFact(facts.ageYears, validateAdultAgeYears)
  const sex = facts.sex
  const weightKg = safeParseFact(facts.weightKg, validateWeightKg)
  const heartRateBpm = safeParseFact(facts.heartRateBpm, validateHeartRateBpm)
  const systolicBpMmHg = safeParseFact(facts.systolicBpMmHg, validateSystolicBpMmHg)
  const scrValid = safeParseFact(facts.serumCreatinine, q => {
    normalizeCreatinineMgDl(q.value, q.unit)
    return q
  })
  const hbValid = safeParseFact(facts.hemoglobin, q => {
    normalizeHemoglobinGdl(q.value, q.unit)
    return q
  })
  const wbcValid = safeParseFact(facts.wbc, q => {
    normalizeWbc10e9L(q.value, q.unit)
    return q
  })
  const tcValid = safeParseFact(facts.totalCholesterol, q => {
    normalizeLipidMmolL(q.value, q.unit, 'tc')
    return q
  })
  const hdlValid = safeParseFact(facts.hdlCholesterol, q => {
    normalizeLipidMmolL(q.value, q.unit, 'hdl')
    return q
  })
  const ldlValid = safeParseFact(facts.ldlCholesterol, q => {
    normalizeLipidMmolL(q.value, q.unit, 'ldl')
    return q
  })

  // 1. CKD-EPI 2021 eGFR
  let egfrValue: number | undefined
  let egfrResult: ClinicalScoreResult
  {
    const missing: ClinicalScoreMissingInput[] = []
    if (adultAge === undefined) missing.push('age')
    if (sex === undefined) missing.push('sex')
    if (scrValid === undefined) missing.push('serumCreatinine')
    if (missing.length > 0) {
      egfrResult = buildIncomplete('ckd-epi-2021-egfr', missing, [adultAge?.source, sex?.source, scrValid?.source])
    } else {
      const calc = calculateCkdEpi2021Egfr({
        ageYears: adultAge!.value,
        serumCreatinine: scrValid!.value,
        sex: sex!.value,
      })
      egfrValue = calc.value
      const meta = SCORE_METADATA['ckd-epi-2021-egfr']
      egfrResult = {
        id: 'ckd-epi-2021-egfr',
        missingInputs: [],
        sourceReferences: dedupeSources([adultAge!.source, sex!.source, scrValid!.source]),
        status: 'complete',
        summaryEn: `${calc.value} ${calc.unit} · ${calc.tierLabelEn}`,
        summaryZh: `${calc.value} ${calc.unit} · ${calc.tierLabelZh}`,
        tierCode: calc.tierCode,
        tierLabelEn: calc.tierLabelEn,
        tierLabelZh: calc.tierLabelZh,
        titleEn: meta.titleEn,
        titleZh: meta.titleZh,
        unit: calc.unit,
        value: calc.value,
      }
    }
  }

  // 2. Cockcroft-Gault CrCl
  let crClValue: number | undefined
  let crClResult: ClinicalScoreResult
  {
    const missing: ClinicalScoreMissingInput[] = []
    if (adultAge === undefined) missing.push('age')
    if (sex === undefined) missing.push('sex')
    if (weightKg === undefined) missing.push('weightKg')
    if (scrValid === undefined) missing.push('serumCreatinine')
    if (missing.length > 0) {
      crClResult = buildIncomplete('cockcroft-gault-crcl', missing, [
        adultAge?.source,
        sex?.source,
        weightKg?.source,
        scrValid?.source,
      ])
    } else {
      const calc = calculateCockcroftGaultCrCl({
        ageYears: adultAge!.value,
        serumCreatinine: scrValid!.value,
        sex: sex!.value,
        weightKg: weightKg!.value,
      })
      crClValue = calc.value
      const meta = SCORE_METADATA['cockcroft-gault-crcl']
      crClResult = {
        id: 'cockcroft-gault-crcl',
        missingInputs: [],
        sourceReferences: dedupeSources([adultAge!.source, sex!.source, weightKg!.source, scrValid!.source]),
        status: 'complete',
        summaryEn: `${calc.value} ${calc.unit} · ${calc.tierLabelEn}`,
        summaryZh: `${calc.value} ${calc.unit} · ${calc.tierLabelZh}`,
        tierCode: calc.tierCode,
        tierLabelEn: calc.tierLabelEn,
        tierLabelZh: calc.tierLabelZh,
        titleEn: meta.titleEn,
        titleZh: meta.titleZh,
        unit: calc.unit,
        value: calc.value,
      }
    }
  }

  // 3. GRACE ACS
  let graceResult: ClinicalScoreResult
  {
    const missing: ClinicalScoreMissingInput[] = []
    if (adultAge === undefined) missing.push('age')
    if (heartRateBpm === undefined) missing.push('heartRateBpm')
    if (systolicBpMmHg === undefined) missing.push('systolicBpMmHg')
    if (scrValid === undefined) missing.push('serumCreatinine')
    if (facts.killipClass === undefined) missing.push('killipClass')
    if (facts.cardiacArrestOnAdmission === undefined) missing.push('cardiacArrestOnAdmission')
    if (facts.stSegmentDeviation === undefined) missing.push('stSegmentDeviation')
    if (facts.elevatedCardiacBiomarker === undefined) missing.push('elevatedCardiacBiomarker')
    const sources = [
      adultAge?.source,
      heartRateBpm?.source,
      systolicBpMmHg?.source,
      scrValid?.source,
      facts.killipClass?.source,
      facts.cardiacArrestOnAdmission?.source,
      facts.stSegmentDeviation?.source,
      facts.elevatedCardiacBiomarker?.source,
    ]
    if (missing.length > 0) {
      graceResult = buildIncomplete('grace-acs', missing, sources)
    } else {
      const calc = calculateGraceAcs({
        ageYears: adultAge!.value,
        cardiacArrestOnAdmission: facts.cardiacArrestOnAdmission!.value,
        elevatedCardiacBiomarker: facts.elevatedCardiacBiomarker!.value,
        heartRateBpm: heartRateBpm!.value,
        killipClass: facts.killipClass!.value,
        serumCreatinine: scrValid!.value,
        stSegmentDeviation: facts.stSegmentDeviation!.value,
        systolicBpMmHg: systolicBpMmHg!.value,
      })
      const meta = SCORE_METADATA['grace-acs']
      graceResult = {
        id: 'grace-acs',
        missingInputs: [],
        sourceReferences: dedupeSources(sources),
        status: 'complete',
        summaryEn: `${calc.value} pts · ${calc.tierLabelEn}`,
        summaryZh: `${calc.value} ${calc.unit} · ${calc.tierLabelZh}`,
        tierCode: calc.tierCode,
        tierLabelEn: calc.tierLabelEn,
        tierLabelZh: calc.tierLabelZh,
        titleEn: meta.titleEn,
        titleZh: meta.titleZh,
        unit: calc.unit,
        value: calc.value,
      }
    }
  }

  // 4. TIMI UA/NSTEMI
  let timiResult: ClinicalScoreResult
  {
    const diagnosisCodes = facts.confirmedDiagnoses.map(item => item.code)
    const hasHtn =
      hasConfirmedHypertensionDiagnosis(diagnosisCodes)
      || facts.antihypertensiveMedicationActive?.value === true
    const hasDm = hasConfirmedDiabetesDiagnosis(diagnosisCodes)
    const ldlMmol = ldlValid === undefined ? undefined : normalizeLipidMmolL(ldlValid.value.value, ldlValid.value.unit, 'ldl')
    const tcMmol = tcValid === undefined ? undefined : normalizeLipidMmolL(tcValid.value.value, tcValid.value.unit, 'tc')
    const hasDyslipidemia =
      codeMatchesPrefixes(diagnosisCodes, DYSLIPIDEMIA_ICD10_PREFIXES)
      || (ldlMmol !== undefined && ldlMmol >= 3.4)
      || (tcMmol !== undefined && tcMmol >= 5.2)
    const nonSmokingFactors = (hasHtn ? 1 : 0) + (hasDm ? 1 : 0) + (hasDyslipidemia ? 1 : 0)
    const knownCad =
      facts.knownCoronaryRevascularizationOrStenosisGe50 !== undefined
        ? facts.knownCoronaryRevascularizationOrStenosisGe50.value
        : codeMatchesPrefixes(diagnosisCodes, ['Z95.1', 'Z95.5', 'Z98.61', 'I25.2'])

    const missing: ClinicalScoreMissingInput[] = []
    if (adultAge === undefined) missing.push('age')
    if (nonSmokingFactors < 3 && facts.smokingStatus === undefined) missing.push('smokingStatus')
    if (facts.aspirinUsedLast7Days === undefined) missing.push('aspirinUsedLast7Days')
    if (facts.anginaEpisodes24h === undefined) missing.push('anginaEpisodes24h')
    if (facts.stSegmentDeviation === undefined) missing.push('stSegmentDeviation')
    if (facts.elevatedCardiacBiomarker === undefined) missing.push('elevatedCardiacBiomarker')
    const sources = [
      adultAge?.source,
      ...facts.confirmedDiagnoses.map(item => item.source),
      facts.antihypertensiveMedicationActive?.source,
      facts.knownCoronaryRevascularizationOrStenosisGe50?.source,
      facts.smokingStatus?.source,
      facts.aspirinUsedLast7Days?.source,
      facts.anginaEpisodes24h?.source,
      facts.stSegmentDeviation?.source,
      facts.elevatedCardiacBiomarker?.source,
      ldlValid?.source,
      tcValid?.source,
    ]
    if (missing.length > 0) {
      timiResult = buildIncomplete('timi-ua-nstemi', missing, sources)
    } else {
      const cadRiskFactorCount = nonSmokingFactors + (facts.smokingStatus?.value === 'current' ? 1 : 0)
      const calc = calculateTimiUaNstemi({
        ageYears: adultAge!.value,
        anginaEpisodes24h: facts.anginaEpisodes24h!.value,
        aspirinUsedLast7Days: facts.aspirinUsedLast7Days!.value,
        cadRiskFactorCount,
        elevatedCardiacBiomarker: facts.elevatedCardiacBiomarker!.value,
        knownCoronaryStenosisGe50Pct: knownCad,
        stSegmentDeviation: facts.stSegmentDeviation!.value,
      })
      const meta = SCORE_METADATA['timi-ua-nstemi']
      timiResult = {
        id: 'timi-ua-nstemi',
        missingInputs: [],
        sourceReferences: dedupeSources(sources),
        status: 'complete',
        summaryEn: `${calc.value}/7 · ${calc.tierLabelEn}`,
        summaryZh: `${calc.value}/7 ${calc.unit} · ${calc.tierLabelZh}`,
        tierCode: calc.tierCode,
        tierLabelEn: calc.tierLabelEn,
        tierLabelZh: calc.tierLabelZh,
        titleEn: meta.titleEn,
        titleZh: meta.titleZh,
        unit: calc.unit,
        value: calc.value,
      }
    }
  }

  // 5. PRECISE-DAPT
  let preciseDaptResult: ClinicalScoreResult
  {
    const missing: ClinicalScoreMissingInput[] = []
    if (adultAge === undefined) missing.push('age')
    if (sex === undefined) missing.push('sex')
    if (weightKg === undefined) missing.push('weightKg')
    if (scrValid === undefined) missing.push('serumCreatinine')
    if (hbValid === undefined) missing.push('hemoglobin')
    if (wbcValid === undefined) missing.push('wbc')
    if (facts.priorBleedingHistory === undefined) missing.push('priorBleedingHistory')
    const sources = [
      adultAge?.source,
      sex?.source,
      weightKg?.source,
      scrValid?.source,
      hbValid?.source,
      wbcValid?.source,
      facts.priorBleedingHistory?.source,
    ]
    if (missing.length > 0 || crClValue === undefined) {
      preciseDaptResult = buildIncomplete(
        'precise-dapt',
        missing.length > 0 ? missing : ['serumCreatinine'],
        sources,
      )
    } else {
      const calc = calculatePreciseDapt({
        ageYears: adultAge!.value,
        creatinineClearanceMlMin: crClValue,
        hemoglobin: hbValid!.value,
        priorBleedingHistory: facts.priorBleedingHistory!.value,
        wbc: wbcValid!.value,
      })
      const meta = SCORE_METADATA['precise-dapt']
      preciseDaptResult = {
        id: 'precise-dapt',
        missingInputs: [],
        sourceReferences: dedupeSources(sources),
        status: 'complete',
        summaryEn: `${calc.value} pts · ${calc.tierLabelEn}`,
        summaryZh: `${calc.value} ${calc.unit} · ${calc.tierLabelZh}`,
        tierCode: calc.tierCode,
        tierLabelEn: calc.tierLabelEn,
        tierLabelZh: calc.tierLabelZh,
        titleEn: meta.titleEn,
        titleZh: meta.titleZh,
        unit: calc.unit,
        value: calc.value,
      }
    }
  }

  // 6. ASCVD & LDL-C Target
  let ascvdResult: ClinicalScoreResult
  {
    const diagnosisCodes = facts.confirmedDiagnoses.map(item => item.code)
    const sources = [
      adultAge?.source,
      sex?.source,
      ...facts.confirmedDiagnoses.map(item => item.source),
      facts.knownCoronaryRevascularizationOrStenosisGe50?.source,
      scrValid?.source,
      systolicBpMmHg?.source,
      facts.antihypertensiveMedicationActive?.source,
      facts.smokingStatus?.source,
      ldlValid?.source,
      tcValid?.source,
      hdlValid?.source,
    ]
    if (adultAge === undefined) {
      ascvdResult = buildIncomplete('ascvd-ldl-target', ['age'], sources)
    } else {
      const calc = calculateAscvdLdlTarget({
        ageYears: adultAge.value,
        ...(facts.antihypertensiveMedicationActive === undefined
          ? {}
          : { antihypertensiveTreated: facts.antihypertensiveMedicationActive.value }),
        confirmedDiagnosisCodes: diagnosisCodes,
        ...(egfrValue === undefined ? {} : { egfrMlMin173m2: egfrValue }),
        ...(hdlValid === undefined ? {} : { hdlCholesterol: hdlValid.value }),
        ...(facts.knownCoronaryRevascularizationOrStenosisGe50 === undefined
          ? {}
          : { knownCoronaryRevascularization: facts.knownCoronaryRevascularizationOrStenosisGe50.value }),
        ...(ldlValid === undefined ? {} : { ldlCholesterol: ldlValid.value }),
        ...(sex === undefined ? {} : { sex: sex.value }),
        ...(facts.smokingStatus === undefined ? {} : { smokingStatus: facts.smokingStatus.value }),
        ...(systolicBpMmHg === undefined ? {} : { systolicBpMmHg: systolicBpMmHg.value }),
        ...(tcValid === undefined ? {} : { totalCholesterol: tcValid.value }),
      })
      if (calc.status === 'incomplete') {
        ascvdResult = buildIncomplete('ascvd-ldl-target', calc.missingInputs, sources)
      } else {
        const meta = SCORE_METADATA['ascvd-ldl-target']
        const goalNoteZh =
          calc.ldlGoalEvaluation === undefined
            ? ''
            : calc.ldlGoalEvaluation.atGoal
              ? `（当前 LDL-C ${calc.ldlGoalEvaluation.currentLdlMmolL} mmol/L，已达标）`
              : `（当前 LDL-C ${calc.ldlGoalEvaluation.currentLdlMmolL} mmol/L，未达标）`
        const goalNoteEn =
          calc.ldlGoalEvaluation === undefined
            ? ''
            : calc.ldlGoalEvaluation.atGoal
              ? ` (Current LDL-C ${calc.ldlGoalEvaluation.currentLdlMmolL} mmol/L, at goal)`
              : ` (Current LDL-C ${calc.ldlGoalEvaluation.currentLdlMmolL} mmol/L, above goal)`
        ascvdResult = {
          id: 'ascvd-ldl-target',
          ...(calc.ldlGoalEvaluation === undefined ? {} : { ldlGoalEvaluation: calc.ldlGoalEvaluation }),
          missingInputs: [],
          sourceReferences: dedupeSources(sources),
          status: 'complete',
          summaryEn: `${calc.tierLabelEn}${goalNoteEn}`,
          summaryZh: `${calc.tierLabelZh}${goalNoteZh}`,
          tierCode: calc.tierCode,
          tierLabelEn: calc.tierLabelEn,
          tierLabelZh: calc.tierLabelZh,
          titleEn: meta.titleEn,
          titleZh: meta.titleZh,
          unit: calc.unit,
          value: calc.value,
        }
      }
    }
  }

  return [egfrResult, crClResult, graceResult, timiResult, preciseDaptResult, ascvdResult]
}
