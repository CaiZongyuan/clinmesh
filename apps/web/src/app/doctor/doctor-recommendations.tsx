import {
  doctorPreparationSelectionSchema, type DoctorPreparationSelection, type DoctorRecommendationConsideration,
  type DoctorRecommendationKind, type DoctorRecommendationState, type DoctorRecommendationSuggestion, type GuidelineEvidence, type DoctorRecommendationNotice,
} from '@clinmesh/contracts/doctor-recommendations'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpenIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { confirmDoctorPreparation, newIdempotencyKey } from '../api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { useDoctorPreparation, useDoctorPreparationJob, type DoctorPreparationJob, type DraftPreferences } from './doctor-preparation-state.tsx'

const titles: Record<DoctorRecommendationKind, [string, string]> = {
  laboratory: ['待开具检验', 'Laboratory orders'], imaging: ['待开具放射检查', 'Imaging orders'], pathology: ['待开具病理会诊', 'Pathology orders'],
  diagnosis: ['待确认诊断', 'Diagnoses to confirm'], prescription: ['待开具处方', 'Prescription to issue'],
}
const documentTypes: Record<GuidelineEvidence['documentType'], [string, string]> = {
  'national-standard': ['国家标准', 'National standard'], 'health-standard': ['卫生行业标准', 'Health industry standard'],
  'official-protocol': ['诊疗方案', 'Clinical protocol'], guideline: ['临床指南', 'Clinical guideline'],
  'product-information': ['药品说明书', 'Product information'],
}
const noticeTitles: Record<DoctorRecommendationNotice['category'], [string, string]> = {
  guideline: ['指南覆盖', 'Guideline coverage'], catalog: ['院内目录', 'Hospital catalog'],
  verification: ['核验未通过', 'Verification not passed'], processing: ['系统处理限制', 'Processing limitations'],
}
export type PreparationDraft = Exclude<DoctorPreparationSelection, { kind: 'prescription' | 'diagnosis' }> | (Omit<Extract<DoctorPreparationSelection, { kind: 'diagnosis' }>, 'role'> & { role: 'primary' | 'secondary' | null }) | (Omit<Extract<DoctorPreparationSelection, { kind: 'prescription' }>, 'doseText' | 'frequencyCode' | 'courseDays' | 'quantity'> & { doseText: string | null; frequencyCode: string | null; courseDays: number | null; quantity: number | null })

const identity = (item: DoctorRecommendationSuggestion | PreparationDraft) => JSON.stringify([item.kind,
  item.kind === 'imaging' || item.kind === 'pathology' ? item.serviceId : item.catalogItemId])
