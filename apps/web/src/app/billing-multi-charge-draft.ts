import { paymentSimulatorRuleSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { z } from 'zod'

export const multiChargeDraftPrefix = 'clinmesh.multi-charge-draft:v1:'
let discardPending = false
function discardStoredDrafts() {
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(multiChargeDraftPrefix)) sessionStorage.removeItem(key)
  }
  discardPending = false
}
export const multiChargeDraftSchema = z.object({
  selectedChargeIds: z.array(z.string().min(1)).max(20).refine(ids => new Set(ids).size === ids.length),
  simulatorRule: paymentSimulatorRuleSchema,
  tenderAmounts: z.object({ cash: z.string().max(100).optional(), 'bank-card': z.string().max(100).optional(), mobile: z.string().max(100).optional() }).strict(),
  filter: z.string().max(200),
  page: z.number().int().positive(),
}).strict()
const bindingSchema = z.object({
  accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  caseId: z.string().min(1), patientId: z.string().min(1), encounterId: z.string().min(1),
}).strict()
const storedSchema = z.object({ version: z.literal(1), binding: bindingSchema, draft: multiChargeDraftSchema }).strict()
export type MultiChargeDraft = z.infer<typeof multiChargeDraftSchema>
export const emptyMultiChargeDraft = (): MultiChargeDraft => ({ selectedChargeIds: [], simulatorRule: 'success', tenderAmounts: {}, filter: '', page: 1 })

export function multiChargeDraftStorage(session: SessionContext, target: { caseId: string; patientId: string; encounterId: string }) {
  const binding = bindingSchema.parse({ accountId: session.user.id, actor: session.actor, ...target })
  const scope = JSON.stringify(binding)
  const key = `${multiChargeDraftPrefix}${encodeURIComponent(scope)}`
  return {
    key,
    load(): { draft: MultiChargeDraft; failed: boolean } {
      try {
        if (discardPending) discardStoredDrafts()
        const raw = sessionStorage.getItem(key)
        if (raw === null) return { draft: emptyMultiChargeDraft(), failed: false }
        const stored = storedSchema.parse(JSON.parse(raw))
        if (JSON.stringify(stored.binding) !== scope) throw new Error('Draft binding changed')
        return { draft: stored.draft, failed: false }
      } catch { return { draft: emptyMultiChargeDraft(), failed: true } }
    },
    save(draft: MultiChargeDraft) {
      if (discardPending) discardStoredDrafts()
      sessionStorage.setItem(key, JSON.stringify(storedSchema.parse({ version: 1, binding, draft })))
    },
    discard() { sessionStorage.removeItem(key) },
  }
}

/** Only unsubmitted multi-charge drafts are cleared; original unknown financial intents keep their owner. */
export function clearMultiChargeDrafts() {
  discardPending = true
  try { discardStoredDrafts() } catch { /* Same-session reads stay empty and blocked until deferred cleanup succeeds. */ }
}
