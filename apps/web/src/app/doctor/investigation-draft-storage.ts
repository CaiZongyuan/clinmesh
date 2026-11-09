import { useEffect, useRef, useState } from 'react'
import { replaceEqualDeep } from '@tanstack/react-query'
import { z } from 'zod'
import { confirmDoctorPreparationResponseSchema, doctorManualInvestigationDraftSchema, doctorPreparationSelectionSchema, doctorRecommendationKindSchema, type DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { diagnosisDraftEntrySchema, prescriptionDraftItemSchema } from '@clinmesh/contracts/his'
import type { ManualPreparedItem } from './doctor-recommendations.tsx'
import type { DraftPreferences } from './doctor-preparation-state.tsx'

export const investigationDraftPrefix = 'clinmesh.outpatient-investigation.'
const storageChanged = 'clinmesh-investigation-draft-changed'
const manualItemsSchema = z.object({ rows: z.array(z.object({ label: z.string().min(1).max(500),
  value: doctorManualInvestigationDraftSchema,
}).strict()).max(8), legacyVersion: z.string().max(256).optional() }).strict()

export function clearInvestigationDrafts() {
  for (const key of Object.keys(sessionStorage)) if (key.startsWith(investigationDraftPrefix)) sessionStorage.removeItem(key)
  window.dispatchEvent(new Event(storageChanged))
}

export function useStoredInvestigationValue<Value>(key: string | undefined, schema: z.ZodType<Value>, initial: Value) {
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
const prescriptionDraftSchema = prescriptionDraftItemSchema.extend({
  kind: z.literal('prescription'), source: z.enum(['manual', 'agent']), suggestionId: z.string().min(1).optional(),
  doseText: z.string().max(256).nullable(), frequencyCode: z.string().max(128).nullable(),
  courseDays: z.number().finite().nullable(), quantity: z.number().finite().nullable(),
}).strict().refine(item => (item.source === 'agent') === (item.suggestionId !== undefined))
const diagnosisDraftSchema = diagnosisDraftEntrySchema.extend({
  kind: z.literal('diagnosis'), source: z.enum(['manual', 'agent']), suggestionId: z.string().min(1).optional(),
  role: diagnosisDraftEntrySchema.shape.role.nullable(), note: z.string().max(500).optional(),
}).strict().refine(item => (item.source === 'agent') === (item.suggestionId !== undefined))
const draftPreferencesSchema = z.object({
  edits: z.record(z.string(), z.object({ label: z.string().min(1).max(500),
    selection: z.union([doctorManualInvestigationDraftSchema, investigationSelectionSchema, prescriptionDraftSchema, diagnosisDraftSchema]),
    fingerprint: z.string().max(512), reviewedFingerprint: z.string().max(512).optional(), formOwned: z.boolean().optional(),
  }).strict()), removed: z.record(z.string(), z.string()), unselected: z.array(z.string()), completed: z.record(z.string(), z.array(z.string())),
  formRevision: z.number().int().nonnegative().optional(),
}).strict()
export function useInvestigationPreferences(scope: string | undefined) {
  return useStoredInvestigationValue<DraftPreferences>(scope === undefined ? undefined : `${investigationDraftPrefix}preferences:${scope}`,
    draftPreferencesSchema, { edits: {}, removed: {}, unselected: [], completed: {} })
}

const confirmationIntentSchema = z.object({
  state: z.object({ caseId: z.string().min(1), kind: doctorRecommendationKindSchema,
    encounterId: z.string().min(1), encounterVersion: z.string().regex(/^\d+$/),
    generation: z.number().int().positive().optional(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  selections: z.array(doctorPreparationSelectionSchema).min(1).max(8), draftVersion: z.number().int().nonnegative(),
  resolveExistingDraft: z.boolean(), key: z.string().min(8).max(128),
  rows: z.array(z.object({ label: z.string().min(1).max(500), key: z.string(), signature: z.string() }).strict()).min(1).max(8),
  result: confirmDoctorPreparationResponseSchema.shape.data.optional(),
}).strict().refine(intent => intent.selections.length === intent.rows.length && intent.selections.every(item => item.kind === intent.state.kind)
  && (!intent.selections.some(item => item.source === 'agent') || intent.state.generation !== undefined && intent.state.inputFingerprint !== undefined)
  && (intent.result === undefined || intent.result.kind === intent.state.kind && (intent.result.caseId === undefined || intent.result.caseId === intent.state.caseId)))
export type InvestigationConfirmationIntent = z.infer<typeof confirmationIntentSchema>
export const prepareInvestigationConfirmationIntent = (value: unknown) => confirmationIntentSchema.parse(value)
export function saveInvestigationConfirmationIntent(scope: string, value: InvestigationConfirmationIntent | null, expectedKey?: string) {
  try {
    const key = `${investigationDraftPrefix}confirmation:${scope}`
    const current = confirmationIntentSchema.nullable().parse(JSON.parse(sessionStorage.getItem(key) ?? 'null'))
    if (expectedKey === undefined ? current !== null : current?.key !== expectedKey) return false
    sessionStorage.setItem(key, JSON.stringify(confirmationIntentSchema.nullable().parse(value)))
    window.dispatchEvent(new Event(storageChanged))
    return true
  } catch { return false }
}
export function hasStoredInvestigationConfirmation(scope: string) {
  try {
    const raw = sessionStorage.getItem(`${investigationDraftPrefix}confirmation:${scope}`)
    // 只以不存在或本站保存的 null 证明没有原意图；未知或损坏内容均阻止新写入。
    return raw !== null && raw !== 'null'
  } catch { return true }
}
export function useInvestigationConfirmationIntent(scope: string | undefined, target: { caseId: string; kind: DoctorRecommendationKind; encounterId: string | undefined }) {
  return useStoredInvestigationValue(scope === undefined ? undefined : `${investigationDraftPrefix}confirmation:${scope}`,
    confirmationIntentSchema.nullable().refine(value => value === null || value.state.caseId === target.caseId && value.state.kind === target.kind
      && (target.encounterId === undefined || value.state.encounterId === target.encounterId)), null)
}