const evidenceSignature = (state: DoctorRecommendationState, item: DoctorRecommendationSuggestion) => JSON.stringify([
  [...new Set(item.caseEvidenceIds.map(id => { const evidence = state.caseEvidence.find(evidence => evidence.id === id); return JSON.stringify([evidence?.kind, evidence?.text]) }))].toSorted(),
  [...new Set(item.guidelineEvidenceIds.map(id => { const evidence = state.guidelines.find(evidence => evidence.id === id); return JSON.stringify([evidence?.sourceHash, evidence?.text]) }))].toSorted(),
])
function selection(item: DoctorRecommendationSuggestion): PreparationDraft {
  const source = { source: 'agent' as const, suggestionId: item.id }
  if (item.kind === 'diagnosis') return { ...source, kind: item.kind, catalogItemId: item.catalogItemId, role: item.role ?? null,
    ...(item.referenceConcept === undefined ? {} : { referenceConcept: item.referenceConcept }) }
  if (item.kind === 'prescription') return { ...source, kind: item.kind, catalogItemId: item.catalogItemId,
    doseText: item.doseText, frequencyCode: item.frequencyCode, courseDays: item.courseDays, quantity: item.quantity }
  if (item.kind === 'laboratory') return { ...source, kind: item.kind, catalogItemId: item.catalogItemId, indicationCode: item.indicationCode }
  if (item.kind === 'imaging') return { ...source, kind: item.kind, serviceId: item.serviceId, indication: item.indication }
  return { ...source, kind: item.kind, serviceId: item.serviceId, sourceProcedureReference: item.sourceProcedureReference, purpose: item.purpose }
}
function clinicalValue(item: PreparationDraft) {
  if (item.kind === 'diagnosis') return JSON.stringify([identity(item), item.role, item.note ?? ''])
  if (item.kind === 'prescription') return JSON.stringify([identity(item), item.doseText, item.frequencyCode, item.courseDays, item.quantity])
  if (item.kind === 'laboratory') return JSON.stringify([identity(item), item.indicationCode])
  if (item.kind === 'imaging') return JSON.stringify([identity(item), item.indication])
  return JSON.stringify([identity(item), item.sourceProcedureReference, item.purpose])
}
function complete(item: PreparationDraft) {
  return doctorPreparationSelectionSchema.safeParse(item).success
}
function frequencyLabel(code: string | null, zh: boolean) {
  const messages = getWorkspaceMessages(zh ? 'zh-CN' : 'en-US')
  const labels: Record<string, string> = { QD: messages.frequency_QD, BID: messages.frequency_BID, PRN: messages.frequency_PRN }
  return code === null ? messages.recommendationFieldPending : labels[code] ?? messages.frequency_pending
}
function indicationLabel(code: string, zh: boolean) {
  const messages = getWorkspaceMessages(zh ? 'zh-CN' : 'en-US')
  const labels: Record<string, string> = { fever: messages.indication_fever, 'clinical-evaluation': messages.indication_clinicalEvaluation }
  return labels[code] ?? messages.recommendationFieldPending
}
function summary(item: PreparationDraft, zh: boolean) {
  if (item.kind === 'diagnosis') return item.role === null ? zh ? '主次待确认' : 'Choose the diagnosis role' : item.role === 'primary' ? zh ? '主诊断' : 'Primary' : zh ? '次诊断' : 'Secondary'
  if (item.kind === 'prescription') return complete(item) ? `${item.doseText} · ${frequencyLabel(item.frequencyCode, zh)} · ${item.courseDays} ${zh ? '天' : 'days'} · ${item.quantity}` : zh ? '用法用量待补充' : 'Complete the prescription fields'
  if (item.kind === 'laboratory') return indicationLabel(item.indicationCode, zh)
  return item.kind === 'imaging' ? item.indication : item.purpose
}
function reasoning(item: DoctorRecommendationConsideration, zh: boolean) {
  const sections = [
    { label: zh ? '支持信息' : 'Supporting information', values: item.supportingInformation },
    { label: zh ? '反对信息' : 'Information against', values: item.opposingInformation },
    { label: zh ? '待核实事项' : 'Clarifications', values: item.missingInformation },
  ]
  return <><p>{item.rationale}</p>{sections.map(({ label, values }) => values.length === 0 ? null : <div key={label}><p className="font-medium">{label}</p><ul className="list-inside list-disc">{values.map(value => <li key={value}>{value}</li>)}</ul></div>)}</>
}
export function DoctorRecommendationDetails({ job, locale = 'zh-CN' }: { job: DoctorPreparationJob; locale?: WorkspaceLocale }) {
  const zh = locale === 'zh-CN', state = job.state ?? job.previous
  return <div className="flex min-w-0 flex-col gap-4 text-sm">
    <p role="status">{job.paused ? zh ? '自动准备已暂停；已启动的核对仍可完成。' : 'Automatic preparation is paused; work already started may finish.'
      : job.error !== null || state?.status === 'failed' ? zh ? '更新失败，医生草稿已保留，可重试。' : 'Update failed. Your draft is preserved; retry when ready.'
      : job.pending ? zh ? '正在按最新资料核对。' : 'Checking the latest information.'
      : state?.stale ? zh ? '资料有变化，旧自动项目等待重新核对。' : 'Information changed; previous automatic items need another check.'
      : zh ? '仅使用当前医生可见资料，正式提交由医生确认。' : 'Uses information visible to this doctor. The doctor confirms all formal actions.'}</p>
    {state === undefined ? null : <section aria-label={zh ? '准备记录' : 'Preparation record'} className="flex flex-col gap-2">
      <h4 className="font-medium">{state.generation === 0 ? zh ? '尚未开始准备' : 'Preparation has not started' : zh ? `第 ${state.generation} 轮准备` : `Preparation ${state.generation}`}</h4>
      {state.stale ? <p>{zh ? '资料或目录已更新，本轮结果等待重新核对。' : 'Information or catalog changed; this result needs another check.'}</p> : null}
      <p>{zh ? `已读取 ${state.caseEvidence.length} 份病例依据、${state.guidelines.length} 条指南依据。` : `${state.caseEvidence.length} case sources and ${state.guidelines.length} guideline sources available.`}</p>
      {state.status === 'ready' && !state.stale ? <p>{zh ? `独立核验后发布 ${state.items.length} 项，另有 ${state.considerations?.length ?? 0} 项待核实思路。` : `${state.items.length} verified items published; ${state.considerations?.length ?? 0} considerations.`}</p> : null}
    </section>}
    {state?.notices?.map((notice, index) => <Alert aria-label={noticeTitles[notice.category][zh ? 0 : 1]} key={`${notice.category}:${index}`}><AlertTitle>{noticeTitles[notice.category][zh ? 0 : 1]}</AlertTitle><AlertDescription>{notice.message}</AlertDescription></Alert>)}
    {!state?.notices?.length && state?.missingInformation.length ? <Alert aria-label={zh ? '补充说明' : 'Additional notes'}><AlertTitle>{zh ? '补充说明' : 'Additional notes'}</AlertTitle><AlertDescription>{state.missingInformation.map(note => <p key={note}>{note}</p>)}</AlertDescription></Alert> : null}
    {state?.items.map(item => <section className="flex min-w-0 flex-col gap-2" key={item.id}>
      <h4 className="font-medium">{item.label}</h4>{reasoning(item, zh)}
      {item.guidelineEvidenceIds.map(id => { const source = state.guidelines.find(source => source.id === id); return source === undefined ? null : <div key={id} className="flex flex-col gap-1"><Badge variant="secondary">{documentTypes[source.documentType][zh ? 0 : 1]}</Badge><a className="underline" href={source.url} rel="noreferrer noopener" target="_blank">{source.title} · {source.version} · {source.locator}</a><p className="text-xs text-muted-foreground">{source.publisher} · {source.scope}</p><p>{source.text}</p></div> })}
      {item.caseEvidenceIds.map(id => { const source = state.caseEvidence.find(source => source.id === id); return source === undefined ? null : <div key={id}><Badge variant="outline">{source.label}</Badge><p className="whitespace-pre-wrap break-words">{source.text}</p></div> })}<Separator />
    </section>)}
    {state?.considerations?.length ? <section aria-label={zh ? '待核实思路' : 'Considerations'} className="flex flex-col gap-4"><h4 className="font-medium">{zh ? '待核实思路' : 'Considerations'}</h4>{state.considerations.map(item => <article aria-label={item.label} key={item.id} className="flex flex-col gap-2"><h5>{item.label}</h5>{reasoning(item, zh)}{item.caseEvidenceIds.map(id => { const source = state.caseEvidence.find(source => source.id === id); return source === undefined ? null : <p className="whitespace-pre-wrap break-words" key={id}>{source.text}</p> })}</article>)}</section> : null}
  </div>
}

