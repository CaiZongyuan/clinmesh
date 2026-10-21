import { z } from 'zod'
import { unknownModelTokenUsage, type ModelTokenUsage } from '@clinmesh/contracts/model-usage'

const count = z.number().int().nonnegative().safe()
const dshUsageSchema = z.object({ inputTokens: count, outputTokens: count,
  cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional(), totalTokens: count.optional() })
export function dshTokenUsage(value: unknown): ModelTokenUsage {
  const parsed = dshUsageSchema.safeParse(value)
  if (!parsed.success) return unknownModelTokenUsage
  const usage = parsed.data
  const cached = usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
    ? usage.cacheReadTokens + usage.cacheWriteTokens : null
  const input = cached === null ? usage.totalTokens === undefined ? null : usage.totalTokens - usage.outputTokens
    : usage.inputTokens + cached
  const total = input === null ? null : input + usage.outputTokens
  if (input !== null && (input < usage.inputTokens || !Number.isSafeInteger(input))
    || total !== null && !Number.isSafeInteger(total)) return unknownModelTokenUsage
  return { inputTokens: input, outputTokens: usage.outputTokens, cachedInputTokens: cached ?? (input === null ? null : input - usage.inputTokens),
    reasoningOutputTokens: usage.reasoningTokens !== undefined && usage.reasoningTokens <= usage.outputTokens ? usage.reasoningTokens : null,
    totalTokens: usage.totalTokens === undefined ? total : usage.totalTokens === total ? usage.totalTokens : null, mapping: 'dsh-v1',
    raw: { format: 'dsh', uncachedInputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null,
      reasoningTokens: usage.reasoningTokens ?? null, totalTokens: usage.totalTokens ?? null } }
}
