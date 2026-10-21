import { z } from 'zod'

const microScale = 1_000_000n
const maxMicro = BigInt(Number.MAX_SAFE_INTEGER)

/** Convert a decimal rate without multiplying binary floating point values. */
export function modelPricingDecimalMicro(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('A pricing decimal must be finite and nonnegative')
  const parts = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (parts === null) throw new RangeError('Invalid pricing decimal')
  const fraction = parts[2] ?? ''
  const shift = 6 + Number(parts[3] ?? 0) - fraction.length
  const digits = BigInt(`${parts[1]}${fraction}`)
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n
  if (digits % divisor !== 0n) throw new RangeError('Pricing decimals support at most six decimal places')
  const scaled = shift < 0 ? digits / divisor : digits * 10n ** BigInt(shift)
  if (scaled > maxMicro) throw new RangeError('Pricing decimal exceeds the safe micro amount range')
  return scaled
}

const decimal = z.number().nonnegative().refine(value => {
  try { modelPricingDecimalMicro(value); return true } catch { return false }
}, 'Expected a safe nonnegative decimal with at most six decimal places')
const currency = z.string().regex(/^[A-Z]{3}$/)
const version = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
const name = z.string().min(1).max(1024).regex(/^[\p{L}\p{N}_.:/@+{}"[\], -]+$/u)
export const modelPriceRatesSchema = z.object({
  input: decimal, output: decimal,
  cacheRead: decimal.optional(), cacheWrite: decimal.optional(), reasoning: decimal.optional(),
}).strict()
export const modelPriceSchema = z.object({
  provider: name.max(256), model: name, version, currency, rates: modelPriceRatesSchema,
}).strict()
export const modelExchangeRateSchema = z.object({ currency, version, cnyPerUnit: decimal.positive() }).strict()
export const modelPricingConfigSchema = z.object({
  prices: z.array(modelPriceSchema).max(10_000),
  exchangeRates: z.array(modelExchangeRateSchema).max(256),
}).strict().superRefine((config, context) => {
  const prices = new Set<string>()
  for (const [index, price] of config.prices.entries()) {
    const key = JSON.stringify([price.provider, price.model])
    if (prices.has(key)) context.addIssue({ code: 'custom', path: ['prices', index], message: 'Duplicate provider/model price' })
    prices.add(key)
  }
  const currencies = new Set<string>()
  for (const [index, rate] of config.exchangeRates.entries()) {
    if (currencies.has(rate.currency)) context.addIssue({ code: 'custom', path: ['exchangeRates', index], message: 'Duplicate exchange currency' })
    if (rate.currency === 'CNY' && modelPricingDecimalMicro(rate.cnyPerUnit) !== microScale) {
      context.addIssue({ code: 'custom', path: ['exchangeRates', index, 'cnyPerUnit'], message: 'CNY exchange rate must be one' })
    }
    currencies.add(rate.currency)
  }
})
export type ModelPricingConfig = z.infer<typeof modelPricingConfigSchema>

export const modelPriceSnapshotSchema = z.object({
  provider: name.max(256), model: name,
  price: modelPriceSchema.omit({ provider: true, model: true }).nullable(),
  exchangeRate: modelExchangeRateSchema.omit({ currency: true }).nullable(),
}).strict()
export type ModelPriceSnapshot = z.infer<typeof modelPriceSnapshotSchema>

const amount = z.number().finite().nonnegative().nullable()
const microAmount = z.number().int().nonnegative().safe().nullable()
export const modelUsageCostSchema = z.object({
  status: z.enum(['priced', 'price-not-configured', 'exchange-rate-not-configured', 'usage-unknown', 'not-dispatched']),
  currency: currency.nullable().default(null), original: amount.default(null), cny: amount,
  originalMicro: microAmount.default(null), cnyMicro: microAmount.default(null),
}).strict()
export type ModelUsageCost = z.infer<typeof modelUsageCostSchema>
