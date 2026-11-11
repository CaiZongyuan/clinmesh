import { sessionContextSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'

export const inpatientIntentBindingSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
type Binding = z.infer<typeof inpatientIntentBindingSchema>
let logoutRevision = 0
export function markInpatientLogout() { logoutRevision += 1 }
export function inpatientLogoutRevision() { return logoutRevision }

export function inpatientIntentKey(binding: Binding) {
  return `clinmesh.inpatient-intent:v1:${encodeURIComponent(JSON.stringify(inpatientIntentBindingSchema.parse(binding)))}`
}

const pendingSchema = z.object({ version: z.literal(1), binding: inpatientIntentBindingSchema, idempotencyKey: z.uuid(),
  command: z.object({ operation: z.string(), input: z.record(z.string(), z.unknown()) }).strict(),
}).strict()

/** Projection for retaining a linked handoff on logout; the writer still validates the full command before recovery. */
export function readPendingInpatientCommand(binding: Binding) {
  const key = inpatientIntentKey(binding)
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null
  try {
    const value = pendingSchema.parse(JSON.parse(raw))
    return inpatientIntentKey(value.binding) === key ? value.command : null
  } catch { return null }
}
