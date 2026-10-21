import { expect, it } from 'vitest'
import { modelPricingConfigSchema, modelUsageCostSchema } from '@clinmesh/contracts/model-pricing'
import { unknownModelTokenUsage, type ModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { freezeModelPrice, priceModelUsage, priceModelReservation } from '../src/application/model-usage-pricing.ts'

const usage: ModelTokenUsage = {
  inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 200_000,
  reasoningOutputTokens: 100_000, totalTokens: 1_500_000, mapping: 'openai-v1',
}

it('freezes prices and FX and charges cached/reasoning subsets once', () => {
  const config = modelPricingConfigSchema.parse({ prices: [{ provider: 'synthetic', model: 'example',
    version: 'price-1', currency: 'USD', rates: { input: 2, output: 8, cacheRead: 0.5, reasoning: 4 } }],
  exchangeRates: [{ currency: 'USD', version: 'fx-1', cnyPerUnit: 7.2 }] })
  const snapshot = freezeModelPrice(config, 'synthetic', 'example')
  config.prices[0]!.rates.input = 99
  config.exchangeRates[0]!.cnyPerUnit = 99
  // 800k uncached + 200k cached + 400k visible + 100k reasoning = USD 5.30.
  expect(priceModelUsage(snapshot, usage, 'dispatched')).toEqual({
    status: 'priced', currency: 'USD', original: 5.3, cny: 38.16,
    originalMicro: 5_300_000, cnyMicro: 38_160_000,
  })
})

it('keeps missing price, FX, usage and configured zero prices distinct', () => {
  const config = modelPricingConfigSchema.parse({ prices: [
    { provider: 'synthetic', model: 'usd', version: 'p1', currency: 'USD', rates: { input: 2, output: 8 } },
    { provider: 'synthetic', model: 'zero', version: 'p1', currency: 'CNY', rates: { input: 0, output: 0 } },
    { provider: 'synthetic', model: 'cny', version: 'p1', currency: 'CNY', rates: { input: 2, output: 8 } },
  ], exchangeRates: [] })
  const missing = freezeModelPrice(config, 'synthetic', 'missing')
  expect(priceModelUsage(missing, usage, 'dispatched')).toMatchObject({ status: 'price-not-configured', cny: null })
  expect(priceModelUsage(missing, unknownModelTokenUsage, 'not-dispatched')).toMatchObject({ status: 'not-dispatched', cny: 0 })
  const usd = freezeModelPrice(config, 'synthetic', 'usd')
  expect(priceModelUsage(usd, usage, 'dispatched')).toMatchObject({ status: 'exchange-rate-not-configured', original: 6, cny: null })
  expect(priceModelUsage(usd, unknownModelTokenUsage, 'unknown')).toMatchObject({ status: 'usage-unknown', original: null, cny: null })
  expect(priceModelUsage(freezeModelPrice(config, 'synthetic', 'zero'), unknownModelTokenUsage, 'unknown'))
    .toMatchObject({ status: 'priced', original: 0, cny: 0 })
  expect(priceModelUsage(freezeModelPrice(config, 'synthetic', 'cny'), usage, 'dispatched'))
    .toMatchObject({ status: 'priced', original: 6, cny: 6 })
})

it('reserves a conservative upper bound across all token partitions and rounds upward', () => {
  const config = modelPricingConfigSchema.parse({ prices: [{ provider: 'synthetic', model: 'example',
    version: 'p1', currency: 'CNY', rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3, reasoning: 10 } }], exchangeRates: [] })
  expect(priceModelReservation(freezeModelPrice(config, 'synthetic', 'example'), { inputTokens: 1_000_000, outputTokens: 500_000 }))
    .toMatchObject({ status: 'priced', cnyMicro: 8_000_000, cny: 8 })
  config.prices[0]!.rates = { input: 0.000001, output: 0.000001 }
  expect(priceModelReservation(freezeModelPrice(config, 'synthetic', 'example'), { inputTokens: 1, outputTokens: 1 }))
    .toMatchObject({ status: 'priced', cnyMicro: 1, cny: 0.000001 })
})

