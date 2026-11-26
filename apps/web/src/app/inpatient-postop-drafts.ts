import { z } from 'zod'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import {
  inpatientFullClinicalResponseSchema,
  type inpatientMedicationSchema,
  type inpatientServiceSchema,
} from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientInvestigationResponseSchema,
  type inpatientInvestigationCatalogSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import {
  orderSetTemplateIdSchema,
  type OrderSetDraft,
} from '@clinmesh/contracts/order-set-templates'
import { createDraftDiscard } from './draft-discard.ts'
import {
  notifyIssueDraftSettled,
  readIssueDraftForSettlement,
  type IssueDraftOutcome,
} from './inpatient-issue-draft-settlement.ts'
import {
  investigationAttemptSchema,
  investigationDraftRowSchema,
  type InvestigationDraftRow,
} from './inpatient-investigation-drafts.ts'
import {
  orderAttemptSchema,
  orderDraftRowSchema,
  type OrderDraftRow,
} from './inpatient-order-drafts.ts'

export const postopDraftPrefix = 'clinmesh.inpatient-postop-drafts:v1:'
const discard = createDraftDiscard(postopDraftPrefix)
export const postopOrderLimit = 20
export const postopInvestigationLimit = 20

export const postopDraftSchema = z.object({
  templateId: orderSetTemplateIdSchema.optional(),
  templateFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  orders: z.array(orderDraftRowSchema).max(postopOrderLimit),
  investigations: z.array(investigationDraftRowSchema).max(postopInvestigationLimit),
  successes: z.array(z.object({
    id: z.uuid(),
    kind: z.enum(['order', 'investigation']),
    display: z.string(),
  }).strict()).max(postopOrderLimit + postopInvestigationLimit),
}).strict()

export type PostopDraft = z.infer<typeof postopDraftSchema>

export function emptyPostopDraft(): PostopDraft {
  return { orders: [], investigations: [], successes: [] }
}

export function postopDraftKey(
  session: SessionContext,
  admission: Pick<InpatientAdmission, 'id' | 'patientId'>,
  surgeryExecutionId: string,
): string {
  return postopDraftPrefix + encodeURIComponent(JSON.stringify([
    session.user.id,
    session.actor,
    admission.patientId,
    admission.id,
    surgeryExecutionId,
  ]))
}

export function clearPostopDrafts(): void {
  discard.clear()
}

export function readPostopDraft(key: string, admissionId: string): PostopDraft {
  const raw = discard.read(key)
  const draft = raw === null ? emptyPostopDraft() : postopDraftSchema.parse(JSON.parse(raw))
  if (
    draft.orders.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)
    || draft.investigations.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)
  ) {
    throw new Error('Postop draft admission mismatch')
  }
  return draft
}

export function savePostopDraft(key: string, draft: PostopDraft): void {
  discard.ensureCleared()
  sessionStorage.setItem(key, JSON.stringify(draft))
}

const postopScopeSchema = z.tuple([
  z.string().min(1),
  sessionContextSchema.shape.actor.strict(),
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
])

function postopKeysForAdmission(session: SessionContext, admissionId: string): string[] {
  const prefix = postopDraftPrefix
  const expectedActor = JSON.stringify(sessionContextSchema.shape.actor.parse(session.actor))
  return Object.keys(sessionStorage).filter(key => {
    if (!key.startsWith(prefix)) return false
    try {
      const [account, actor, , admission] = postopScopeSchema.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length))))
      return account === session.user.id
        && admission === admissionId
        && JSON.stringify(actor) === expectedActor
    } catch {
      return false
    }
  })
}

