export interface InpatientDoseConfiguration {
  unit: string
  doseBasis?: { amount: number; unit: string }
  maxDoseQuantity?: number
  doses: readonly { doseText: string; quantity: number }[]
}

export type InpatientDoseResult = { quantity: number } | {
  reason: 'invalid-dose' | 'missing-conversion' | 'unit-mismatch' | 'fractional-quantity' | 'dose-limit'
}

const massUnits = new Map<string, bigint>([['g', 1_000_000n], ['mg', 1_000n], ['ug', 1n], ['μg', 1n], ['µg', 1n], ['mcg', 1n]])

function fraction(value: string): [bigint, bigint] {
  const [coefficient = '', exponent = '0'] = value.toLowerCase().split('e')
  const [integer = '', decimal = ''] = coefficient.split('.')
  const scale = decimal.length - Number(exponent)
  const numerator = BigInt(integer + decimal)
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n]
}

/** 仅按明确制剂含量换算；库存按完整制剂计量。 */
export function resolveInpatientDose(config: InpatientDoseConfiguration, text: string): InpatientDoseResult {
  const maximum = config.maxDoseQuantity ?? Math.max(0, ...config.doses.map(dose => dose.quantity))
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return { reason: 'dose-limit' }
  const match = /^(\d+(?:\.\d+)?)\s*([^\s\d]+)$/.exec(text.trim())
  if (!match || Number(match[1]) <= 0 || !Number.isFinite(Number(match[1]))) return { reason: 'invalid-dose' }
  const amount = match[1]!, unit = match[2]!
  let numerator: bigint, denominator: bigint
  if (unit === config.unit) [numerator, denominator] = fraction(amount)
  else if (config.doseBasis) {
    const basis = config.doseBasis
    if (!Number.isFinite(basis.amount) || basis.amount <= 0) return { reason: 'missing-conversion' }
    const factor = massUnits.get(unit), basisFactor = massUnits.get(basis.unit)
    if (unit !== basis.unit && (factor === undefined || basisFactor === undefined)) return { reason: 'unit-mismatch' }
    const [doseNumerator, doseDenominator] = fraction(amount)
    const [basisNumerator, basisDenominator] = fraction(String(basis.amount))
    numerator = doseNumerator * basisDenominator * (factor ?? 1n)
    denominator = doseDenominator * basisNumerator * (basisFactor ?? 1n)
  } else {
    const legacy = config.doses.find(dose => dose.doseText.trim() === text.trim())
    if (!legacy) return { reason: 'missing-conversion' }
    numerator = BigInt(legacy.quantity)
    denominator = 1n
  }
  if (numerator % denominator !== 0n) return { reason: 'fractional-quantity' }
  const quantity = Number(numerator / denominator)
  return quantity > 0 && Number.isSafeInteger(quantity) && quantity <= maximum ? { quantity } : { reason: 'dose-limit' }
}