it('uses disjoint DSH cache partitions and requires only counters with differing prices', () => {
  const config = modelPricingConfigSchema.parse({ prices: [{ provider: 'synthetic', model: 'dsh',
    version: 'p1', currency: 'CNY', rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } }], exchangeRates: [] })
  const dsh: ModelTokenUsage = { ...usage, mapping: 'dsh-v1', raw: { format: 'dsh', uncachedInputTokens: 800_000,
    cacheReadTokens: 150_000, cacheWriteTokens: 50_000, outputTokens: 500_000, reasoningTokens: 100_000, totalTokens: 1_500_000 } }
  expect(priceModelUsage(freezeModelPrice(config, 'synthetic', 'dsh'), dsh, 'dispatched'))
    .toMatchObject({ status: 'priced', cny: 5.825 })
  dsh.raw = { format: 'dsh', uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: 50_000,
    outputTokens: null, reasoningTokens: null, totalTokens: null }
  dsh.cachedInputTokens = null
  expect(priceModelUsage(freezeModelPrice(config, 'synthetic', 'dsh'), dsh, 'dispatched')).toMatchObject({ status: 'usage-unknown', cny: null })
  config.prices[0]!.rates.cacheRead = 2
  expect(priceModelUsage(freezeModelPrice(config, 'synthetic', 'dsh'), dsh, 'dispatched'))
    .toMatchObject({ status: 'priced', cny: 6.05 })
})

it('reads pre-pricing records with explicit unknown amount defaults', () => {
  expect(modelUsageCostSchema.parse({ status: 'price-not-configured', cny: null })).toEqual({
    status: 'price-not-configured', currency: null, original: null, cny: null, originalMicro: null, cnyMicro: null,
  })
})

it('requires cache/reasoning counters when they change the billed amount', () => {
  const config = modelPricingConfigSchema.parse({ prices: [{ provider: 'synthetic', model: 'example',
    version: 'p1', currency: 'CNY', rates: { input: 2, output: 8, cacheRead: 0.5, reasoning: 4 } }], exchangeRates: [] })
  const snapshot = freezeModelPrice(config, 'synthetic', 'example')
  expect(priceModelUsage(snapshot, { ...usage, cachedInputTokens: null }, 'dispatched')).toMatchObject({ status: 'usage-unknown', cny: null })
  expect(priceModelUsage(snapshot, { ...usage, reasoningOutputTokens: null }, 'dispatched')).toMatchObject({ status: 'usage-unknown', cny: null })
  expect(priceModelUsage(snapshot, { ...usage, cachedInputTokens: 1_000_001 }, 'dispatched')).toMatchObject({ status: 'usage-unknown', cny: null })
})

it('converts exact decimals before rounding and refuses unsafe micro totals', () => {
  const config = modelPricingConfigSchema.parse({ prices: [{ provider: 'synthetic', model: 'tiny',
    version: 'p1', currency: 'USD', rates: { input: 0.000001, output: 0 } }],
  exchangeRates: [{ currency: 'USD', version: 'fx1', cnyPerUnit: 0.5 }] })
  const snapshot = freezeModelPrice(config, 'synthetic', 'tiny')
  expect(priceModelUsage(snapshot, { ...unknownModelTokenUsage, inputTokens: 500_000 }, 'dispatched'))
    .toMatchObject({ status: 'priced', originalMicro: 1, cnyMicro: 0 })
  config.prices[0]!.rates.input = 1
  config.prices[0]!.currency = 'CNY'
  const safe = freezeModelPrice(config, 'synthetic', 'tiny')
  expect(priceModelUsage(safe, { ...unknownModelTokenUsage, inputTokens: Number.MAX_SAFE_INTEGER }, 'dispatched'))
    .toMatchObject({ originalMicro: Number.MAX_SAFE_INTEGER, cnyMicro: Number.MAX_SAFE_INTEGER })
  config.prices[0]!.rates.input = 2
  expect(() => priceModelUsage(freezeModelPrice(config, 'synthetic', 'tiny'),
    { ...unknownModelTokenUsage, inputTokens: Number.MAX_SAFE_INTEGER }, 'dispatched')).toThrow(RangeError)
  expect(() => priceModelReservation(safe, { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 })).toThrow(RangeError)
})

it('rejects ambiguous or unsafe deployment pricing configuration', () => {
  const price = { provider: 'synthetic', model: 'example', version: 'p1', currency: 'CNY', rates: { input: 2, output: 8 } }
  for (const input of [-1, 0.1000001, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(modelPricingConfigSchema.safeParse({ prices: [{ ...price, rates: { input, output: 8 } }], exchangeRates: [] }).success).toBe(false)
  }
  expect(modelPricingConfigSchema.safeParse({ prices: [price, price], exchangeRates: [] }).success).toBe(false)
  expect(modelPricingConfigSchema.safeParse({ prices: [{ ...price, version: 'space version' }], exchangeRates: [] }).success).toBe(false)
  expect(modelPricingConfigSchema.safeParse({ prices: [{ ...price, currency: 'cny' }], exchangeRates: [] }).success).toBe(false)
  expect(modelPricingConfigSchema.safeParse({ prices: [price], exchangeRates: [{ currency: 'CNY', version: 'fx1', cnyPerUnit: 2 }] }).success).toBe(false)
})