export function hydratePostopDraft(
  current: PostopDraft,
  draft: OrderSetDraft,
  context: {
    medications: readonly z.infer<typeof inpatientMedicationSchema>[]
    services: readonly z.infer<typeof inpatientServiceSchema>[]
    investigationItems: readonly z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number][]
    surgeryExecutionId: string
  },
): PostopDraft {
  const blockedOrderIds = new Set(
    draft.items.flatMap(item =>
      (item.kind === 'medication' || item.kind === 'service')
      && (item.disposition === 'excluded' || item.disposition === 'skipped')
      && item.matchedCatalogId !== null
        ? [`${item.kind}:${item.matchedCatalogId}`]
        : []),
  )
  const blockedInvIds = new Set(
    draft.items.flatMap(item =>
      (item.kind === 'laboratory' || item.kind === 'examination')
      && (item.disposition === 'excluded' || item.disposition === 'skipped')
      && item.matchedCatalogId !== null
        ? [`${item.kind}:${item.matchedCatalogId}`]
        : []),
  )
  const orders: OrderDraftRow[] = current.orders.filter(
    row => row.attempt !== undefined || !blockedOrderIds.has(`${row.pick.kind}:${row.pick.item.id}`),
  )
  const investigations: InvestigationDraftRow[] = current.investigations.filter(
    row => row.attempt !== undefined || !blockedInvIds.has(`${row.item.kind}:${row.item.id}`),
  )

  for (const entry of draft.items) {
    const candidate = entry.candidate
    if (candidate === null) continue
    const needsReview = entry.disposition === 'needs-review'

    if (candidate.kind === 'medication' && candidate.inpatient !== null) {
      const existingIndex = orders.findIndex(
        row => row.pick.kind === 'medication' && row.pick.item.id === candidate.catalogItemId,
      )
      if (existingIndex !== -1) {
        const existing = orders[existingIndex]!
        if (!existing.attempt) {
          orders[existingIndex] = {
            ...existing,
            surgeryExecutionId: context.surgeryExecutionId,
            ...(needsReview ? { selected: false } : {}),
            ...(!existing.instructions && candidate.instructionsZh ? { instructions: candidate.instructionsZh } : {}),
          }
        }
        continue
      }
      const catalogMedication = context.medications.find(med => med.id === candidate.catalogItemId)
      if (!catalogMedication || orders.length >= postopOrderLimit) continue
      orders.push({
        id: globalThis.crypto.randomUUID(),
        pick: { kind: 'medication', item: catalogMedication },
        selected: !needsReview,
        duration: candidate.inpatient.duration,
        doseText: candidate.doseText,
        frequencyCode: candidate.frequencyCode,
        routeCode: candidate.routeCode,
        ...(candidate.instructionsZh ? { instructions: candidate.instructionsZh } : {}),
        surgeryExecutionId: context.surgeryExecutionId,
      })
      continue
    }

    if (candidate.kind === 'service') {
      const existingIndex = orders.findIndex(
        row => row.pick.kind === 'service' && row.pick.item.id === candidate.serviceId,
      )
      if (existingIndex !== -1) {
        const existing = orders[existingIndex]!
        if (!existing.attempt) {
          orders[existingIndex] = {
            ...existing,
            serviceQuantity: candidate.quantity,
            surgeryExecutionId: context.surgeryExecutionId,
            ...(needsReview ? { selected: false } : {}),
          }
        }
        continue
      }
      const catalogService = context.services.find(svc => svc.id === candidate.serviceId)
      if (!catalogService || orders.length >= postopOrderLimit) continue
      orders.push({
        id: globalThis.crypto.randomUUID(),
        pick: { kind: 'service', item: catalogService },
        selected: !needsReview,
        duration: candidate.duration,
        doseText: '',
        serviceQuantity: candidate.quantity,
        surgeryExecutionId: context.surgeryExecutionId,
      })
      continue
    }

    if (candidate.kind === 'laboratory' || candidate.kind === 'examination') {
      const catalogId = candidate.kind === 'laboratory' ? candidate.catalogItemId : candidate.serviceId
      const existingIndex = investigations.findIndex(
        row => row.item.kind === candidate.kind && row.item.id === catalogId,
      )
      if (existingIndex !== -1) {
        const existing = investigations[existingIndex]!
        if (!existing.attempt) {
          investigations[existingIndex] = {
            ...existing,
            surgeryExecutionId: context.surgeryExecutionId,
            ...(needsReview ? { selected: false } : {}),
          }
        }
        continue
      }
      if (investigations.length >= postopInvestigationLimit) continue
      const catalogItem = context.investigationItems.find(
        item => item.kind === candidate.kind && item.id === catalogId,
      ) ?? {
        available: true,
        display: candidate.display,
        id: catalogId,
        indicationCodes: candidate.kind === 'laboratory' ? candidate.indicationCodes : [],
        kind: candidate.kind,
        priceFen: candidate.priceFen,
        version: candidate.catalogVersion,
      }
      investigations.push({
        id: globalThis.crypto.randomUUID(),
        item: catalogItem,
        indicationCode: candidate.kind === 'laboratory' ? candidate.indicationCode : '',
        indication: candidate.kind === 'examination' ? candidate.indication : '',
        selected: !needsReview,
        surgeryExecutionId: context.surgeryExecutionId,
      })
    }
  }

  return postopDraftSchema.parse({
    templateId: draft.template.id,
    templateFingerprint: draft.fingerprint,
    orders,
    investigations,
    successes: current.successes,
  })
}

