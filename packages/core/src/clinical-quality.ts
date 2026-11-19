import type {
  ClinicalOverrideInput,
  ClinicalQualityAlert,
  ClinicalQualityRedLine,
} from '@clinmesh/contracts/clinical-quality'
import { medicationFrequencySchema, type MedicationSafetyRule } from '@clinmesh/contracts/medication-safety'
import { formatMedicationFrequency, medicationCombinationConflict, medicationDoseConflict } from './medication-safety.ts'

/** 事中临床质控的无 I/O 规则；服务端负责从正式临床事实取数。阈值与药品类别均为本院合成规则，不构成处方建议。 */
export interface QualityEvidence { label: string; reference: string; versionId?: string }
export interface QualityMedication {
  catalogItemId: string
  display: string
  pharmacologyClasses: readonly string[]
  doseLimits?: MedicationSafetyRule['doseLimits'] | undefined
  doseText?: string | undefined
  frequencyCode?: string | undefined
}

/** 已证实 eGFR < 30 时禁用的降糖药理类别（二甲双胍、达格列净）。 */
export const renalContraindicatedClasses = ['biguanide', 'sglt2'] as const
/** 肾排泄高危药：开立前需要近期血肌酐依据。 */
export const renalMonitoredClasses = ['biguanide', 'sglt2', 'mra'] as const
const antibacterialClasses = ['penicillin', 'cephalosporin', 'macrolide', 'fluoroquinolone', 'tetracycline', 'aminoglycoside', 'carbapenem'] as const
/** 单纯病毒感染诊断前缀：普通感冒、急性上呼吸道感染、流感、病毒性肺炎与未特指病毒感染。 */
const viralDiagnosisPrefixes = ['J00', 'J06', 'J09', 'J10', 'J11', 'J12', 'B34', 'B97'] as const
const antiplateletClasses = ['antiplatelet-aspirin', 'p2y12'] as const
/** 冠心病/PCI 出院二级预防追踪的长期医嘱药理类别。 */
export const secondaryPreventionClasses = [...antiplateletClasses, 'statin'] as const

const hasClass = (medication: QualityMedication, classes: readonly string[]) => medication.pharmacologyClasses.some(item => classes.includes(item))
const redLine = (code: ClinicalQualityRedLine['code'], message: string, evidence: QualityEvidence[], catalogItemId?: string): ClinicalQualityRedLine =>
  ({ code, tier: 'red-line', message, evidence: evidence.slice(0, 8), ...(catalogItemId === undefined ? {} : { catalogItemId }) })
const alert = (code: ClinicalQualityAlert['code'], message: string, evidence: QualityEvidence[], catalogItemId?: string): ClinicalQualityAlert =>
  ({ code, tier: 'alert', message, evidence: evidence.slice(0, 8), ...(catalogItemId === undefined ? {} : { catalogItemId }) })

export type RenalFunctionFact =
  | { status: 'measured'; egfr: number; evidence: QualityEvidence[] }
  | { status: 'creatinine-missing' }
  | { status: 'not-computable' }

/** 区分已证实 eGFR < 30（红线）与尚无近期血肌酐（可说明原因的条件警示）；首诊缺肌酐不锁死流程。 */
export function renalMedicationFindings(medications: readonly QualityMedication[], renal: RenalFunctionFact) {
  const redLines: ClinicalQualityRedLine[] = [], alerts: ClinicalQualityAlert[] = []
  for (const medication of medications) {
    if (renal.status === 'measured' && renal.egfr < 30 && hasClass(medication, renalContraindicatedClasses)) {
      redLines.push(redLine('RENAL_CONTRAINDICATED_MEDICATION',
        `已证实 eGFR ${Math.round(renal.egfr * 10) / 10} mL/min/1.73m² < 30，禁止开立${medication.display}。`, renal.evidence, medication.catalogItemId))
    } else if (renal.status === 'creatinine-missing' && hasClass(medication, renalMonitoredClasses)) {
      alerts.push(alert('RENAL_CREATININE_MISSING',
        `${medication.display}经肾排泄，本次就诊尚无近期血肌酐与 eGFR 依据；请先开立血肌酐，或说明原因后提交。`, [], medication.catalogItemId))
    }
  }
  return { redLines, alerts }
}

/** 超单次或单日极量、剂量单位不可换算时直接作为药事安全红线拦截。 */
export function doseLimitFindings(medications: readonly QualityMedication[]): ClinicalQualityRedLine[] {
  const findings: ClinicalQualityRedLine[] = []
  for (const medication of medications) {
    if (medication.doseLimits === undefined || medication.doseText === undefined || medication.frequencyCode === undefined) continue
    const parsedFrequency = medicationFrequencySchema.safeParse(medication.frequencyCode)
    const conflict = parsedFrequency.success ? medicationDoseConflict(medication.doseLimits, medication.doseText, parsedFrequency.data) : 'invalid-dose'
    if (conflict !== undefined) {
      const reason = conflict === 'daily-dose' ? `超出单日极量（${medication.doseLimits.maximumDailyDose}${medication.doseLimits.unit}/d）`
        : conflict === 'single-dose' ? `超出单次剂量范围（${medication.doseLimits.minimumSingleDose}–${medication.doseLimits.maximumSingleDose}${medication.doseLimits.unit}）`
        : '剂量单位或频次超出受控范围'
      findings.push(redLine('MEDICATION_DOSE_LIMIT_EXCEEDED',
        `${medication.display}给药方案（${medication.doseText} ${formatMedicationFrequency(medication.frequencyCode, 'zh-CN')}）${reason}，禁止开立。`, [], medication.catalogItemId))
    }
  }
  return findings
}

