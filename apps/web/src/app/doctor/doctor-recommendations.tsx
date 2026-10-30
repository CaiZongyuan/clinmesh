import {
  considerationLabelKey, doctorPreparationSelectionSchema, type DoctorCaseEvidence, type DoctorPreparationSelection, type DoctorRecommendationConsideration,
  type DoctorRecommendationKind,
  type DoctorRecommendationNotice,
  type DoctorRecommendationState, type DoctorRecommendationSuggestion,
  type DoctorReviewedInvestigationService,
  type GuidelineEvidence,
  type SetDoctorConsiderationDispositionRequest,
} from '@clinmesh/contracts/doctor-recommendations'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpenIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ApiClientError, confirmDoctorPreparation, newIdempotencyKey, setConsiderationDisposition } from '../api-client.ts'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { DoctorDraftEditorScope, DoctorDraftItem, DoctorDraftField as Field, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { useOrderDetails } from './doctor-order-workspace.tsx'
import { useDoctorPreparation, useDoctorPreparationJob, type DoctorPreparationJob, type DraftPreferences, type PreparationDraft } from './doctor-preparation-state.tsx'

export type { PreparationDraft } from './doctor-preparation-state.tsx'

export const doctorRecommendationKindTitles: Record<DoctorRecommendationKind, [string, string]> = {
  laboratory: ['待开具检验', 'Laboratory orders'], imaging: ['待开具放射检查', 'Imaging orders'], pathology: ['待开具病理会诊', 'Pathology orders'],
  diagnosis: ['待确认诊断', 'Diagnoses to confirm'], prescription: ['待开具处方', 'Prescription to issue'],
}
const documentTypes: Record<GuidelineEvidence['documentType'], [string, string]> = {
  'national-standard': ['国家标准', 'National standard'], 'health-standard': ['卫生行业标准', 'Health industry standard'],
  'official-protocol': ['诊疗方案', 'Clinical protocol'], guideline: ['临床指南', 'Clinical guideline'],
  'product-information': ['药品说明书', 'Product information'],
  'expert-consensus': ['专家共识', 'Expert consensus'], 'scientific-statement': ['科学声明', 'Scientific statement'],
  'decision-pathway': ['决策路径', 'Decision pathway'], 'position-paper': ['立场文件', 'Position paper'],
}
const noticeTitles: Record<DoctorRecommendationNotice['category'], [string, string]> = {
  guideline: ['指南覆盖', 'Guideline coverage'], catalog: ['院内目录', 'Hospital catalog'],
  verification: ['核验未通过', 'Verification not passed'], processing: ['系统处理限制', 'Processing limitations'],
}
const identity = (item: DoctorRecommendationSuggestion | PreparationDraft) => JSON.stringify([item.kind,
  item.kind === 'imaging' || item.kind === 'pathology' ? item.serviceId : item.catalogItemId])
const evidenceSignature = (state: DoctorRecommendationState, item: DoctorRecommendationSuggestion) => JSON.stringify([
  [...new Set(item.caseEvidenceIds.map(id => { const evidence = state.caseEvidence.find(evidence => evidence.id === id); return JSON.stringify([evidence?.kind, evidence?.text]) }))].toSorted(),
  [...new Set(item.guidelineEvidenceIds.map(id => { const evidence = state.guidelines.find(evidence => evidence.id === id); return JSON.stringify([evidence?.sourceHash, evidence?.text]) }))].toSorted(),
])
const serviceReviewSignature = (service: DoctorReviewedInvestigationService | undefined) => {
  const price = service?.outpatientBilling
  return JSON.stringify([service?.id, service?.version, price == null ? null
    : [price.id, price.version, price.priceFen, price.currency, price.unit, price.source, price.effectiveOn]])
}
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
  if (item.kind === 'laboratory') return JSON.stringify([identity(item), item.indicationCode, item.reviewedService])
  if (item.kind === 'imaging') return JSON.stringify([identity(item), item.indication, item.reviewedService])
  return JSON.stringify([identity(item), item.sourceProcedureReference, item.purpose, item.reviewedService])
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
function reasoning(item: DoctorRecommendationConsideration, zh: boolean, evidenceLabels?: ReadonlyMap<string, string>) {
  // 叙述文本中的证据 id 引用映射为人读来源；未命中的文本原样保留。
  const readable = (value: string) => {
    if (evidenceLabels === undefined) return value
    let text = value
    for (const [id, label] of [...evidenceLabels].toSorted(([left], [right]) => right.length - left.length)) text = text.split(id).join(label)
    return text
  }
  const sections = [
    { label: zh ? '支持信息' : 'Supporting information', values: item.supportingInformation },
    { label: zh ? '反对信息' : 'Information against', values: item.opposingInformation },
    { label: zh ? '待核实事项' : 'Clarifications', values: item.missingInformation },
  ]
  return <><p>{readable(item.rationale)}</p>{sections.map(({ label, values }) => values.length === 0 ? null : <div key={label}><p className="font-medium">{label}</p><ul className="list-inside list-disc">{values.map(value => <li key={value}>{readable(value)}</li>)}</ul></div>)}</>
}
// 证据文本复用模型的原始输入，结构化形状在此渲染为人读内容；识别不了的 JSON 折叠在原始数据里保持可审计。
function EvidenceContent({ source, locale }: { source: DoctorCaseEvidence; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN'
  let parsed: unknown
  try { parsed = JSON.parse(source.text) } catch { /* 纯文本证据按原文展示。 */ }
  if (typeof parsed === 'object' && parsed !== null) {
    if ('speaker' in parsed && 'text' in parsed) {
      const turn = parsed as { text: unknown; recordedAt?: unknown }
      if (typeof turn.text === 'string') return <div className="flex min-w-0 flex-col gap-1">
        <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        {typeof turn.recordedAt === 'string' ? <p className="text-xs text-muted-foreground">{formatClinicalDateTime(turn.recordedAt, locale)}</p> : null}
      </div>
    }
    if ('entries' in parsed && Array.isArray((parsed as { entries: unknown }).entries)) return <ul className="flex list-inside list-disc flex-col gap-1">
      {(parsed as { entries: unknown[] }).entries.map((entry, index) => {
        const item = entry as { entryId?: unknown; clinicalDate?: unknown; title?: unknown; fieldPath?: unknown; record?: unknown }
        const record = typeof item.record === 'object' && item.record !== null ? item.record as Record<string, unknown> : undefined
        const date = typeof item.clinicalDate === 'string' ? item.clinicalDate : typeof record?.completedAt === 'string' ? record.completedAt : undefined
        const key = `${typeof item.entryId === 'string' ? item.entryId : index}:${typeof item.fieldPath === 'string' ? item.fieldPath : ''}`
        const title = [typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined,
          typeof item.fieldPath === 'string' ? item.fieldPath : undefined].find(value => value !== undefined) ?? (typeof item.entryId === 'string' ? item.entryId : `${index + 1}`)
        return <li key={key}>{date === undefined ? null : <span className="text-muted-foreground">{formatClinicalDateTime(date, locale)} · </span>}<span>{title}</span>
          {record === undefined ? null : <details><summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '查看完整记录' : 'View full record'}</summary>
            <p className="font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(record, null, 2)}</p></details>}
        </li>
      })}
    </ul>
    if (Array.isArray(parsed)) return <ul className="flex list-inside list-disc flex-col gap-1">
      {(parsed as unknown[]).map((entry, index) => {
        const item = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined
        const date = typeof item?.recordedDate === 'string' ? item.recordedDate : undefined
        const display = typeof item?.display === 'string' ? item.display : item === undefined ? (typeof entry === 'string' ? entry : JSON.stringify(entry)) : JSON.stringify(entry)
        return <li key={index}>{date === undefined ? null : <span className="text-muted-foreground">{formatClinicalDateTime(date, locale)} · </span>}<span className="break-words">{display}</span></li>
      })}
    </ul>
    return <details><summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '查看原始数据' : 'View raw data'}</summary>
      <p className="font-mono text-xs whitespace-pre-wrap break-all">{source.text}</p></details>
  }
  return <p className="whitespace-pre-wrap break-words">{source.text}</p>
}
// 证据默认折叠为一行来源摘要（问诊附时间、历史附条数），展开才铺开原文，避免长文与多思路重复引用淹没弹窗。
function evidenceSummary(source: DoctorCaseEvidence, locale: WorkspaceLocale) {
  const zh = locale === 'zh-CN'
  try {
    const parsed: unknown = JSON.parse(source.text)
    if (typeof parsed === 'object' && parsed !== null) {
      const shape = parsed as { recordedAt?: unknown; entries?: unknown }
      if (typeof shape.recordedAt === 'string') return formatClinicalDateTime(shape.recordedAt, locale)
      if (Array.isArray(shape.entries)) return zh ? `${shape.entries.length} 条记录` : `${shape.entries.length} records`
      if (Array.isArray(parsed)) return zh ? `${parsed.length} 条记录` : `${parsed.length} records`
    }
  } catch { /* 纯文本证据不加摘要。 */ }
  return undefined
}
function EvidenceDisclosure({ source, locale }: { source: DoctorCaseEvidence; locale: WorkspaceLocale }) {
  const summary = evidenceSummary(source, locale)
  return <details className="min-w-0">
    <summary className="cursor-pointer text-xs text-muted-foreground break-words">{source.label}{summary === undefined ? null : <span> · {summary}</span>}</summary>
    <div className="pt-1"><EvidenceContent source={source} locale={locale} /></div>
  </details>
}
function recoveryMessage(state: DoctorRecommendationState | undefined, zh: boolean) {
  if (state?.errorCode === 'MODEL_OUTCOME_UNKNOWN' || state?.recovery?.status === 'unknown') return zh
    ? state.recovery?.canContinue ? '上次请求结果未知，自动处理已停止。可继续原任务或重新生成。' : '上次请求结果未知，自动处理已停止。请明确重新生成。'
    : state.recovery?.canContinue ? 'The last request has an unknown outcome. Continue the original task or regenerate.' : 'The last request has an unknown outcome. Regenerate to start a new task.'
  if (state?.recovery?.status === 'exhausted') return zh ? '本次任务的请求次数已用完，自动处理已停止。' : 'This task reached its request limit. Automatic processing stopped.'
  return undefined
}
export function DoctorRecommendationDetails({ job, locale = 'zh-CN' }: { job: DoctorPreparationJob; locale?: WorkspaceLocale }) {
  const zh = locale === 'zh-CN', state = job.state ?? job.previous
  const recovery = recoveryMessage(state, zh)
  const client = useQueryClient()
  const evidenceLabels = new Map((state?.caseEvidence ?? []).map(source => [source.id, source.label] as const))
  const dispositions = state?.considerationDispositions ?? []
  const dispositionByKey = new Map(dispositions.map(entry => [entry.labelKey, entry] as const))
  const activeConsiderations = (state?.considerations ?? []).filter(item => !dispositionByKey.has(considerationLabelKey(item.label)))
  const disposition = useMutation({
    mutationFn: async (input: SetDoctorConsiderationDispositionRequest['input']) => {
      if (state === undefined) throw new Error(zh ? '当前病例建议状态不可用。' : 'The recommendation state is unavailable.')
      return setConsiderationDisposition({ caseId: state.caseId, kind: state.kind }, input.label, input.status)
    },
    onSuccess: () => { void client.invalidateQueries({ predicate: query =>
      query.queryKey[0] === 'doctor-recommendations' && query.queryKey.includes(state?.caseId) && query.queryKey.includes(state?.kind) }) },
  })
  return <div className="flex min-w-0 flex-col gap-4 text-sm">
    <p role="status">{job.paused ? zh ? '自动准备已暂停；已启动的核对仍可完成。' : 'Automatic preparation is paused; work already started may finish.'
      : recovery !== undefined ? recovery
      : job.error !== null || state?.status === 'failed' ? zh ? '更新失败，医生草稿已保留。' : 'Update failed. Your draft is preserved.'
      : job.pending ? zh ? '正在按最新资料核对。' : 'Checking the latest information.'
      : state?.stale ? zh ? '资料有变化，旧自动项目等待重新核对。' : 'Information changed; previous automatic items need another check.'
      : zh ? '仅使用当前医生可见资料，正式提交由医生确认。' : 'Uses information visible to this doctor. The doctor confirms all formal actions.'}</p>
    {state === undefined ? null : <section aria-label={zh ? '准备记录' : 'Preparation record'} className="flex flex-col gap-2">
      <h4 className="font-medium">{state.generation === 0 ? zh ? '尚未开始准备' : 'Preparation has not started' : zh ? `第 ${state.generation} 轮准备` : `Preparation ${state.generation}`}</h4>
      {state.stale ? <p>{zh ? '资料或目录已更新，本轮结果等待重新核对。' : 'Information or catalog changed; this result needs another check.'}</p> : null}
      <p>{zh ? `已读取 ${state.caseEvidence.length} 份病例依据、${state.guidelines.length} 条指南依据。` : `${state.caseEvidence.length} case sources and ${state.guidelines.length} guideline sources available.`}</p>
      {state.status === 'ready' && !state.stale ? <p>{zh ? `独立核验后发布 ${state.items.length} 项，另有 ${activeConsiderations.length} 项待核实思路。` : `${state.items.length} verified items published; ${activeConsiderations.length} considerations.`}</p> : null}
    </section>}
    {state?.notices?.map((notice, index) => <Alert aria-label={noticeTitles[notice.category][zh ? 0 : 1]} key={`${notice.category}:${index}`}><AlertTitle>{noticeTitles[notice.category][zh ? 0 : 1]}</AlertTitle><AlertDescription>{notice.message}</AlertDescription></Alert>)}
    {!state?.notices?.length && state?.missingInformation.length ? <Alert aria-label={zh ? '补充说明' : 'Additional notes'}><AlertTitle>{zh ? '补充说明' : 'Additional notes'}</AlertTitle><AlertDescription>{state.missingInformation.map(note => <p key={note}>{note}</p>)}</AlertDescription></Alert> : null}
    {state?.items.map(item => <section className="flex min-w-0 flex-col gap-2" key={item.id}>
      <h4 className="font-medium">{item.label}</h4>{reasoning(item, zh, evidenceLabels)}
      {item.guidelineEvidenceIds.map(id => { const source = state.guidelines.find(source => source.id === id); return source === undefined ? null : <div key={id} className="flex flex-col gap-1"><Badge variant="secondary">{documentTypes[source.documentType][zh ? 0 : 1]}</Badge><a className="underline" href={source.url} rel="noreferrer noopener" target="_blank">{source.title} · {source.version} · {source.locator}</a><p className="text-xs text-muted-foreground">{source.publisher} · {source.scope}</p><p>{source.text}</p></div> })}
      {item.caseEvidenceIds.map(id => { const source = state.caseEvidence.find(source => source.id === id); return source === undefined ? null : <EvidenceDisclosure key={id} source={source} locale={locale} /> })}<Separator />
    </section>)}
    {activeConsiderations.length > 0 ? <section aria-label={zh ? '待核实思路' : 'Considerations'} className="flex flex-col gap-4"><h4 className="font-medium">{zh ? '待核实思路' : 'Considerations'}</h4>{activeConsiderations.map(item => <article aria-label={item.label} key={item.id} className="flex flex-col gap-2"><h5>{item.label}</h5>{reasoning(item, zh, evidenceLabels)}{item.caseEvidenceIds.map(id => { const source = state?.caseEvidence.find(source => source.id === id); return source === undefined ? null : <EvidenceDisclosure key={id} source={source} locale={locale} /> })}
      <div className="flex flex-wrap gap-2">
        <Button aria-label={`${zh ? '已核实' : 'Verified'}：${item.label}`} disabled={disposition.isPending} onClick={() => disposition.mutate({ label: item.label, status: 'verified' })} size="sm" type="button" variant="outline">{zh ? '已核实' : 'Verified'}</Button>
        <Button aria-label={`${zh ? '忽略' : 'Dismiss'}：${item.label}`} disabled={disposition.isPending} onClick={() => disposition.mutate({ label: item.label, status: 'dismissed' })} size="sm" type="button" variant="ghost">{zh ? '忽略' : 'Dismiss'}</Button>
      </div>
    </article>)}</section> : null}
    {dispositions.length > 0 ? <details aria-label={zh ? '已处理思路' : 'Processed considerations'} className="min-w-0">
      <summary className="cursor-pointer text-xs text-muted-foreground">{zh ? `已处理思路（${dispositions.length}）` : `Processed considerations (${dispositions.length})`}</summary>
      <ul className="flex list-inside list-disc flex-col gap-1 pt-1">{dispositions.map(entry => <li className="flex min-w-0 flex-wrap items-center gap-2" key={entry.labelKey}>
        <span className="break-words">{entry.label}</span>
        <Badge variant="outline">{entry.status === 'verified' ? zh ? '已核实' : 'Verified' : zh ? '已忽略' : 'Dismissed'}</Badge>
        <Button aria-label={`${zh ? '撤销' : 'Undo'}：${entry.label}`} disabled={disposition.isPending} onClick={() => disposition.mutate({ label: entry.label, status: 'clear' })} size="sm" type="button" variant="ghost">{zh ? '撤销' : 'Undo'}</Button>
      </li>)}</ul>
    </details> : null}
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

export function DoctorRecommendationsPanel({ caseId, kind, enabled, inputRevision, scope, locale = 'zh-CN', unavailableReason, manualUnavailableReason, manualItems: suppliedManualItems = [], manualControls, itemDetails, investigationServiceFor, issuedCatalogItemIds, onManualChange, onManualRemove, onConfirmed, encounter, resolveExistingDraft = false, expectedDraftVersion, disabled = false }: {
  caseId: string; kind: DoctorRecommendationKind; enabled: boolean; inputRevision?: string | undefined; scope?: string | undefined; locale?: WorkspaceLocale | undefined
  disabled?: boolean | undefined
  manualItems?: ManualPreparedItem[] | undefined
  itemDetails?: ((value: PreparationDraft) => ReactNode) | undefined
  investigationServiceFor?: ((value: PreparationDraft, state: DoctorRecommendationState | undefined) => DoctorReviewedInvestigationService | undefined) | undefined
  manualControls?: ReactNode
  issuedCatalogItemIds?: ReadonlySet<string>
  onManualChange?: ((item: ManualPreparedItem) => boolean | void) | undefined
  onManualRemove?: ((value: PreparationDraft) => void) | undefined
  encounter?: { id: string; versionId: string } | undefined
  resolveExistingDraft?: boolean | undefined
  manualUnavailableReason?: ((value: PreparationDraft, state: DoctorRecommendationState | undefined) => string | undefined) | undefined
  onConfirmed?: ((values: PreparationDraft[], result: Awaited<ReturnType<typeof confirmDoctorPreparation>>) => void) | undefined
  expectedDraftVersion?: number | undefined
  unavailableReason?: ((suggestion: DoctorRecommendationSuggestion, state: DoctorRecommendationState | undefined) => string | undefined) | undefined
}) {
  const preparation = useDoctorPreparation(), client = useQueryClient(), zh = locale === 'zh-CN'
  const dismissDraftItem = useDoctorDraftItemEdit()
  const draftItemId = (value: PreparationDraft) => value.kind === 'imaging' || value.kind === 'pathology' ? value.serviceId : value.catalogItemId
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
  const [editing, setEditing] = useState<{ key: string; label: string; value: PreparationDraft; sourceValue: string; fingerprint: string; view: number; fields?: Record<string, string> }>()
  const [editError, setEditError] = useState(false)
  const [editDirty, setEditDirty] = useState(false)
  const [editSwitchBlocked, setEditSwitchBlocked] = useState(false)
  const orderDetails = useOrderDetails()
  const requestKeys = useRef(new Map<string, string>())
  const state = job.state, visible = state?.hidePreviousResults ? state : state === undefined || state.status === 'pending' || state.status === 'failed' ? job.previous : state
  const reviewedServices = useRef<Record<string, DoctorReviewedInvestigationService>>({})
  const bindReview = (value: PreparationDraft): PreparationDraft => {
    if (value.kind === 'diagnosis' || value.kind === 'prescription') return value
    const key = JSON.stringify([scope, caseId, identity(value)])
    const reviewedService = value.reviewedService ?? reviewedServices.current[key] ?? investigationServiceFor?.(value, visible)
    if (reviewedService === undefined) return value
    reviewedServices.current[key] = reviewedService
    return { ...value, reviewedService }
  }
  const preparedSelection = (item: DoctorRecommendationSuggestion) => bindReview(selection(item))
  const manualItems = suppliedManualItems.map(row => ({ ...row, value: bindReview(row.value) }))
  const priceReviewChanged = (value: PreparationDraft) => investigationServiceFor !== undefined && value.kind !== 'diagnosis' && value.kind !== 'prescription'
    && serviceReviewSignature(value.reviewedService) !== serviceReviewSignature(investigationServiceFor(value, visible))
  const manualIdentity = JSON.stringify(manualItems)
  const manualOwnership = useRef({ identity: manualIdentity, token: 0 })
  if (manualOwnership.current.identity !== manualIdentity) manualOwnership.current = { identity: manualIdentity, token: manualOwnership.current.token + 1 }
  const manualRowOwners = useRef<Record<string, { identity: string; token: number }>>({})
  manualRowOwners.current = Object.fromEntries(manualItems.map(row => {
    const key = identity(row.value), rowIdentity = JSON.stringify(row), previous = manualRowOwners.current[key]
    return [key, previous?.identity === rowIdentity ? previous : { identity: rowIdentity, token: manualOwnership.current.token }]
  }))
  const manualKeys = new Set(manualItems.map(row => identity(row.value)))
  const recordIdentity = JSON.stringify([scope, caseId, kind])
  const restoredForm = useRef<string | undefined>(undefined)
  const restoringForm = restoredForm.current !== recordIdentity
  const conflicts = new Set(manualItems.filter(row => {
    const proposed = visible?.items.find(item => identity(item) === identity(row.value))
    return proposed !== undefined && clinicalValue(row.value) !== clinicalValue(preparedSelection(proposed))
  }).map(row => identity(row.value)))
  const baseRows: PreparedRow[] = [
    ...manualItems.map(row => ({ ...row, key: identity(row.value), signature: JSON.stringify([state?.inputFingerprint, clinicalValue(row.value), manualOwnership.current.token]) })),
    ...(visible?.items ?? []).filter(item => !manualKeys.has(identity(item))).map(item => ({ key: identity(item), label: item.label,
      item, value: preparedSelection(item), signature: evidenceSignature(visible!, item) })),
  ]
  const deletedFormEdits = Object.entries(preferences.edits).filter(([key, edit]) => !restoringForm && edit.formOwned && !manualKeys.has(key))
  const changedFormItems = restoringForm || onManualChange === undefined ? [] : manualItems.filter(item => {
    const key = identity(item.value), edit = preferences.edits[key], row = baseRows.find(row => row.key === key)
    return !preferences.completed[key]?.includes(row!.signature)
      && (!edit?.formOwned || edit.label !== item.label || JSON.stringify(edit.selection) !== JSON.stringify(item.value))
  })
  useEffect(() => {
    if (deletedFormEdits.length === 0 && changedFormItems.length === 0) return
    update(previous => {
      const edits = { ...previous.edits }, removed = { ...previous.removed }
      for (const [key, edit] of deletedFormEdits) {
        if (edits[key] !== edit) continue
        delete edits[key]
        const automatic = baseRows.find(row => row.key === key && row.item !== undefined)
        if (automatic !== undefined) removed[key] = removalSignature(automatic)
      }
      for (const item of changedFormItems) {
        const key = identity(item.value)
        edits[key] = { ...edits[key], label: item.label, selection: item.value,
          fingerprint: edits[key]?.fingerprint ?? state?.inputFingerprint ?? '', formOwned: true }
      }
      return { ...previous, edits, removed }
    })
  })
  const alreadyIssued = (item: PreparationDraft | DoctorRecommendationSuggestion) => item.kind === 'prescription' && issuedCatalogItemIds?.has(item.catalogItemId) === true
  const rows: Array<PreparedRow & { owner: DraftPreferences['edits'][string] | undefined }> = baseRows.filter(row => !alreadyIssued(row.value) && !deletedFormEdits.some(([key]) => key === row.key) && preferences.removed[row.key] !== removalSignature(row) && !preferences.completed[row.key]?.includes(row.signature))
    .map(row => ({ ...row, value: onManualChange !== undefined && manualKeys.has(row.key) && !(restoringForm && preferences.edits[row.key]?.formOwned) ? row.value : preferences.edits[row.key]?.selection ?? row.value, owner: preferences.edits[row.key] }))
  for (const [key, edit] of Object.entries(preferences.edits)) if (!alreadyIssued(edit.selection) && !deletedFormEdits.some(([deleted]) => deleted === key) && !rows.some(row => row.key === key) && preferences.removed[key] === undefined) {
    rows.push({ key, label: edit.label, value: edit.selection, signature: edit.fingerprint, owner: edit })
  }
  const recordView = useRef({ identity: recordIdentity, token: 0 })
  if (recordView.current.identity !== recordIdentity) recordView.current = { identity: recordIdentity, token: recordView.current.token + 1 }
  const navigationIdentity = JSON.stringify([scope, caseId, kind, enabled])
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
  type Submission = { state: Parameters<typeof confirmDoctorPreparation>[0]; selections: DoctorPreparationSelection[]; view: number; recordView: number; navigation: number; rows: typeof rows; draftVersion: number; resolveExistingDraft: boolean; submissionKey: string; token: string; scope: string | undefined; manualOwnership: number; manualItems: ManualPreparedItem[]; manualRowOwners: typeof manualRowOwners.current }
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
    onError: async (error, request) => {
      if (!(error instanceof ApiClientError) || error.code !== 'CATALOG_CONFLICT') return
      await Promise.all([
        client.invalidateQueries({ queryKey: ['doctor-recommendations', request.scope, request.state.caseId, request.state.kind] }),
        client.invalidateQueries({ predicate: query => query.queryKey[0] === `doctor-case-${request.state.kind}-services`
          && query.queryKey[1] === request.state.caseId || request.state.kind === 'laboratory' && query.queryKey[0] === 'reference-catalog'
          && query.queryKey.includes('laboratory') && query.queryKey.includes(request.state.caseId) }),
      ])
    },
    onSuccess: async (result, request) => {
      const ownsRecord = mounted.current && recordView.current.token === request.recordView
      const unchanged = ownsRecord ? request.rows.filter(row => {
        const current = currentRows.current.find(current => current.key === row.key)
        if (current === undefined || currentEdits.current[row.key] !== row.owner || clinicalValue(current.value) !== clinicalValue(row.value)) return false
        const manualOwner = request.manualRowOwners[row.key]
        return manualOwner === undefined ? current.item === row.item : manualRowOwners.current[row.key] === manualOwner
      }) : []
      if (unchanged.length === request.rows.length) synchronization.current.set(request.token, 'owned')
      if (unchanged.length > 0) update(previous => {
        return { ...previous, completed: { ...previous.completed, ...Object.fromEntries(unchanged.map(row => {
          const current = currentRows.current.find(current => current.key === row.key)
          const automatic = visible?.items.find(item => identity(item) === row.key)
          return [row.key, [row.signature, ...current === undefined ? [] : [current.signature], ...automatic === undefined ? [] : [evidenceSignature(visible!, automatic)]]]
        })) },
          edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => !unchanged.some(row => row.key === key))) }
      })
      if (ownsRecord) onConfirmed?.(unchanged.map(row => row.value), result)
      await synchronize(result, request)
    },
  })
  const automaticReady = state?.status === 'ready' && !state.stale && !job.pending && job.error === null && !job.paused
  const available = rows.filter(row => complete(row.value) && !preferences.unselected.includes(row.key) && preferences.removed[row.key] === undefined
    && (row.value.source === 'manual' || automaticReady))
  const needsReview = (key: string) => {
    if (rows.some(row => row.key === key && priceReviewChanged(row.value))) return true
    if (preferences.removed[key] !== undefined) return true
    const edit = preferences.edits[key]
    return state !== undefined && edit?.reviewedFingerprint !== state.inputFingerprint
      && (conflicts.has(key) || edit !== undefined && edit.fingerprint !== state.inputFingerprint)
  }
  const submitting = submission.isPending && submission.variables?.view === view || preparation?.submitting(kind) === true
  useEffect(() => {
    if (!restoringForm || disabled || submitting) return
    restoredForm.current = recordIdentity
    for (const [key, edit] of Object.entries(preferences.edits)) {
      if (!edit.formOwned) continue
      if (onManualChange?.({ label: edit.label, value: edit.selection }) !== true) {
        update(previous => ({ ...previous, edits: { ...previous.edits, [key]: { ...edit, formOwned: false } } }))
      }
    }
  })
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
    : available.map(row => row.value.source === 'manual' ? manualUnavailableReason?.(row.value, visible) : row.item === undefined ? undefined : unavailableReason?.(row.item, visible)).find(reason => reason !== undefined)
  const submissionError = submission.isError && submission.variables?.view === view ? submission.error : null
  const submissionMessage = submissionError === null ? null : kind === 'prescription' && submissionError instanceof ApiClientError
    && (submissionError.code === 'CATALOG_CONFLICT' || submissionError.code === 'WORKFLOW_CONFLICT')
    ? getWorkspaceMessages(locale).prescriptionIssueConflictDescription : getWorkspaceErrorMessage(submissionError, getWorkspaceMessages(locale))
  const failed = !completedIntent && (job.error !== null || state?.status === 'failed' || submissionError !== null)
  const inlineEditing = orderDetails?.hasRecords === true
  const pendingDetailVisible = inlineEditing && orderDetails.pendingVisible && activeEditing !== undefined
  const editingRow = rows.find(row => row.key === activeEditing?.key)
  const editingAvailable = editingRow !== undefined
  const manualEditingChanged = inlineEditing && editDirty && editingRow !== undefined && manualKeys.has(editingRow.key)
    && activeEditing?.sourceValue !== JSON.stringify(editingRow.value)
  useEffect(() => {
    if (!inlineEditing || editDirty || activeEditing === undefined || editingRow === undefined) return
    if (activeEditing.sourceValue === JSON.stringify(editingRow.value) && activeEditing.fingerprint === (state?.inputFingerprint ?? '')) return
    const next = { key: editingRow.key, label: editingRow.label,
      value: activeEditing.sourceValue === JSON.stringify(editingRow.value) ? activeEditing.value : { ...editingRow.value },
      sourceValue: JSON.stringify(editingRow.value), fingerprint: state?.inputFingerprint ?? '', view: navigation.current.token }
    if (JSON.stringify(activeEditing) !== JSON.stringify(next)) setEditing(next)
  }, [activeEditing, editDirty, editingRow, inlineEditing, state?.inputFingerprint])
  useEffect(() => {
    if (!enabled || !editingAvailable) {
      orderDetails?.setPendingVisible(false)
      setEditDirty(false)
    }
  }, [enabled, editingAvailable, orderDetails?.setPendingVisible])
  const openEditor = (row: typeof rows[number]) => {
    if (inlineEditing && editDirty && activeEditing !== undefined && activeEditing.key !== row.key) {
      setEditSwitchBlocked(true)
      orderDetails.setPendingVisible(true)
      return
    }
    setEditSwitchBlocked(false)
    if (!inlineEditing || !editDirty || activeEditing?.key !== row.key) {
      const currentService = investigationServiceFor?.(row.value, visible)
      const value = row.value.kind !== 'diagnosis' && row.value.kind !== 'prescription' && currentService !== undefined
        ? { ...row.value, reviewedService: currentService } : { ...row.value }
      setEditing({ key: row.key, label: row.label, value, sourceValue: JSON.stringify(row.value), fingerprint: state?.inputFingerprint ?? '', view: navigation.current.token })
      setEditDirty(false)
      setEditError(false)
    }
    if (inlineEditing) orderDetails.setPendingVisible(true)
  }
  const changeEditingField = (field: string, value: string) => {
    setEditDirty(true)
    setEditing(previous => previous === undefined ? undefined : { ...previous, fields: { ...previous.fields, [field]: value } })
  }
  const editingFields: Array<[string, string]> = activeEditing?.value.kind === 'prescription' ? [['doseText', zh ? '每次剂量' : 'Dose'], ['frequencyCode', zh ? '频次' : 'Frequency'], ['courseDays', zh ? '疗程（天）' : 'Days'], ['quantity', zh ? '数量' : 'Quantity']]
          : activeEditing?.value.kind === 'laboratory' ? [['indicationCode', zh ? '检查目的' : 'Indication']]
          : activeEditing?.value.kind === 'imaging' ? [['indication', zh ? '检查目的' : 'Indication']]
          : activeEditing?.value.kind === 'pathology' ? [['purpose', zh ? '会诊目的' : 'Purpose']] : []
  const adjustmentForm = (activeEditing === undefined ? null : <DoctorDraftEditorScope id={activeEditing.value.source === 'manual' ? draftItemId(activeEditing.value) : undefined} open>{commit => <form key={activeEditing.key} onSubmit={event => {
        event.preventDefault();if (activeEditing.view !== navigation.current.token || disabled || submitting) return;const values = new FormData(event.currentTarget), { suggestionId: _id, ...base } = activeEditing.value
        const candidate = { ...base, source: 'manual', ...Object.fromEntries(values) }
        if ('courseDays' in candidate) candidate.courseDays = Number(values.get('courseDays'))
        if ('quantity' in candidate) candidate.quantity = Number(values.get('quantity'))
        if ('note' in candidate && typeof candidate.note === 'string' && candidate.note.trim() === '') delete candidate.note
        const result = doctorPreparationSelectionSchema.safeParse(candidate)
        if (!result.success || !complete(result.data)) { setEditError(true);return }
        commit()
        dismissDraftItem(draftItemId(result.data))
        const formOwned = onManualChange?.({ label: activeEditing.label, value: result.data }) === true || manualKeys.has(activeEditing.key)
        update(previous => {
          const { [activeEditing.key]: _removed, ...removed } = previous.removed
          return { ...previous, removed, edits: { ...previous.edits, [activeEditing.key]: { label: activeEditing.label, selection: result.data, fingerprint: activeEditing.fingerprint, reviewedFingerprint: activeEditing.fingerprint, formOwned } }, unselected: previous.unselected.filter(key => key !== activeEditing.key) }
        })
        setEditDirty(false)
        setEditSwitchBlocked(false)
        if (inlineEditing) setEditing(previous => previous === undefined ? undefined : { ...previous, value: result.data })
        else setEditing(undefined)
      }}><FieldGroup className="max-h-[55svh] overflow-y-auto px-4 py-3">
        {itemDetails?.(activeEditing.value)}
        {manualEditingChanged ? <p className="text-sm">{zh ? '左侧填写已更新，当前调整已保留，请核对后再保留。' : 'The manual fields changed. Your pending edits are preserved; review them before keeping them.'}</p> : null}
        {needsReview(activeEditing.key) ? <p className="text-sm">{zh ? '新资料已到达，请核对后决定保留、修改或移除。' : 'New information arrived. Review this item before keeping it.'}</p> : null}
        {activeEditing.value.kind === 'diagnosis' ? <Field><FieldLabel>{zh ? '诊断类别' : 'Diagnosis role'}</FieldLabel><ToggleGroup value={activeEditing.value.role === null ? [] : [activeEditing.value.role]} onValueChange={values => { setEditDirty(true);const role = values[0];if (role === 'primary' || role === 'secondary') setEditing(previous => previous?.value.kind === 'diagnosis' ? { ...previous, value: { ...previous.value, role } } : previous) }}><ToggleGroupItem value="primary">{zh ? '主诊断' : 'Primary'}</ToggleGroupItem><ToggleGroupItem value="secondary">{zh ? '次诊断' : 'Secondary'}</ToggleGroupItem></ToggleGroup></Field> : null}
        {activeEditing.value.kind === 'diagnosis' ? <Field><FieldLabel htmlFor="prepared-note">{zh ? '备注' : 'Note'}</FieldLabel><Textarea value={activeEditing.fields?.note ?? activeEditing.value.note ?? ''} onChange={event => changeEditingField('note', event.currentTarget.value)} id="prepared-note" maxLength={500} name="note" /></Field> : null}
        {editingFields.map(([field, label]) => {
            const value = field === 'doseText' && activeEditing.value.kind === 'prescription' ? activeEditing.value.doseText : field === 'frequencyCode' && activeEditing.value.kind === 'prescription' ? activeEditing.value.frequencyCode : field === 'courseDays' && activeEditing.value.kind === 'prescription' ? activeEditing.value.courseDays : field === 'quantity' && activeEditing.value.kind === 'prescription' ? activeEditing.value.quantity : field === 'indicationCode' && activeEditing.value.kind === 'laboratory' ? activeEditing.value.indicationCode : field === 'indication' && activeEditing.value.kind === 'imaging' ? activeEditing.value.indication : activeEditing.value.kind === 'pathology' ? activeEditing.value.purpose : ''
            return <Field key={field}><FieldLabel htmlFor={`prepared-${field}`}>{label}</FieldLabel>{field === 'frequencyCode' && activeEditing.value.kind === 'prescription'
              ? <WorkspaceSelect id={`prepared-${field}`} value={activeEditing.value.frequencyCode} placeholder={zh ? '请选择频次' : 'Choose frequency'} items={[...new Set(['QD', 'BID', 'PRN', ...activeEditing.value.frequencyCode ? [activeEditing.value.frequencyCode] : []])].map(code => ({ value: code, label: frequencyLabel(code, zh) }))}
                onValueChange={code => { setEditDirty(true);setEditing(previous => previous?.value.kind === 'prescription' ? { ...previous, value: { ...previous.value, frequencyCode: code } } : previous) }} />
              : field === 'indicationCode' && activeEditing.value.kind === 'laboratory'
                ? <WorkspaceSelect id={`prepared-${field}`} value={activeEditing.value.indicationCode} items={[...new Set(['clinical-evaluation', 'fever', activeEditing.value.indicationCode])].map(code => ({ value: code, label: indicationLabel(code, zh) }))}
                  onValueChange={code => { setEditDirty(true);if (code !== null) setEditing(previous => previous?.value.kind === 'laboratory' ? { ...previous, value: { ...previous.value, indicationCode: code } } : previous) }} />
                : <Input value={activeEditing.fields?.[field] ?? value ?? ''} onChange={event => changeEditingField(field, event.currentTarget.value)} id={`prepared-${field}`} min={1} name={field} required type={field === 'quantity' || field === 'courseDays' ? 'number' : 'text'} />}</Field>
          })}
        {editError ? <p role="alert">{zh ? '请补齐有效的项目信息。' : 'Complete the item with valid values.'}</p> : null}
        {editSwitchBlocked ? <p role="alert">{zh ? '请先保留当前调整，再查看其他待开具项目。' : 'Keep the current edits before opening another pending item.'}</p> : null}
      </FieldGroup><DialogFooter><Button disabled={disabled || submitting} type="submit">{zh ? '保留本次调整' : 'Keep edits'}</Button></DialogFooter></form>}</DoctorDraftEditorScope>)
  const confirmationControls = (<CardFooter className="flex flex-wrap items-center justify-between gap-3">{inlineEditing && editDirty ? <p className="text-xs text-muted-foreground">{zh ? '有未保存调整，请保留后再开具。' : 'Keep the pending edits before confirming.'}</p> : null}<p className="text-xs text-muted-foreground">{zh ? `已选 ${available.length} 项` : `${available.length} selected`}</p><Button disabled={inlineEditing && editDirty || !canConfirm || available.length === 0 || block !== undefined || available.some(row => needsReview(row.key) && (priceReviewChanged(row.value) || !(currentEncounter !== undefined && row.value.source === 'manual')))} onClick={() => { if (confirmationContext !== undefined) submission.mutate({ state: confirmationContext, selections: available.map(row => doctorPreparationSelectionSchema.parse(row.value)), view, recordView: recordView.current.token, navigation: navigation.current.token, rows: available, draftVersion, resolveExistingDraft, submissionKey, token: newIdempotencyKey(), scope, manualOwnership: manualOwnership.current.token, manualItems, manualRowOwners: manualRowOwners.current }) }} type="button">{kind === 'diagnosis' ? zh ? '确认选中诊断' : 'Confirm selected diagnoses' : kind === 'prescription' ? zh ? '开具处方' : 'Issue prescription' : zh ? '开具选中项目' : 'Issue selected orders'}（{available.length}）</Button></CardFooter>)
  if (!enabled) return null
  // 工具按钮收纳为紧凑图标动作：窄侧栏不再把三枚文字按钮折成多行，语义名经 aria-label 与悬停提示保留。
  const toolLabels = {
    refresh: refreshRecords ? (zh ? '刷新记录' : 'Refresh records') : state?.status === 'failed' ? (zh ? '重新生成' : 'Regenerate') : (zh ? '刷新' : 'Refresh'),
    pause: job.paused ? (zh ? '恢复自动准备' : 'Resume') : (zh ? '暂停自动准备' : 'Pause'),
    details: zh ? '依据与说明' : 'Evidence and details',
  }
  return <>
    <Card aria-label={doctorRecommendationKindTitles[kind][zh ? 0 : 1]} role="region" size="sm" className="min-w-0" data-agent-phase={job.pending ? 'working' : 'ready'}>
      <CardHeader className="flex flex-col gap-2"><CardTitle>{doctorRecommendationKindTitles[kind][zh ? 0 : 1]}</CardTitle><CardAction className="self-stretch"><div className="flex flex-wrap gap-1">
        {manualControls}
        {state?.recovery?.canContinue ? <Button disabled={pending || job.paused || state.stale} onClick={job.continueOriginal} size="sm" type="button" variant="outline">{zh ? '继续原任务' : 'Continue original task'}</Button> : null}
        <Button aria-label={toolLabels.refresh} disabled={refreshRecords ? false : pending || job.paused || state === undefined} onClick={() => {
          if (refreshRecords) { void synchronize(submission.data, submission.variables);return }
          if (!succeeded) submission.reset()
          job.refresh()
        }} size="icon-sm" title={toolLabels.refresh} type="button" variant="ghost"><RefreshCwIcon /></Button>
        {preparation === undefined ? null : <Button aria-label={toolLabels.pause} onClick={preparation.togglePaused} size="icon-sm" title={toolLabels.pause} type="button" variant="ghost">{job.paused ? <PlayIcon /> : <PauseIcon />}</Button>}
        <Button aria-label={toolLabels.details} onClick={() => preparation === undefined ? setLocalDetails(true) : preparation.openDetails(kind)} size="icon-sm" title={toolLabels.details} type="button" variant="outline"><BookOpenIcon /></Button>
      </div></CardAction></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-medium" role="status">{completedIntent ? zh ? `已完成${kind === 'diagnosis' ? '确认' : '开具'}，${recordsUpdated ? '记录已更新。' : '记录暂未刷新，请刷新查看。'}` : recordsUpdated ? 'Confirmed; records are up to date.' : 'Confirmed; refresh the records to see the result.' : job.paused ? zh ? '自动准备已暂停' : 'Preparation paused' : pending ? zh ? '正在按最新资料更新，旧自动项目暂不可开具。' : 'Updating; previous automatic items cannot be submitted yet.'
          : recoveryMessage(state, zh) !== undefined ? recoveryMessage(state, zh)
          : failed ? zh ? '更新或提交未完成，草稿已保留。' : 'Update or submission failed. Your draft is preserved.'
          : state?.stale ? zh ? '资料有变化，等待重新核对。' : 'Information changed; another check is needed.'
          : state?.status === 'ready' && job.ready ? rows.length === 0
            ? state.considerations?.length ? zh ? '本轮仅有待核实思路，见“依据与说明”。' : 'Only considerations are available; see the details.'
              : zh ? '暂无待开具项目。' : 'No pending items.'
            : zh ? '待医生确认。' : 'Awaiting confirmation.'
          : state?.status === 'missing-evidence' ? zh ? '暂无可直接开具的项目，可查看说明。' : 'No executable items; see the details.'
          : zh ? '尚未完成核对。' : 'Checks are not complete.'}</p>
        {submissionError === null ? null : <Alert variant="destructive"><AlertDescription>{submissionMessage}</AlertDescription></Alert>}
        {rows.length === 0 ? <p className="text-xs text-muted-foreground">{zh ? '暂无可直接确认或开具的项目。' : 'No items are ready to confirm or issue.'}</p> : <div className="flex flex-col divide-y">
          {rows.map(row => <DoctorDraftItem key={row.key} id={draftItemId(row.value)} enabled={row.value.source === 'manual'}><div className="flex min-w-0 flex-wrap items-start gap-2 py-3 pr-14">
            <Checkbox aria-label={`${zh ? '选择' : 'Select '}${row.label}`} checked={!preferences.unselected.includes(row.key) && preferences.removed[row.key] === undefined && complete(row.value)} disabled={!complete(row.value)} onCheckedChange={checked => update(previous => {
              const { [row.key]: _removed, ...removed } = previous.removed
              return { ...previous, removed: checked ? removed : previous.removed, unselected: checked ? previous.unselected.filter(key => key !== row.key) : [...previous.unselected.filter(key => key !== row.key), row.key] }
            })} />
            <div className="min-w-0 basis-[calc(100%-1.75rem)] flex-1">{inlineEditing ? <Button aria-label={`${zh ? '查看待开具' : 'View pending'} ${row.label}`} className="h-auto max-w-full justify-start whitespace-normal p-0 text-left font-medium" onClick={() => openEditor(row)} type="button" variant="ghost">{row.label}</Button> : <p className="break-words font-medium">{row.label}</p>}<p className="break-words text-xs text-muted-foreground">{summary(row.value, zh)}</p>{itemDetails?.(row.value)}{preferences.removed[row.key] !== undefined ? <p className="text-xs text-muted-foreground">{zh ? '已移除项目的依据或方案有变化，请核对。' : 'The evidence or plan for this removed item changed. Review it.'}</p> : conflicts.has(row.key) && needsReview(row.key) ? <p className="text-xs text-muted-foreground">{zh ? '新建议与医生填写内容不同，请核对。' : 'The new suggestion differs from your entry. Review this item.'}</p> : null}</div>
            <Badge variant="secondary">{needsReview(row.key) ? zh ? '请核对新资料' : 'Review new information' : !complete(row.value) ? zh ? '待补充' : 'Incomplete' : row.value.source === 'manual' ? zh ? '已填写' : 'Entered' : !automaticReady ? zh ? '待更新' : 'Updating' : zh ? '待确认' : 'Ready'}</Badge>
            <Button onClick={() => openEditor(row)} size="sm" type="button" variant="ghost">{needsReview(row.key) ? zh ? '核对' : 'Review' : zh ? '调整' : 'Edit'}</Button>
            <Button aria-label={`${zh ? '移除' : 'Remove '}${row.label}`} disabled={submission.isPending} onClick={() => {
              if (row.value.source === 'manual' && manualKeys.has(row.key) && onManualRemove !== undefined) {
                onManualRemove(row.value)
                const automatic = visible?.items.find(item => identity(item) === row.key)
                update(previous => ({ ...previous,
                  removed: automatic === undefined ? previous.removed : { ...previous.removed, [row.key]: removalSignature({ key: row.key, label: automatic.label, value: preparedSelection(automatic), item: automatic, signature: evidenceSignature(visible!, automatic) }) },
                  edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== row.key)),
                }))
                return
              }
              update(previous => ({ ...previous, removed: { ...previous.removed, [row.key]: removalSignature(baseRows.find(base => base.key === row.key) ?? row) }, edits: Object.fromEntries(Object.entries(previous.edits).filter(([key]) => key !== row.key)) }))
            }} size="icon-sm" type="button" variant="ghost"><Trash2Icon /></Button>
          </div></DoctorDraftItem>)}
        </div>}
        {!rolesValid && available.length > 0 ? <p className="text-xs text-muted-foreground">{zh ? '请核对主次诊断，保留一条主诊断。' : 'Review the diagnosis roles and keep one primary diagnosis.'}</p> : null}
        {block === undefined ? null : <p className="text-xs text-muted-foreground">{block}</p>}
      </CardContent>
      {pendingDetailVisible ? null : confirmationControls}
    </Card>
    {preparation === undefined ? <DoctorPreparationDetailsDialog open={localDetails} onOpenChange={setLocalDetails} title={zh ? '依据与说明' : 'Evidence and details'}><DoctorRecommendationDetails job={job} locale={locale} /></DoctorPreparationDetailsDialog> : null}
    {inlineEditing ? orderDetails.host === null || activeEditing === undefined ? null : createPortal(
      <section aria-label={zh ? '待开具项目详情' : 'Pending item details'} className="flex min-w-0 flex-col gap-4 rounded-lg border p-4">
        <h4 className="font-semibold">{activeEditing.label}</h4>
        {itemDetails?.(activeEditing.value)}
        {adjustmentForm}
        <p className="text-xs text-muted-foreground">{zh ? '确认或开具作用于左侧已勾选项目；有修改时请先保留调整。' : 'Confirmation applies to the selected items on the left. Keep edits before confirming.'}</p>
        {pendingDetailVisible ? confirmationControls : null}
      </section>, orderDetails.host,
    ) : <Dialog open={activeEditing !== undefined} onOpenChange={open => { if (!open) setEditing(undefined) }}><DialogContent><DialogHeader><DialogTitle>{zh ? '调整项目' : 'Edit item'}</DialogTitle><DialogDescription>{activeEditing?.label}</DialogDescription></DialogHeader>
      {adjustmentForm}
    </DialogContent></Dialog>}
  </>
}
