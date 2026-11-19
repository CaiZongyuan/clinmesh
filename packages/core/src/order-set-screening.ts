import type {
  OrderSetDisposition,
  OrderSetReason,
  OrderSetScreeningRule,
} from '@clinmesh/contracts/order-set-templates'
import type { MedicationFrequency } from '@clinmesh/contracts/medication-safety'
import { medicationDailyFrequency } from './medication-safety.ts'

/** 已落库客观事实；null 表示未记录，筛选时只能标注待核实，不能视为正常。 */
export interface OrderSetScreeningFact {
  reference: string | null
  value: number
}

export interface OrderSetScreeningFacts {
  egfr: OrderSetScreeningFact | null
  pulseBpm: OrderSetScreeningFact | null
  systolicMmHg: OrderSetScreeningFact | null
  weightKg: OrderSetScreeningFact | null
}

const inputLabels: Record<OrderSetScreeningRule['input'], { label: string; unit: string }> = {
  egfr: { label: 'eGFR（CKD-EPI 2021）', unit: ' mL/min/1.73m²' },
  pulseBpm: { label: '心率', unit: ' 次/分' },
  systolicMmHg: { label: '收缩压', unit: ' mmHg' },
  weightKg: { label: '体重', unit: ' kg' },
}

const missingReasons = {
  egfr: { code: 'egfr-missing', messageZh: '缺少可计算 eGFR（CKD-EPI 2021）的血肌酐或人口学资料，不按肾功能正常处理' },
  pulseBpm: { code: 'vital-signs-missing', messageZh: '缺少最新结构化生命体征（心率、收缩压），不按正常值处理' },
  systolicMmHg: { code: 'vital-signs-missing', messageZh: '缺少最新结构化生命体征（心率、收缩压），不按正常值处理' },
  weightKg: { code: 'weight-missing', messageZh: '缺少体重记录，无法按体重核定剂量或滴速' },
} as const

const thresholdCodes = {
  egfr: { 'at-least': 'egfr-at-or-above-threshold', below: 'egfr-below-threshold' },
  pulseBpm: { 'at-least': undefined, below: 'pulse-below-threshold' },
  systolicMmHg: { 'at-least': undefined, below: 'systolic-below-threshold' },
  weightKg: { 'at-least': undefined, below: undefined },
} as const

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 按声明式规则筛选单个组套候选；同一缺失输入只报告一次待核实，
 * 且缺失时不再继续评估依赖该输入的阈值规则。
 */
export function screenOrderSetRules(rules: readonly OrderSetScreeningRule[], facts: OrderSetScreeningFacts): OrderSetReason[] {
  const reasons: OrderSetReason[] = []
  const missingCodes = new Set<string>()
  for (const rule of rules) {
    const fact = facts[rule.input]
    if (fact === null) {
      const missing = missingReasons[rule.input]
      if (!missingCodes.has(missing.code)) {
        missingCodes.add(missing.code)
        reasons.push({
          code: missing.code,
          messageZh: `${missing.messageZh}；${rule.rationaleZh}，须核实后再开立。`,
          observedValue: null,
          severity: 'pending-verification',
          sourceReference: null,
          threshold: null,
        })
      }
      continue
    }
    if (rule.comparator === 'required' || rule.threshold === null) continue
    const matched = rule.comparator === 'below' ? fact.value < rule.threshold : fact.value >= rule.threshold
    const code = thresholdCodes[rule.input][rule.comparator]
    if (!matched || code === undefined) continue
    const { label, unit } = inputLabels[rule.input]
    const relation = rule.comparator === 'below' ? '低于' : '达到或高于'
    reasons.push({
      code,
      messageZh: `${label} ${rounded(fact.value)}${unit} ${relation} ${rule.threshold}${unit}：${rule.rationaleZh}。`,
      observedValue: rounded(fact.value),
      severity: rule.action,
      sourceReference: fact.reference,
      threshold: rule.threshold,
    })
  }
  return reasons
}

export function orderSetAllergyReason(allergy: { code: string; display: string; reference: string }): OrderSetReason {
  return {
    allergen: { code: allergy.code, display: allergy.display },
    code: 'allergy-contraindication',
    messageZh: `患者存在已确认的有效药物过敏（${allergy.display}，编码 ${allergy.code}），组套剔除该药。`,
    observedValue: null,
    severity: 'exclude',
    sourceReference: allergy.reference,
    threshold: null,
  }
}

export function orderSetDisposition(reasons: readonly OrderSetReason[]): OrderSetDisposition {
  if (reasons.some(reason => reason.severity === 'unavailable')) return 'unavailable'
  if (reasons.some(reason => reason.severity === 'exclude')) return 'excluded'
  if (reasons.some(reason => reason.severity === 'caution' || reason.severity === 'pending-verification')) return 'needs-review'
  return 'ready'
}

const amountPattern = /^\s*(\d+(?:\.\d+)?)\s*(mg|g|mL|IU)\b/i

function normalizedAmount(text: string): { amount: number; unit: string } | undefined {
  const match = amountPattern.exec(text)
  if (match === null) return undefined
  const unit = match[2]!.toLowerCase()
  const amount = Number(match[1])
  return unit === 'g' ? { amount: amount * 1000, unit: 'mg' } : { amount, unit }
}

/**
 * 门诊发药数量 = 每次制剂数 × 每日次数 × 疗程天数；PRN 使用模板声明的固定数量。
 * 剂量不能被规格整除时返回 undefined，由调用方标为目录规则不符。
 */
export function orderSetOutpatientQuantity(input: {
  courseDays: number
  doseText: string
  frequencyCode: MedicationFrequency
  prnQuantity?: number | undefined
  strength: string
}): number | undefined {
  if (input.frequencyCode === 'PRN') return input.prnQuantity
  const dose = normalizedAmount(input.doseText), strength = normalizedAmount(input.strength)
  if (dose === undefined || strength === undefined || dose.unit !== strength.unit || strength.amount <= 0) return undefined
  const unitsPerDose = dose.amount / strength.amount
  if (Math.abs(unitsPerDose - Math.round(unitsPerDose)) > 1e-9 || Math.round(unitsPerDose) < 1) return undefined
  const days = input.frequencyCode === 'ONCE' ? 1 : input.courseDays
  return Math.round(unitsPerDose) * medicationDailyFrequency(input.frequencyCode) * days
}
