import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientSurgeryCompleteInputSchema, inpatientSurgeryExecuteInputSchema } from '@clinmesh/contracts/inpatient-surgery'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

const prefix = 'clinmesh.surgery-draft:v1:'
const changedEvent = 'clinmesh.surgery-draft.changed'
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), requestId: z.string().min(1),
  executionId: z.string().min(1).optional(), action: z.enum(['execute', 'complete']) }).strict()
type Scope = z.infer<typeof scopeSchema>
const envelopeSchema = z.object({ version: z.literal(1), scope: scopeSchema, revision: z.uuid(), value: z.unknown(),
  submission: z.object({ signature: z.string(), revision: z.uuid() }).strict().nullable() }).strict()
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.surgery.execute'), input: inpatientSurgeryExecuteInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.surgery.complete'), input: inpatientSurgeryCompleteInputSchema }).strict(),
])
type Envelope = z.infer<typeof envelopeSchema>

export function surgeryDraftScope({ session, ...context }: { session: SessionContext; patientId: string; admissionId: string;
  requestId: string; executionId?: string; action: Scope['action'] }): Scope {
  return scopeSchema.parse({ ...context, accountId: session.user.id, actor: session.actor })
}

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}
function storageKey(scope: Scope) { return `${prefix}${encodeURIComponent(signature(scope))}` }
function notify(key: string) { window.dispatchEvent(new CustomEvent(changedEvent, { detail: key })) }
function matches(scope: Scope, command: z.infer<typeof commandSchema>) {
  return scope.action === command.operation.split('.').at(-1) && scope.admissionId === command.input.admissionId
    && scope.requestId === command.input.requestId
    && (command.operation === 'inpatient.surgery.execute' ? scope.executionId === undefined : scope.executionId === command.input.executionId)
}

/** 只保存人工输入；提交结果由共享 write-intent 的原回执确认。 */
export function useSurgeryDraft<T>({ scope, schema, initial }: { scope: Scope; schema: z.ZodType<T>; initial: T }) {
  const key = storageKey(scope)
  const read = () => {
    const empty: Envelope = { version: 1, scope, revision: crypto.randomUUID(), value: initial, submission: null }
    try {
      const raw = sessionStorage.getItem(key)
      const record = raw === null ? empty : envelopeSchema.parse(JSON.parse(raw))
      if (signature(record.scope) !== signature(scope)) throw new Error('Draft scope changed')
      return { key, record, value: schema.parse(record.value), failed: false }
    } catch { return { key, record: empty, value: initial, failed: true } }
  }
  const [stored, setStored] = useState(read)
  const current = useRef(stored)
  const owner = useRef(key), mounted = useRef(true)
  owner.current = key
  if (current.current.key !== key) current.current = read()
  const shown = stored.key === key ? stored : current.current
  useEffect(() => {
    mounted.current = true
    const refresh = () => { const next = read(); current.current = next; setStored(next) }
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh()
    window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
    // 每个版本化 key 已完整绑定 scope；schema 和初值由该调用点拥有。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const persist = (record: Envelope, value: T, keepCurrentOnFailure = false) => {
    if (!mounted.current || owner.current !== key) return false
    try {
      sessionStorage.setItem(key, JSON.stringify(record))
      const next = { key, record, value, failed: false }; current.current = next; setStored(next)
      notify(key)
      return true
    } catch {
      const next = keepCurrentOnFailure ? { ...current.current, failed: true } : { key, record, value, failed: true }
      current.current = next; setStored(next)
      return false
    }
  }
  return {
    value: shown.value,
    failed: shown.failed,
    save(next: T, options?: { keepCurrentOnFailure: boolean }) {
      if (!mounted.current || owner.current !== key) return false
      const parsed = schema.safeParse(next)
      if (!parsed.success) {
        const failed = { ...current.current, value: options?.keepCurrentOnFailure ? current.current.value : next, failed: true }
        current.current = failed; setStored(failed); return false
      }
      return persist({ ...current.current.record, revision: crypto.randomUUID(), value: parsed.data }, parsed.data, options?.keepCurrentOnFailure)
    },
    clear() {
      if (!mounted.current || owner.current !== key) return false
      try {
        sessionStorage.removeItem(key)
        const next = read(); current.current = next; setStored(next); notify(key)
        return true
      } catch { const next = { ...current.current, failed: true }; current.current = next; setStored(next); return false }
    },
    prepareSubmission(raw: unknown) {
      if (!mounted.current || owner.current !== key || current.current.failed) return false
      const parsed = commandSchema.safeParse(raw)
      if (!parsed.success || !matches(scope, parsed.data)) return false
      const record = current.current.record
      return persist({ ...record, submission: { signature: signature(parsed.data), revision: record.revision } }, current.current.value)
    },
  }
}

/** 成功与回执恢复均消费原提交版本，迟到响应不能删除后来编辑。 */
export function consumeSurgeryDraft(raw: unknown, session: SessionContext): void {
  const parsed = commandSchema.safeParse(raw)
  if (!parsed.success) return
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let rawScope: unknown
    try { rawScope = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const candidate = scopeSchema.safeParse(rawScope)
    if (!candidate.success || candidate.data.accountId !== session.user.id || signature(candidate.data.actor) !== signature(session.actor)
      || !matches(candidate.data, parsed.data)) continue
    const value = sessionStorage.getItem(key)
    if (value === null) continue
    const record = envelopeSchema.parse(JSON.parse(value))
    if (signature(record.scope) !== signature(candidate.data)) throw new Error('Draft scope changed')
    if (record.submission?.signature !== signature(parsed.data)) continue
    if (record.revision === record.submission.revision) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify({ ...record, submission: null }))
    notify(key)
  }
}

export function clearSurgeryDrafts(): void {
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) { sessionStorage.removeItem(key); notify(key) }
}
