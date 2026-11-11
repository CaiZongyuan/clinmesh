import { paymentSimulatorRuleSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { createDraftDiscard } from './draft-discard.ts'

export const multiChargeDraftPrefix = 'clinmesh.multi-charge-draft:v1:'
const discard = createDraftDiscard(multiChargeDraftPrefix)
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
type DraftSession = Pick<SessionContext, 'actor'> & { user: Pick<SessionContext['user'], 'id'> }

export function multiChargeDraftStorage(session: DraftSession, target: { caseId: string; patientId: string; encounterId: string }) {
  const binding = bindingSchema.parse({ accountId: session.user.id, actor: session.actor, ...target })
  const scope = JSON.stringify(binding)
  const key = `${multiChargeDraftPrefix}${encodeURIComponent(scope)}`
  return {
    key,
    load(): { draft: MultiChargeDraft; failure: 'read' | null } {
      try {
        const raw = discard.read(key)
        if (raw === null) return { draft: emptyMultiChargeDraft(), failure: null }
        const stored = storedSchema.parse(JSON.parse(raw))
        if (JSON.stringify(stored.binding) !== scope) throw new Error('Draft binding changed')
        return { draft: stored.draft, failure: null }
      } catch { return { draft: emptyMultiChargeDraft(), failure: 'read' } }
    },
    save(draft: MultiChargeDraft) {
      discard.ensureCleared()
      sessionStorage.setItem(key, JSON.stringify(storedSchema.parse({ version: 1, binding, draft })))
    },
    discard() { discard.ensureCleared(); sessionStorage.removeItem(key) },
  }
}

/** Successful original money removes only its submitted items from the exact owner's private draft. */
export function removeCollectedMultiChargeDraftItems(session: DraftSession,
  target: { caseId: string; patientId: string; encounterId: string }, chargeItemIds: string[], discardUnread = false): { draft: MultiChargeDraft; failed: boolean; unreadable?: true } {
  const storage = multiChargeDraftStorage(session, target)
  const loaded = storage.load()
  const state = { draft: loaded.draft, failed: loaded.failure !== null }
  if (state.failed && !discardUnread) return { ...state, unreadable: true }
  const collected = new Set(chargeItemIds)
  const selectedChargeIds = state.draft.selectedChargeIds.filter(id => !collected.has(id))
  if (!state.failed && selectedChargeIds.length === state.draft.selectedChargeIds.length) return state
  try {
    if (state.failed || selectedChargeIds.length === 0) {
      storage.discard()
      return { draft: emptyMultiChargeDraft(), failed: false }
    }
    const draft = { ...state.draft, selectedChargeIds }
    storage.save(draft)
    return { draft, failed: false }
  } catch { return { ...state, failed: true } }
}

/** Only unsubmitted multi-charge drafts are cleared; original unknown financial intents keep their owner. */
export function clearMultiChargeDrafts() {
  try { discard.clear() } catch { /* Reads stay blocked until deferred cleanup succeeds. */ }
}