/** 先持久消费原术后医嘱/检查行，再解除共享写意图；同键重读可安全重复。 */
export function settlePostopAttempt(
  operation: 'inpatient.order.issue' | 'inpatient.investigation.issue',
  input: unknown,
  idempotencyKey: string,
  session: SessionContext,
  outcome: IssueDraftOutcome,
): void {
  const isOrder = operation === 'inpatient.order.issue'
  const parsedOrder = isOrder ? orderAttemptSchema.parse({ input, idempotencyKey }) : undefined
  const parsedInv = isOrder ? undefined : investigationAttemptSchema.parse({ input, idempotencyKey })
  const admissionId = parsedOrder ? parsedOrder.input.admissionId : parsedInv!.input.admissionId
  if ('response' in outcome) {
    const responseAdmissionId = isOrder
      ? inpatientFullClinicalResponseSchema.parse(outcome.response).data.admissionId
      : inpatientInvestigationResponseSchema.parse(outcome.response).data.admissionId
    if (responseAdmissionId !== admissionId) throw new Error('Postop issue response admission changed')
  }
  discard.ensureCleared()
  const keys = postopKeysForAdmission(session, admissionId)
  for (const key of keys) {
    const draft = readIssueDraftForSettlement(keys, key, outcome, () => readPostopDraft(key, admissionId))
    if (!draft) continue
    if (isOrder && parsedOrder) {
      const row = draft.orders.find(item => item.attempt?.idempotencyKey === idempotencyKey)
      if (!row) continue
      if (JSON.stringify(row.attempt) !== JSON.stringify(parsedOrder)) {
        throw new Error('Postop order draft does not match the original command')
      }
      const next = postopDraftSchema.parse(
        'failure' in outcome
          ? {
              ...draft,
              orders: draft.orders.map(item =>
                item.id === row.id ? { ...item, attempt: undefined, error: outcome.failure } : item),
            }
          : {
              ...draft,
              orders: draft.orders.filter(item => item.id !== row.id),
              successes: [...draft.successes, { id: row.id, kind: 'order' as const, display: row.pick.item.display }]
                .slice(-(postopOrderLimit + postopInvestigationLimit)),
            },
      )
      discard.ensureCleared()
      sessionStorage.setItem(key, JSON.stringify(next))
      notifyIssueDraftSettled(key)
      return
    }
    if (!isOrder && parsedInv) {
      const row = draft.investigations.find(item => item.attempt?.idempotencyKey === idempotencyKey)
      if (!row) continue
      if (JSON.stringify(row.attempt) !== JSON.stringify(parsedInv)) {
        throw new Error('Postop investigation draft does not match the original command')
      }
      const next = postopDraftSchema.parse(
        'failure' in outcome
          ? {
              ...draft,
              investigations: draft.investigations.map(item =>
                item.id === row.id ? { ...item, attempt: undefined, error: outcome.failure } : item),
            }
          : {
              ...draft,
              investigations: draft.investigations.filter(item => item.id !== row.id),
              successes: [...draft.successes, { id: row.id, kind: 'investigation' as const, display: row.item.display }]
                .slice(-(postopOrderLimit + postopInvestigationLimit)),
            },
      )
      discard.ensureCleared()
      sessionStorage.setItem(key, JSON.stringify(next))
      notifyIssueDraftSettled(key)
      return
    }
  }
}