/** 同药理类别互斥叠加（含新开药品之间、与在用医嘱之间）。 */
export function classDuplicationFindings(candidates: readonly QualityMedication[], active: readonly QualityMedication[] = []): ClinicalQualityRedLine[] {
  const findings: ClinicalQualityRedLine[] = []
  candidates.forEach((medication, index) => {
    const others = [...candidates.slice(0, index), ...active]
    const conflict = others.find(other => other.catalogItemId === medication.catalogItemId
      || medicationCombinationConflict(medication.pharmacologyClasses, other.pharmacologyClasses))
    if (conflict) findings.push(redLine('MEDICATION_CLASS_DUPLICATION', `药品组合存在药理类别互斥：${medication.display}与${conflict.display}不能叠加开立。`, [], medication.catalogItemId))
  })
  return findings
}

export function antibioticIndicationFindings(medications: readonly QualityMedication[], diagnosisCodes: readonly string[]): ClinicalQualityAlert[] {
  const codes = diagnosisCodes.map(code => code.trim().toUpperCase()).filter(Boolean)
  if (codes.length === 0 || !codes.every(code => viralDiagnosisPrefixes.some(prefix => code.startsWith(prefix)))) return []
  return medications.filter(medication => hasClass(medication, antibacterialClasses)).map(medication => alert('ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION',
    `当前确认诊断均为单纯病毒感染（${codes.join('、')}），无细菌感染指征开立抗菌药${medication.display}；请补充细菌感染诊断，或说明原因后提交。`, [], medication.catalogItemId))
}

export function chestPainWorkupFindings(input: { presentation?: QualityEvidence | undefined; ecg?: QualityEvidence | undefined; troponin?: QualityEvidence | undefined }): ClinicalQualityAlert[] {
  if (input.presentation === undefined || (input.ecg !== undefined && input.troponin !== undefined)) return []
  const missing = [input.ecg === undefined ? '12 导联心电图' : undefined, input.troponin === undefined ? '心肌肌钙蛋白' : undefined].filter(Boolean)
  return [alert('CHEST_PAIN_WORKUP_INCOMPLETE', `急性胸痛就诊尚未完成${missing.join('与')}即拟完诊；请补齐检查，或说明原因后完诊。`,
    [input.presentation, ...(input.ecg ? [input.ecg] : []), ...(input.troponin ? [input.troponin] : [])])]
}

export interface QualityVesselFinding { vessel: string; segment: string; stenosisPercent: number; ffr?: number | null | undefined }

/** 造影功能学提示非缺血临界病变（FFR > 0.80）且没有任何缺血（FFR <= 0.80）或重度狭窄（>= 90%）依据时，提示过度介入。 */
export function nonIschemicPciFindings(vessels: readonly QualityVesselFinding[], report: QualityEvidence | undefined): ClinicalQualityAlert[] {
  const measured = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
  const nonIschemic = vessels.filter(vessel => measured(vessel.ffr) && vessel.ffr > 0.8)
  const ischemic = vessels.some(vessel => (measured(vessel.ffr) && vessel.ffr <= 0.8) || vessel.stenosisPercent >= 90)
  if (nonIschemic.length === 0 || ischemic) return []
  const summary = nonIschemic.map(vessel => `${vessel.vessel}(${vessel.segment}) 狭窄 ${vessel.stenosisPercent}%，FFR ${vessel.ffr}`).join('；')
  return [alert('PCI_NON_ISCHEMIC_LESION', `造影功能学提示非缺血临界病变（${summary}），仍拟行 PCI 支架计划；请复核血运重建指征，或说明原因后提交。`, report ? [report] : [])]
}

/** 冠心病或 PCI 出院时须有抗血小板与他汀长期医嘱；有禁忌时登记 Clinical Override。 */
export function dischargeSecondaryPreventionFindings(input: { cad?: QualityEvidence | undefined; longTermClasses: readonly string[] }): ClinicalQualityAlert[] {
  if (input.cad === undefined) return []
  const findings: ClinicalQualityAlert[] = []
  if (!input.longTermClasses.some(item => antiplateletClasses.some(value => value === item))) {
    findings.push(alert('DISCHARGE_ANTIPLATELET_MISSING', '冠心病/PCI 患者出院前未见在用抗血小板长期医嘱；请补开，或登记禁忌原因后提交。', [input.cad]))
  }
  if (!input.longTermClasses.includes('statin')) {
    findings.push(alert('DISCHARGE_STATIN_MISSING', '冠心病/PCI 患者出院前未见在用他汀长期医嘱；请补开，或登记禁忌原因后提交。', [input.cad]))
  }
  return findings
}

/** 有效越权须逐项确认当前全部警示代码；多余的确认不产生留痕。 */
export function clinicalOverrideCovers(override: ClinicalOverrideInput | undefined, alerts: readonly ClinicalQualityAlert[]): boolean {
  return override !== undefined && alerts.every(item => override.acknowledgedAlerts.includes(item.code))
}
