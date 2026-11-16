import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { z } from 'zod'

const scopeSchema = z.tuple([z.string().min(1), sessionContextSchema.shape.actor.strict(), z.string().min(1), z.string().min(1)])
const settledEvent = 'clinmesh.inpatient-issue-draft.settled'

export function issueDraftKeys(prefix: string, session: SessionContext, admissionId: string): string[] {
  return Object.keys(sessionStorage).filter(key => {
    if (!key.startsWith(prefix)) return false
    try {
      const [account, actor, , admission] = scopeSchema.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length))))
      return account === session.user.id && admission === admissionId
        && JSON.stringify(actor) === JSON.stringify(sessionContextSchema.shape.actor.parse(session.actor))
    } catch { return false }
  })
}

export function notifyIssueDraftSettled(key: string): void {
  window.dispatchEvent(new CustomEvent(settledEvent, { detail: key }))
}

export function subscribeIssueDraftSettlement(key: string, reload: () => void): () => void {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && event.detail === key) reload()
  }
  window.addEventListener(settledEvent, listener)
  return () => window.removeEventListener(settledEvent, listener)
}

export const issueDraftFailureSchema = z.object({ status: z.number().int(), code: z.string(), message: z.string().optional(), reason: z.string().optional() }).strict()

export type IssueDraftOutcome =
  | { response: unknown; discardUnread: boolean }
  | { failure: z.infer<typeof issueDraftFailureSchema> }

export class IssueDraftUnreadable extends Error {}

export function readIssueDraftForSettlement<D>(keys: string[], key: string, outcome: IssueDraftOutcome, read: () => D): D | undefined {
  try { return read() } catch (cause) {
    if ('response' in outcome && outcome.discardUnread && keys.length === 1) {
      sessionStorage.removeItem(key)
      notifyIssueDraftSettled(key)
      return undefined
    }
    if ('response' in outcome && keys.length === 1) throw new IssueDraftUnreadable('The original issue draft is unreadable', { cause })
    throw cause
  }
}