export function DoctorPreparationDetailsDialog({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{title === '依据与说明' ? '按需查看项目来源、核对结果和病历问题。' : 'Review sources, checks and document issues when needed.'}</DialogDescription></DialogHeader><div className="min-h-0 overflow-y-auto px-4 py-3">{children}</div></DialogContent></Dialog>
}

export type ManualPreparedItem = { label: string; value: PreparationDraft }
type PreparedRow = { key: string; label: string; value: PreparationDraft; signature: string; item?: DoctorRecommendationSuggestion }
const removalSignature = (row: PreparedRow) => row.item === undefined ? clinicalValue(row.value) : JSON.stringify([row.signature, clinicalValue(selection(row.item))])

function caseContainsConfirmation(detail: DoctorCaseDetail, result: Awaited<ReturnType<typeof confirmDoctorPreparation>>) {
  if (BigInt(detail.encounter.versionId) < BigInt(result.encounterVersion)) return false
  const kind = result.kind
  const version = kind === 'diagnosis' ? detail.diagnosis?.draftVersion : kind === 'prescription' ? detail.medicationConclusion?.draftVersion
    : kind === 'laboratory' ? detail.laboratoryRequests?.draftVersion : kind === 'imaging' ? detail.imagingRequests?.draftVersion : detail.pathologyRequests?.draftVersion
  const ids = kind === 'diagnosis' ? [detail.diagnosis?.confirmation?.id] : kind === 'prescription' ? [detail.medicationConclusion?.prescription?.id]
    : (kind === 'laboratory' ? detail.laboratoryRequests?.requests : kind === 'imaging' ? detail.imagingRequests?.requests : detail.pathologyRequests?.requests)?.map(record => record.id) ?? []
  return (version ?? 0) >= result.draftVersion && result.recordIds.every(id => ids.includes(id))
}

export function DoctorRecommendationsPanel({ caseId, kind, enabled, inputRevision, scope, locale = 'zh-CN', unavailableReason, manualUnavailableReason, manualItems = [], manualControls, onManualChange, onManualRemove, onConfirmed, encounter, resolveExistingDraft = false, expectedDraftVersion, disabled = false }: {
  caseId: string; kind: DoctorRecommendationKind; enabled: boolean; inputRevision?: string | undefined; scope?: string | undefined; locale?: WorkspaceLocale | undefined
  disabled?: boolean | undefined
  manualItems?: ManualPreparedItem[] | undefined
  manualControls?: ReactNode
  onManualChange?: ((item: ManualPreparedItem) => void) | undefined
  onManualRemove?: ((value: PreparationDraft) => void) | undefined
  encounter?: { id: string; versionId: string } | undefined
  resolveExistingDraft?: boolean | undefined
  manualUnavailableReason?: ((value: PreparationDraft) => string | undefined) | undefined
  onConfirmed?: ((values: PreparationDraft[], result: Awaited<ReturnType<typeof confirmDoctorPreparation>>) => void) | undefined
  expectedDraftVersion?: number | undefined
  unavailableReason?: ((suggestion: DoctorRecommendationSuggestion) => string | undefined) | undefined
}) {
  const preparation = useDoctorPreparation(), client = useQueryClient(), zh = locale === 'zh-CN'
  const localJob = useDoctorPreparationJob({ caseId, kind, enabled: enabled && preparation === undefined, paused: false, inputRevision, scope })
  const job = preparation?.jobs[kind] ?? localJob
  const preferenceKey = JSON.stringify([scope, caseId, kind])
  const [localPreferences, setLocalPreferences] = useState<Record<string, DraftPreferences>>({})
  const preferences = preparation?.preferences(kind) ?? localPreferences[preferenceKey] ?? { edits: {}, removed: {}, unselected: [], completed: {} }
  const update = (fn: (value: typeof preferences) => typeof preferences) => {
    if (preparation !== undefined) preparation.updatePreferences(kind, fn)
    else setLocalPreferences(previous => ({ ...previous, [preferenceKey]: fn(previous[preferenceKey] ?? { edits: {}, removed: {}, unselected: [], completed: {} }) }))
  }
  const [localDetails, setLocalDetails] = useState(false)
  const [editing, setEditing] = useState<{ key: string; label: string; value: PreparationDraft; fingerprint: string; view: number }>()
  const [editError, setEditError] = useState(false)
  const requestKeys = useRef(new Map<string, string>())
  const state = job.state, visible = state?.hidePreviousResults ? state : state === undefined || state.status === 'pending' || state.status === 'failed' ? job.previous : state
  const manualIdentity = JSON.stringify(manualItems)
  const manualOwnership = useRef({ identity: manualIdentity, token: 0 })
  if (manualOwnership.current.identity !== manualIdentity) manualOwnership.current = { identity: manualIdentity, token: manualOwnership.current.token + 1 }
  const manualKeys = new Set(manualItems.map(row => identity(row.value)))
  const conflicts = new Set(manualItems.filter(row => {
    const proposed = visible?.items.find(item => identity(item) === identity(row.value))
    return proposed !== undefined && clinicalValue(row.value) !== clinicalValue(selection(proposed))
  }).map(row => identity(row.value)))
  const baseRows: PreparedRow[] = [
    ...manualItems.map(row => ({ ...row, key: identity(row.value), signature: JSON.stringify([state?.inputFingerprint, clinicalValue(row.value), manualOwnership.current.token]) })),
    ...(visible?.items ?? []).filter(item => !manualKeys.has(identity(item))).map(item => ({ key: identity(item), label: item.label,
      item, value: selection(item), signature: evidenceSignature(visible!, item) })),
  ]
  const rows: Array<PreparedRow & { owner: DraftPreferences['edits'][string] | undefined }> = baseRows.filter(row => preferences.removed[row.key] !== removalSignature(row) && !preferences.completed[row.key]?.includes(row.signature))
    .map(row => ({ ...row, value: onManualChange !== undefined && manualKeys.has(row.key) ? row.value : preferences.edits[row.key]?.selection ?? row.value, owner: preferences.edits[row.key] }))
  for (const [key, edit] of Object.entries(preferences.edits)) if (!rows.some(row => row.key === key) && preferences.removed[key] === undefined) {
    rows.push({ key, label: edit.label, value: edit.selection, signature: edit.fingerprint, owner: edit })
  }
  const navigationIdentity = JSON.stringify([scope, caseId, kind, enabled, disabled])
  const navigation = useRef({ identity: navigationIdentity, token: 0 })
  if (navigation.current.identity !== navigationIdentity) navigation.current = { identity: navigationIdentity, token: navigation.current.token + 1 }
  const viewIdentity = JSON.stringify([navigationIdentity, inputRevision])
  const currentView = useRef({ identity: viewIdentity, token: 0 })
  if (currentView.current.identity !== viewIdentity) currentView.current = { identity: viewIdentity, token: currentView.current.token + 1 }
  const view = currentView.current.token
  const activeEditing = editing?.view === navigation.current.token ? editing : undefined
  const currentRows = useRef(rows)
  currentRows.current = rows
  const currentEdits = useRef(preferences.edits)
  currentEdits.current = preferences.edits
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const detail = preparation?.detail
  const currentDraftVersion = kind === 'diagnosis' ? detail?.diagnosis?.draftVersion ?? 0 : kind === 'prescription' ? detail?.medicationConclusion?.draftVersion ?? 0
    : kind === 'laboratory' ? detail?.laboratoryRequests?.draftVersion ?? 0 : kind === 'imaging' ? detail?.imagingRequests?.draftVersion ?? 0 : detail?.pathologyRequests?.draftVersion ?? 0
  const draftVersion = expectedDraftVersion ?? currentDraftVersion
  const submissionKey = JSON.stringify([scope, kind])
  type Submission = { state: Parameters<typeof confirmDoctorPreparation>[0]; selections: DoctorPreparationSelection[]; view: number; navigation: number; rows: typeof rows; draftVersion: number; resolveExistingDraft: boolean; submissionKey: string; token: string; scope: string | undefined; manualOwnership: number; manualItems: ManualPreparedItem[] }
  const synchronization = useRef(new Map<string, 'owned' | 'applied'>())
  const recordVisible = (request: Submission, result: Awaited<ReturnType<typeof confirmDoctorPreparation>>) => client.getQueriesData<DoctorCaseDetail>({ predicate: query => query.queryKey[0] === 'doctor-case' && query.queryKey.includes(request.state.caseId) })
    .some(([key, clinical]) => {
      const query = client.getQueryState(key)
      return clinical?.caseId === request.state.caseId && query?.status === 'success' && !query.isInvalidated && query.fetchStatus === 'idle' && caseContainsConfirmation(clinical, result)
    })
  const synchronize = async (result: Awaited<ReturnType<typeof confirmDoctorPreparation>>, request: Submission) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['doctor-recommendations', request.scope, request.state.caseId, request.state.kind] }),
      client.invalidateQueries({ predicate: query => query.queryKey[0] === 'doctor-case' && query.queryKey.includes(request.state.caseId) }),
    ])
    const remainingIdentity = JSON.stringify(request.manualItems.filter(item => !request.rows.some(row => row.key === identity(item.value))))
    const ownsManual = manualOwnership.current.token === request.manualOwnership || onConfirmed !== undefined
      && manualOwnership.current.token === request.manualOwnership + 1 && manualOwnership.current.identity === remainingIdentity
    if (synchronization.current.get(request.token) === 'owned' && mounted.current && navigation.current.token === request.navigation
      && ownsManual && Object.keys(currentEdits.current).length === 0
      && manualItems.every(item => request.rows.some(row => row.key === identity(item.value))) && recordVisible(request, result)) {
      synchronization.current.set(request.token, 'applied')
      preparation?.confirmed(request.submissionKey)
    }
  }
  const submission = useMutation({
    onMutate: request => { preparation?.setSubmitting(request.submissionKey, request.token, true) },
    onSettled: (_result, _error, request) => { preparation?.setSubmitting(request.submissionKey, request.token, false) },
    mutationFn: (request: Submission) => {
      const intent = JSON.stringify([request.scope, request.state.caseId, request.state.kind, request.state.inputFingerprint, request.state.generation, request.draftVersion, request.resolveExistingDraft, request.selections])
      const key = requestKeys.current.get(intent) ?? newIdempotencyKey();requestKeys.current.set(intent, key)
      return confirmDoctorPreparation(request.state, request.draftVersion, request.selections, key, request.resolveExistingDraft)
    },
    onSuccess: async (result, request) => {
      const ownsView = mounted.current && currentView.current.token === request.view && manualOwnership.current.token === request.manualOwnership
        && request.rows.every(row => currentRows.current.find(current => current.key === row.key)?.item === row.item && currentEdits.current[row.key] === row.owner)
      if (ownsView) synchronization.current.set(request.token, 'owned')
      if (ownsView) update(previous => {
        const unchanged = request.rows.filter(row => previous.edits[row.key] === row.owner && currentRows.current.find(current => current.key === row.key)?.item === row.item)
        return { ...previous, completed: { ...previous.completed, ...Object.fromEntries(unchanged.map(row => {
          const automatic = visible?.items.find(item => identity(item) === row.key)
          return [row.key, [row.signature, ...automatic === undefined ? [] : [evidenceSignature(visible!, automatic)]]]
        })) },
          edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => !unchanged.some(row => row.key === key))) }
      })
      if (ownsView) onConfirmed?.(request.rows.map(row => row.value), result)
      await synchronize(result, request)
    },
  })
  const automaticReady = state?.status === 'ready' && !state.stale && !job.pending && job.error === null && !job.paused
  const available = rows.filter(row => complete(row.value) && !preferences.unselected.includes(row.key) && preferences.removed[row.key] === undefined
    && (row.value.source === 'manual' || automaticReady))
  const needsReview = (key: string) => {
    if (preferences.removed[key] !== undefined) return true
    const edit = preferences.edits[key]
    return state !== undefined && edit?.reviewedFingerprint !== state.inputFingerprint
      && (conflicts.has(key) || edit !== undefined && edit.fingerprint !== state.inputFingerprint)
  }
  const submitting = submission.isPending && submission.variables?.view === view || preparation?.submitting(kind) === true
  const pending = job.pending || submitting
  const currentEncounter = encounter ?? detail?.encounter
  const manualOnly = available.every(row => row.value.source === 'manual') && currentEncounter !== undefined
  const confirmationContext = manualOnly ? { caseId, kind, encounterId: currentEncounter.id, encounterVersion: currentEncounter.versionId } : state
  const rolesValid = kind !== 'diagnosis' || available.filter(row => row.value.kind === 'diagnosis' && row.value.role === 'primary').length === 1
  const succeeded = submission.isSuccess && submission.variables.navigation === navigation.current.token
  const recordsUpdated = succeeded && recordVisible(submission.variables, submission.data)
  const subsequentIntent = succeeded && recordsUpdated
    && available.some(row => !submission.variables.rows.some(previous => clinicalValue(row.value) === clinicalValue(previous.value) && row.signature === previous.signature))
  const completedIntent = succeeded && !subsequentIntent
  const refreshRecords = succeeded && !recordsUpdated
  const canConfirm = !completedIntent && !disabled && rolesValid && confirmationContext !== undefined && !submitting
    && (manualOnly || !pending && !job.paused && job.error === null && !state?.stale
      && (state?.status === 'ready' || state?.status === 'missing-evidence' && available.every(row => row.value.source === 'manual')))
  const block = available.length > 8 ? zh ? '一次最多选择 8 项。' : 'Select at most eight items.'
    : available.map(row => row.value.source === 'manual' ? manualUnavailableReason?.(row.value) : row.item === undefined ? undefined : unavailableReason?.(row.item)).find(reason => reason !== undefined)
  const failed = !completedIntent && (job.error !== null || state?.status === 'failed' || submission.isError && submission.variables?.view === view)
  if (!enabled) return null
  return <>
    <Card aria-label={titles[kind][zh ? 0 : 1]} role="region" className="mb-4 min-w-0" data-agent-phase={job.pending ? 'working' : 'ready'}>
      <CardHeader><CardTitle>{titles[kind][zh ? 0 : 1]}</CardTitle><CardAction><div className="flex flex-wrap gap-2">
        {manualControls}
        <Button disabled={refreshRecords ? false : pending || job.paused || state === undefined} onClick={() => {
          if (refreshRecords) { void synchronize(submission.data, submission.variables);return }
          if (!succeeded) submission.reset()
          job.refresh()
        }} size="sm" type="button" variant="ghost"><RefreshCwIcon data-icon="inline-start" />{refreshRecords ? zh ? '刷新记录' : 'Refresh records' : zh ? '刷新' : 'Refresh'}</Button>
        {preparation === undefined ? null : <Button onClick={preparation.togglePaused} size="sm" type="button" variant="ghost">{job.paused ? zh ? '恢复自动准备' : 'Resume' : zh ? '暂停自动准备' : 'Pause'}</Button>}
        <Button onClick={() => preparation === undefined ? setLocalDetails(true) : preparation.openDetails(kind)} size="sm" type="button" variant="outline"><BookOpenIcon data-icon="inline-start" />{zh ? '依据与说明' : 'Evidence and details'}</Button>
      </div></CardAction></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-xs text-muted-foreground" role="status">{completedIntent ? zh ? `已完成${kind === 'diagnosis' ? '确认' : '开具'}，${recordsUpdated ? '记录已更新。' : '记录暂未刷新，请刷新查看。'}` : recordsUpdated ? 'Confirmed; records are up to date.' : 'Confirmed; refresh the records to see the result.' : job.paused ? zh ? '自动准备已暂停' : 'Preparation paused' : pending ? zh ? '正在按最新资料更新，旧自动项目暂不可开具。' : 'Updating; previous automatic items cannot be submitted yet.'
          : failed ? zh ? '更新或提交未完成，草稿已保留，可重试。' : 'Update or submission failed. Your draft is preserved.'
          : state?.stale ? zh ? '资料有变化，等待重新核对。' : 'Information changed; another check is needed.'
          : state?.status === 'ready' && job.ready ? zh ? '已按最新资料核对，由医生确认。' : 'Checked against the latest information; awaiting confirmation.'
          : state?.status === 'missing-evidence' ? zh ? '暂无可直接开具的项目，可查看说明。' : 'No executable items; see the details.'
          : zh ? '尚未完成核对。' : 'Checks are not complete.'}</p>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{zh ? '暂无可直接确认或开具的项目。' : 'No items are ready to confirm or issue.'}</p> : <div className="flex flex-col divide-y">
          {rows.map(row => <div className="flex min-w-0 flex-wrap items-center gap-3 py-3" key={row.key}>
            <Checkbox aria-label={`${zh ? '选择' : 'Select '}${row.label}`} checked={!preferences.unselected.includes(row.key) && preferences.removed[row.key] === undefined && complete(row.value)} disabled={!complete(row.value)} onCheckedChange={checked => update(previous => {
              const { [row.key]: _removed, ...removed } = previous.removed
              return { ...previous, removed: checked ? removed : previous.removed, unselected: checked ? previous.unselected.filter(key => key !== row.key) : [...previous.unselected.filter(key => key !== row.key), row.key] }
            })} />
            <div className="min-w-0 flex-1"><p className="break-words font-medium">{row.label}</p><p className="break-words text-xs text-muted-foreground">{summary(row.value, zh)}</p>{preferences.removed[row.key] !== undefined ? <p className="text-xs text-muted-foreground">{zh ? '已移除项目的依据或方案有变化，请核对。' : 'The evidence or plan for this removed item changed. Review it.'}</p> : conflicts.has(row.key) && needsReview(row.key) ? <p className="text-xs text-muted-foreground">{zh ? '新建议与医生填写内容不同，请核对。' : 'The new suggestion differs from your entry. Review this item.'}</p> : null}</div>
            <Badge variant="secondary">{needsReview(row.key) ? zh ? '请核对新资料' : 'Review new information' : !complete(row.value) ? zh ? '待补充' : 'Incomplete' : row.value.source === 'manual' ? zh ? '医生已调整' : 'Edited by doctor' : !automaticReady ? zh ? '待更新' : 'Updating' : zh ? '待确认' : 'Ready'}</Badge>
            <Button onClick={() => { setEditing({ key: row.key, label: row.label, value: { ...row.value }, fingerprint: state?.inputFingerprint ?? '', view: navigation.current.token });setEditError(false) }} size="sm" type="button" variant="ghost">{needsReview(row.key) ? zh ? '核对' : 'Review' : zh ? '调整' : 'Edit'}</Button>
            <Button aria-label={`${zh ? '移除' : 'Remove '}${row.label}`} disabled={submission.isPending} onClick={() => {
              if (row.value.source === 'manual' && manualKeys.has(row.key) && onManualRemove !== undefined) {
                onManualRemove(row.value)
                const automatic = visible?.items.find(item => identity(item) === row.key)
                update(previous => ({ ...previous,
                  removed: automatic === undefined ? previous.removed : { ...previous.removed, [row.key]: removalSignature({ key: row.key, label: automatic.label, value: selection(automatic), item: automatic, signature: evidenceSignature(visible!, automatic) }) },
                  edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== row.key)),
                }))
                return
              }
              update(previous => ({ ...previous, removed: { ...previous.removed, [row.key]: removalSignature(baseRows.find(base => base.key === row.key) ?? row) }, edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== row.key)) }))
            }} size="icon-sm" type="button" variant="ghost"><Trash2Icon /></Button>
          </div>)}
        </div>}
        {!rolesValid && available.length > 0 ? <p className="text-xs text-muted-foreground">{zh ? '请核对主次诊断，保留一条主诊断。' : 'Review the diagnosis roles and keep one primary diagnosis.'}</p> : null}
        {block === undefined ? null : <p className="text-xs text-muted-foreground">{block}</p>}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{zh ? `已选 ${available.length} 项` : `${available.length} selected`}</p><Button disabled={!canConfirm || available.length === 0 || block !== undefined || available.some(row => needsReview(row.key) && !(currentEncounter !== undefined && row.value.source === 'manual'))} onClick={() => { if (confirmationContext !== undefined) submission.mutate({ state: confirmationContext, selections: available.map(row => doctorPreparationSelectionSchema.parse(row.value)), view, navigation: navigation.current.token, rows: available, draftVersion, resolveExistingDraft, submissionKey, token: newIdempotencyKey(), scope, manualOwnership: manualOwnership.current.token, manualItems }) }} type="button">{kind === 'diagnosis' ? zh ? '确认选中诊断' : 'Confirm selected diagnoses' : kind === 'prescription' ? zh ? '开具处方' : 'Issue prescription' : zh ? '开具选中项目' : 'Issue selected orders'}（{available.length}）</Button></CardFooter>
    </Card>
    {preparation === undefined ? <DoctorPreparationDetailsDialog open={localDetails} onOpenChange={setLocalDetails} title={zh ? '依据与说明' : 'Evidence and details'}><DoctorRecommendationDetails job={job} locale={locale} /></DoctorPreparationDetailsDialog> : null}
    <Dialog open={activeEditing !== undefined} onOpenChange={open => { if (!open) setEditing(undefined) }}><DialogContent><DialogHeader><DialogTitle>{zh ? '调整项目' : 'Edit item'}</DialogTitle><DialogDescription>{activeEditing?.label}</DialogDescription></DialogHeader>
      {activeEditing === undefined ? null : <form onSubmit={event => {
        event.preventDefault();if (activeEditing.view !== navigation.current.token) return;const values = new FormData(event.currentTarget), { suggestionId: _id, ...base } = activeEditing.value
        const candidate = { ...base, source: 'manual', ...Object.fromEntries(values) }
        if ('courseDays' in candidate) candidate.courseDays = Number(values.get('courseDays'))
        if ('quantity' in candidate) candidate.quantity = Number(values.get('quantity'))
        if ('note' in candidate && typeof candidate.note === 'string' && candidate.note.trim() === '') delete candidate.note
        const result = doctorPreparationSelectionSchema.safeParse(candidate)
        if (!result.success || !complete(result.data)) { setEditError(true);return }
        update(previous => {
          const { [activeEditing.key]: _removed, ...removed } = previous.removed
          return { ...previous, removed, edits: { ...previous.edits, [activeEditing.key]: { label: activeEditing.label, selection: result.data, fingerprint: activeEditing.fingerprint, reviewedFingerprint: activeEditing.fingerprint } }, unselected: previous.unselected.filter(key => key !== activeEditing.key) }
        })
        onManualChange?.({ label: activeEditing.label, value: result.data })
        setEditing(undefined)
      }}><FieldGroup className="max-h-[55svh] overflow-y-auto px-4 py-3">
        {needsReview(activeEditing.key) ? <p className="text-sm">{zh ? '新资料已到达，请核对后决定保留、修改或移除。' : 'New information arrived. Review this item before keeping it.'}</p> : null}
        {activeEditing.value.kind === 'diagnosis' ? <Field><FieldLabel>{zh ? '诊断类别' : 'Diagnosis role'}</FieldLabel><ToggleGroup value={activeEditing.value.role === null ? [] : [activeEditing.value.role]} onValueChange={values => { const role = values[0];if (role === 'primary' || role === 'secondary') setEditing(previous => previous?.value.kind === 'diagnosis' ? { ...previous, value: { ...previous.value, role } } : previous) }}><ToggleGroupItem value="primary">{zh ? '主诊断' : 'Primary'}</ToggleGroupItem><ToggleGroupItem value="secondary">{zh ? '次诊断' : 'Secondary'}</ToggleGroupItem></ToggleGroup></Field> : null}
        {activeEditing.value.kind === 'diagnosis' ? <Field><FieldLabel htmlFor="prepared-note">{zh ? '备注' : 'Note'}</FieldLabel><Input defaultValue={activeEditing.value.note ?? ''} id="prepared-note" maxLength={500} name="note" /></Field> : null}
        {(activeEditing.value.kind === 'prescription' ? [['doseText', zh ? '每次剂量' : 'Dose'], ['frequencyCode', zh ? '频次' : 'Frequency'], ['courseDays', zh ? '疗程（天）' : 'Days'], ['quantity', zh ? '数量' : 'Quantity']]
          : activeEditing.value.kind === 'laboratory' ? [['indicationCode', zh ? '检查目的' : 'Indication']]
          : activeEditing.value.kind === 'imaging' ? [['indication', zh ? '检查目的' : 'Indication']]
          : activeEditing.value.kind === 'pathology' ? [['purpose', zh ? '会诊目的' : 'Purpose']] : []).map(([field, label]) => {
            const value = field === 'doseText' && activeEditing.value.kind === 'prescription' ? activeEditing.value.doseText : field === 'frequencyCode' && activeEditing.value.kind === 'prescription' ? activeEditing.value.frequencyCode : field === 'courseDays' && activeEditing.value.kind === 'prescription' ? activeEditing.value.courseDays : field === 'quantity' && activeEditing.value.kind === 'prescription' ? activeEditing.value.quantity : field === 'indicationCode' && activeEditing.value.kind === 'laboratory' ? activeEditing.value.indicationCode : field === 'indication' && activeEditing.value.kind === 'imaging' ? activeEditing.value.indication : activeEditing.value.kind === 'pathology' ? activeEditing.value.purpose : ''
            return <Field key={field}><FieldLabel htmlFor={`prepared-${field}`}>{label}</FieldLabel>{field === 'frequencyCode' && activeEditing.value.kind === 'prescription'
              ? <WorkspaceSelect id={`prepared-${field}`} value={activeEditing.value.frequencyCode} placeholder={zh ? '请选择频次' : 'Choose frequency'} items={[...new Set(['QD', 'BID', 'PRN', ...activeEditing.value.frequencyCode ? [activeEditing.value.frequencyCode] : []])].map(code => ({ value: code, label: frequencyLabel(code, zh) }))}
                onValueChange={code => setEditing(previous => previous?.value.kind === 'prescription' ? { ...previous, value: { ...previous.value, frequencyCode: code } } : previous)} />
              : field === 'indicationCode' && activeEditing.value.kind === 'laboratory'
                ? <WorkspaceSelect id={`prepared-${field}`} value={activeEditing.value.indicationCode} items={[...new Set(['clinical-evaluation', 'fever', activeEditing.value.indicationCode])].map(code => ({ value: code, label: indicationLabel(code, zh) }))}
                  onValueChange={code => { if (code !== null) setEditing(previous => previous?.value.kind === 'laboratory' ? { ...previous, value: { ...previous.value, indicationCode: code } } : previous) }} />
                : <Input defaultValue={value ?? ''} id={`prepared-${field}`} min={1} name={field} required type={field === 'quantity' || field === 'courseDays' ? 'number' : 'text'} />}</Field>
          })}
        {editError ? <p role="alert">{zh ? '请补齐有效的项目信息。' : 'Complete the item with valid values.'}</p> : null}
      </FieldGroup><DialogFooter><Button type="submit">{zh ? '保留本次调整' : 'Keep edits'}</Button></DialogFooter></form>}
    </DialogContent></Dialog>
  </>
}
