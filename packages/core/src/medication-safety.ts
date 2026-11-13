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

export function medicationQuantityAllowed(config: { safety?: MedicationSafetyRule | undefined; allowedQuantities: readonly number[] }, quantity: number, courseDays: number): boolean {
  return config.safety ? Number.isSafeInteger(quantity) && quantity > 0 && quantity <= Math.min(1000, config.safety.maximumDailyQuantity * courseDays) : config.allowedQuantities.includes(quantity)
}
