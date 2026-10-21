import { modelPricingDecimalMicro, type ModelPriceSnapshot, type ModelPricingConfig,
  type ModelUsageCost } from '@clinmesh/contracts/model-pricing'
import type { ModelTokenUsage, ModelUsageOutcome } from '@clinmesh/contracts/model-usage'

const scale = 1_000_000n
const maxMicro = BigInt(Number.MAX_SAFE_INTEGER)

/** Copy the invocation's pricing basis; later configuration edits cannot change it. */
export function freezeModelPrice(config: ModelPricingConfig, provider: string, model: string): ModelPriceSnapshot {
  const price = config.prices.find(entry => entry.provider === provider && entry.model === model)
  if (price === undefined) return { provider, model, price: null, exchangeRate: null }
  const rate = config.exchangeRates.find(entry => entry.currency === price.currency)
  return { provider, model, price: { version: price.version, currency: price.currency, rates: { ...price.rates } },
    exchangeRate: price.currency === 'CNY' ? { version: 'identity-v1', cnyPerUnit: 1 }
      : rate === undefined ? null : { version: rate.version, cnyPerUnit: rate.cnyPerUnit } }
}

function unknownCost(snapshot: ModelPriceSnapshot, status: ModelUsageCost['status']): ModelUsageCost {
  return { status, currency: snapshot.price?.currency ?? null, original: null, cny: null, originalMicro: null, cnyMicro: null }
}

function tokenCount(value: number | null): bigint | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Token count exceeds the safe nonnegative integer range')
  return BigInt(value)
}

/** Total tokens include the subset. Unknown subsets matter only when their price differs. */
function partition(total: bigint | null, base: bigint, subset: bigint | null, subsetRate: bigint): bigint | null {
  if (total !== null && subset !== null && subset > total) return null
  if (base === 0n && subsetRate === 0n || total === 0n) return 0n
  if (total === null) return null
  if (base === subsetRate) return total * base
  if (subset === null) return null
  return (total - subset) * base + subset * subsetRate
}

function inputNumerator(snapshot: NonNullable<ModelPriceSnapshot['price']>, usage: ModelTokenUsage): bigint | null {
  const input = modelPricingDecimalMicro(snapshot.rates.input)
  const read = modelPricingDecimalMicro(snapshot.rates.cacheRead ?? snapshot.rates.input)
  const write = modelPricingDecimalMicro(snapshot.rates.cacheWrite ?? snapshot.rates.input)
  const total = tokenCount(usage.inputTokens)
  const cached = tokenCount(usage.cachedInputTokens)
  if (usage.mapping === 'openai-v1') return partition(total, input, cached, read)
  if (input === read && read === write) return partition(total, input, cached, read)
  if (read === write) return partition(total, input, cached, read)
  if (total === 0n) return 0n
  if (usage.raw?.format !== 'dsh') return null
  const readCount = tokenCount(usage.raw.cacheReadTokens)
  const writeCount = tokenCount(usage.raw.cacheWriteTokens)
  if (readCount === null || writeCount === null || total === null) return null
  const combined = readCount + writeCount
  if (combined > total || cached !== null && combined !== cached) return null
  return (total - combined) * input + readCount * read + writeCount * write
}

function roundedMicro(numerator: bigint, divisor: bigint, ceiling: boolean): number {
  const rounded = ceiling ? (numerator + divisor - 1n) / divisor : (numerator + divisor / 2n) / divisor
  if (rounded > maxMicro) throw new RangeError('Model cost exceeds the safe micro amount range')
  return Number(rounded)
}

function costFromNumerator(snapshot: ModelPriceSnapshot, numerator: bigint, ceiling: boolean): ModelUsageCost {
  const result = unknownCost(snapshot, 'exchange-rate-not-configured')
  result.originalMicro = roundedMicro(numerator, scale, ceiling)
  result.original = result.originalMicro / Number(scale)
  if (snapshot.exchangeRate !== null) {
    // Convert the unrounded original amount, then round once to CNY micro units.
    result.cnyMicro = roundedMicro(numerator * modelPricingDecimalMicro(snapshot.exchangeRate.cnyPerUnit), scale * scale, ceiling)
    result.cny = result.cnyMicro / Number(scale)
    result.status = 'priced'
  }
  return result
}

export function priceModelUsage(snapshot: ModelPriceSnapshot, usage: ModelTokenUsage,
  dispatch: ModelUsageOutcome['dispatch']): ModelUsageCost {
  if (dispatch === 'not-dispatched') return { status: 'not-dispatched', currency: snapshot.price?.currency ?? null,
    original: 0, cny: 0, originalMicro: 0, cnyMicro: 0 }
  if (snapshot.price === null) return unknownCost(snapshot, 'price-not-configured')
  const input = inputNumerator(snapshot.price, usage)
  const output = partition(tokenCount(usage.outputTokens), modelPricingDecimalMicro(snapshot.price.rates.output),
    tokenCount(usage.reasoningOutputTokens), modelPricingDecimalMicro(snapshot.price.rates.reasoning ?? snapshot.price.rates.output))
  if (input === null || output === null) return unknownCost(snapshot, 'usage-unknown')
  return costFromNumerator(snapshot, input + output, false)
}

/** Caps include cached input/reasoning output; each token uses its highest possible rate. */
export function priceModelReservation(snapshot: ModelPriceSnapshot,
  bounds: { inputTokens: number | null; outputTokens: number | null }): ModelUsageCost {
  if (snapshot.price === null) return unknownCost(snapshot, 'price-not-configured')
  const rates = snapshot.price.rates
  const maximum = (values: number[]) => values.map(modelPricingDecimalMicro).reduce((left, right) => left > right ? left : right)
  const inputRate = maximum([rates.input, rates.cacheRead ?? rates.input, rates.cacheWrite ?? rates.input])
  const outputRate = maximum([rates.output, rates.reasoning ?? rates.output])
  const input = partition(tokenCount(bounds.inputTokens), inputRate, null, inputRate)
  const output = partition(tokenCount(bounds.outputTokens), outputRate, null, outputRate)
  if (input === null || output === null) return unknownCost(snapshot, 'usage-unknown')
  return costFromNumerator(snapshot, input + output, true)
}
