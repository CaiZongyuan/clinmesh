import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { useEffect, useState } from 'react'
import { z } from 'zod'

type Binding = { accountId: string; actor: SessionContext['actor'] }
export type ReviewQueueCommand = { operation: 'inpatient.record.review' | 'inpatient.record.archive' | 'inpatient.drg.payer.review'; input: object }
const prefix = 'clinmesh.inpatient-review-queue:v1:', changed = 'clinmesh.inpatient-review-queue.changed'
const bindingSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict() }).strict()
const targetSchema = z.object({ id: z.string().min(1), patientId: z.string().min(1), patientName: z.string().min(1), versionId: z.string().min(1) }).strict()
const snapshotSchema = z.object({ version: z.literal(1), binding: bindingSchema, sourceId: z.string().min(1), operation: z.enum(['inpatient.record.review', 'inpatient.record.archive', 'inpatient.drg.payer.review']), signature: z.string(), filter: z.string(), page: z.number().int().positive(), queue: z.array(z.string()), target: targetSchema.optional(), complete: z.boolean() }).strict()
export type InpatientReviewQueueSnapshot = z.infer<typeof snapshotSchema>
type Context = Pick<InpatientReviewQueueSnapshot, 'filter' | 'page' | 'queue' | 'target'>
function signature(command: { operation: string; input: object }) { return JSON.stringify([command.operation, Object.entries(command.input).sort(([a], [b]) => a.localeCompare(b))]) }
function ownerPrefix(binding: Binding, sourceId: string) { return prefix + encodeURIComponent(JSON.stringify([bindingSchema.parse(binding), sourceId]).slice(0, -1) + ',') }
function keyOf(binding: Binding, sourceId: string, operation: string) { return prefix + encodeURIComponent(JSON.stringify([bindingSchema.parse(binding), sourceId, operation])) }
function emit() { window.dispatchEvent(new Event(changed)) }
function isReviewCommand(command: { operation: string; input: object }): command is ReviewQueueCommand {
  return ['inpatient.record.review', 'inpatient.record.archive', 'inpatient.drg.payer.review'].includes(command.operation)
}
/** 写入器在 typed 成功回执后持久完成原命令的导航快照；与页面是否挂载无关。 */
export function completeInpatientReviewQueue(command: { operation: string; input: object }, binding: Binding): void {
  if (!isReviewCommand(command) || !('admissionId' in command.input) || typeof command.input.admissionId !== 'string') return
  const key = keyOf(binding, command.input.admissionId, command.operation), raw = sessionStorage.getItem(key)
  if (raw === null) return
  const snapshot = snapshotSchema.parse(JSON.parse(raw))
  if (snapshot.sourceId !== command.input.admissionId || snapshot.operation !== command.operation || JSON.stringify(snapshot.binding) !== JSON.stringify(bindingSchema.parse(binding))) throw new Error('Queue scope mismatch')
  if (snapshot.signature !== signature(command)) return
  snapshot.complete = true
  sessionStorage.setItem(key, JSON.stringify(snapshot)); emit()
}

/** 这里只持久化用户确认前冻结的队列与目标，不缓存服务端病案或核定事实。 */
export function useInpatientReviewQueue(session: SessionContext, sourceId: string | undefined) {
  const binding = bindingSchema.parse({ accountId: session.user.id, actor: session.actor })
  const scope = sourceId ? ownerPrefix(binding, sourceId) : ''
  const load = () => {
    try {
      const snapshots = scope ? Object.keys(sessionStorage).filter(key => key.startsWith(scope)).map(key => snapshotSchema.parse(JSON.parse(sessionStorage.getItem(key)!))) : []
      if (snapshots.some(snapshot => snapshot.sourceId !== sourceId || JSON.stringify(snapshot.binding) !== JSON.stringify(binding))) throw new Error('Queue scope mismatch')
      return { scope, snapshots, error: false }
    } catch { return { scope, snapshots: [], error: true } }
  }
  const [stored, setStored] = useState(load)
  const current = stored.scope === scope ? stored : load()
  useEffect(() => {
    const refresh = () => setStored(load())
    refresh(); window.addEventListener(changed, refresh)
    return () => window.removeEventListener(changed, refresh)
    // Scope contains the complete account, Actor and source admission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  return {
    snapshots: current.snapshots, error: current.error,
    retry: () => setStored(load()),
    prepare: (command: ReviewQueueCommand, context: Context): boolean => {
      if (!sourceId || !('admissionId' in command.input) || command.input.admissionId !== sourceId) return false
      try {
        const snapshot = snapshotSchema.parse({ version: 1, binding, sourceId, operation: command.operation, signature: signature(command), ...context, complete: false })
        sessionStorage.setItem(keyOf(binding, sourceId, command.operation), JSON.stringify(snapshot)); emit(); return true
      } catch { setStored({ ...current, error: true }); return false }
    },
  }
}
