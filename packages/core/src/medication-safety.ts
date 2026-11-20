import { medicationFrequencySchema, type MedicationFrequency, type MedicationSafetyRule } from '@clinmesh/contracts/medication-safety'

const exclusiveClasses = [['acei', 'arb'], ['acei', 'arni'], ['arb', 'arni'], ['p2y12', 'p2y12'], ['statin', 'statin']] as const

export function medicationCombinationConflict(left: readonly string[], right: readonly string[]): boolean {
  return exclusiveClasses.some(([a, b]) => (left.includes(a) && right.includes(b)) || (left.includes(b) && right.includes(a)))
}

export function medicationIndicationMatches(prefixes: readonly string[], diagnosisCodes: readonly string[]): boolean {
  return diagnosisCodes.some(code => prefixes.some(prefix => code.toUpperCase().startsWith(prefix.toUpperCase())))
}

export function medicationScheduledHours(frequency: MedicationFrequency): readonly number[] {
  return { QD: [8], BID: [8, 20], TID: [8, 14, 20], QN: [22], PRN: [], ONCE: [] }[frequency]
}

const frequencyDisplayCatalog: Readonly<Record<string, readonly [zh: string, en: string, time: string]>> = {
  QD: ['每日一次', 'Once daily', '08:00'],
  BID: ['每日两次', 'Twice daily', '08:00、20:00'],
  TID: ['每日三次', 'Three times daily', '08:00、14:00、20:00'],
  QN: ['每晚一次', 'Every night', '22:00'],
  PRN: ['必要时', 'As needed', ''],
  ONCE: ['仅一次', 'Once only', ''],
}

/** 统一展示给药频次（中文全角括号、英文半角括号），可选附加住院执行时点；未知自定义频次原样保留。 */
export function formatMedicationFrequency(
  code: string,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  options?: { withTime?: boolean },
): string {
  const normalized = code.trim().toUpperCase()
  const entry = frequencyDisplayCatalog[normalized]
  if (entry === undefined) return code
  const [zh, en, time] = entry
  const base = locale === 'zh-CN' ? `${zh}（${normalized}）` : `${en} (${normalized})`
  if (!options?.withTime || !time) return base
  return `${base} · ${locale === 'zh-CN' ? time : time.replaceAll('、', ', ')}`
}

/** PRN 按每日最多四次的保守上界审方；执行仍须单独记录每次给药。 */
export function medicationDailyFrequency(frequency: MedicationFrequency): number {
  return frequency === 'PRN' ? 4 : frequency === 'ONCE' ? 1 : medicationScheduledHours(frequency).length
}

export function medicationDoseConflict(limits: MedicationSafetyRule['doseLimits'], doseText: string, frequency: MedicationFrequency): 'invalid-dose' | 'single-dose' | 'daily-dose' | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(mg|g|mL|IU)\s*$/i.exec(doseText)
  if (!match) return 'invalid-dose'
  const source = match[2]!.toLowerCase(), target = limits.unit.toLowerCase()
  const multiplier = source === target ? 1 : source === 'g' && target === 'mg' ? 1000 : source === 'mg' && target === 'g' ? 0.001 : undefined
  if (multiplier === undefined) return 'invalid-dose'
  const amount = Number(match[1]) * multiplier
  if (!Number.isFinite(amount) || amount < limits.minimumSingleDose || amount > limits.maximumSingleDose) return 'single-dose'
  if (amount * medicationDailyFrequency(frequency) > limits.maximumDailyDose) return 'daily-dose'
  return undefined
}

export function medicationRegimenDoseAllowed(config: { safety?: MedicationSafetyRule | undefined; allowedDoseTexts: readonly string[]; allowedFrequencyCodes: readonly string[] }, doseText: string, frequency: string): boolean {
  if (!config.allowedFrequencyCodes.includes(frequency)) return false
  if (!config.safety) return config.allowedDoseTexts.includes(doseText)
  const parsed = medicationFrequencySchema.safeParse(frequency)
  return parsed.success && medicationDoseConflict(config.safety.doseLimits, doseText, parsed.data) === undefined
}

export function medicationQuantityAllowed(
  config: { safety?: MedicationSafetyRule | undefined; allowedQuantities: readonly number[] },
  quantity: number,
  courseDays: number,
  frequencyCode?: string,
): boolean {
  const effectiveDays = frequencyCode === 'ONCE' ? 1 : courseDays
  return config.safety
    ? Number.isSafeInteger(quantity) && quantity > 0 && quantity <= Math.min(1000, config.safety.maximumDailyQuantity * effectiveDays)
    : config.allowedQuantities.includes(quantity)
}
