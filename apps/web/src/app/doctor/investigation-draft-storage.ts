import { useEffect, useRef, useState } from 'react'
import { replaceEqualDeep } from '@tanstack/react-query'
import { z } from 'zod'
import { confirmDoctorPreparationResponseSchema, doctorManualInvestigationDraftSchema, doctorPreparationSelectionSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import type { ManualPreparedItem } from './doctor-recommendations.tsx'
import type { DraftPreferences } from './doctor-preparation-state.tsx'

export const investigationDraftPrefix = 'clinmesh.outpatient-investigation.'
const confirmationIntentPrefix = `${investigationDraftPrefix}confirmation:`
const storageChanged = 'clinmesh-investigation-draft-changed'
const manualItemsSchema = z.object({ rows: z.array(z.object({ label: z.string().min(1).max(500),
  value: doctorManualInvestigationDraftSchema,
}).strict()).max(8), legacyVersion: z.string().max(256).optional() }).strict()

export function clearInvestigationDrafts() {
  // 已发送操作须在原身份重新登录后查明结果，不能随未提交草稿丢弃原请求和幂等键。
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(investigationDraftPrefix) && !key.startsWith(confirmationIntentPrefix)) sessionStorage.removeItem(key)
  }
  window.dispatchEvent(new Event(storageChanged))
}

function useStoredInvestigationValue<Value>(key: string | undefined, schema: z.ZodType<Value>, initial: Value) {
  const load = (): { value: Value; key: string | undefined; failed: boolean } => {
    try {
      const raw = key === undefined ? null : sessionStorage.getItem(key)
      return { key, value: raw === null ? initial : schema.parse(JSON.parse(raw)), failed: false }
    } catch { return { key, value: initial, failed: true } }
  }
  const [stored, setStored] = useState(load)
  if (stored.key !== key) setStored(load())
  const current = useRef(stored)
  current.current = stored
  useEffect(() => {
    const refresh = () => {
      const next = replaceEqualDeep(current.current, load())
      current.current = next; setStored(next)
    }
    window.addEventListener(storageChanged, refresh)
    return () => window.removeEventListener(storageChanged, refresh)
  })
  const save = (update: (previous: Value) => unknown) => {
    if (current.current.key !== key) return false
    try {
      const value = replaceEqualDeep(current.current.value, schema.parse(update(current.current.value)))
      if (key !== undefined) sessionStorage.setItem(key, JSON.stringify(value))
      current.current = { key, value, failed: false }; setStored(current.current)
      window.dispatchEvent(new Event(storageChanged))
      return true
    } catch { setStored(previous => ({ ...previous, failed: true })); return false }
  }
  return { value: stored.key === key ? stored.value : initial, failed: stored.failed, save }
}

export function useManualInvestigationDrafts(scope: string, kind: 'laboratory' | 'imaging' | 'pathology' = 'laboratory') {
  const stored = useStoredInvestigationValue(`${investigationDraftPrefix}manual:${scope}`,
    manualItemsSchema.refine(value => value.rows.every(row => row.value.kind === kind)), { rows: [] })
  return { rows: stored.value.rows, legacyVersion: stored.value.legacyVersion, failed: stored.failed,
    save: (update: (previous: ManualPreparedItem[]) => ManualPreparedItem[], legacyVersion = stored.value.legacyVersion) => stored.save(previous => ({
      rows: update(previous.rows), ...(legacyVersion === undefined ? {} : { legacyVersion }),
    })) }
}

const investigationSelectionSchema = doctorPreparationSelectionSchema.refine(item => item.kind !== 'diagnosis' && item.kind !== 'prescription')
const draftPreferencesSchema = z.object({
  edits: z.record(z.string(), z.object({ label: z.string().min(1).max(500),
    selection: z.union([doctorManualInvestigationDraftSchema, investigationSelectionSchema]),
    fingerprint: z.string().max(512), reviewedFingerprint: z.string().max(512).optional(), formOwned: z.boolean().optional(),
  }).strict()), removed: z.record(z.string(), z.string()), unselected: z.array(z.string()), completed: z.record(z.string(), z.array(z.string())),
  formRevision: z.number().int().nonnegative().optional(),
}).strict()
export function useInvestigationPreferences(scope: string | undefined) {
  return useStoredInvestigationValue<DraftPreferences>(scope === undefined ? undefined : `${investigationDraftPrefix}preferences:${scope}`,
    draftPreferencesSchema, { edits: {}, removed: {}, unselected: [], completed: {} })
}

const confirmationIntentSchema = z.object({
  state: z.object({ caseId: z.string().min(1), kind: z.enum(['laboratory', 'imaging', 'pathology']),
    encounterId: z.string().min(1), encounterVersion: z.string().regex(/^\d+$/),
    generation: z.number().int().positive().optional(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  selections: z.array(investigationSelectionSchema).min(1).max(8), draftVersion: z.number().int().nonnegative(),
  resolveExistingDraft: z.boolean(), key: z.string().min(8).max(128),
  rows: z.array(z.object({ label: z.string().min(1).max(500), key: z.string(), signature: z.string() }).strict()).min(1).max(8),
  result: confirmDoctorPreparationResponseSchema.shape.data.optional(),
}).strict().refine(intent => intent.selections.length === intent.rows.length && intent.selections.every(item => item.kind === intent.state.kind)
  && (!intent.selections.some(item => item.source === 'agent') || intent.state.generation !== undefined && intent.state.inputFingerprint !== undefined)
  && (intent.result === undefined || intent.result.kind === intent.state.kind && (intent.result.caseId === undefined || intent.result.caseId === intent.state.caseId)))
export type InvestigationConfirmationIntent = z.infer<typeof confirmationIntentSchema>
export const prepareInvestigationConfirmationIntent = (value: unknown) => confirmationIntentSchema.parse(value)
export function useInvestigationConfirmationIntent(scope: string | undefined, target: { caseId: string; kind: DoctorRecommendationKind; encounterId: string | undefined }) {
  return useStoredInvestigationValue(scope === undefined ? undefined : `${confirmationIntentPrefix}${scope}`,
    confirmationIntentSchema.nullable().refine(value => value === null || value.state.caseId === target.caseId && value.state.kind === target.kind
      && (target.encounterId === undefined || value.state.encounterId === target.encounterId)), null)
}
