import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientAngiographyReportsSchema, type inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import { pciSelectionProcedureCodes, inpatientPciSelectionSchema, inpatientPciSelectionSaveInputSchema, inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimateSaveInputSchema,
  type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import { InpatientMaterialPlanBasisDetails } from './inpatient-material-plan.tsx'
import { InpatientPciDraftFields, type PciSelectionDraft } from './inpatient-pci-draft-fields.tsx'
import { InpatientPciCosts } from './inpatient-pci-costs.tsx'
import { AgentDraftField, WorkspaceActionBar, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>;
  requests?: z.infer<typeof inpatientSurgeryRequestSchema>[]; inProgressRequestIds?: string[]; active?: boolean }
type DraftItems = z.infer<typeof inpatientMaterialEstimateSaveInputSchema>['items']
type Editing = { items: Array<Omit<DraftItems[number], 'quantity'> & { quantity: string }>; note: string;
  analysisId: string | null; revision: number; basisFingerprint: string }
type PciReport = z.infer<typeof inpatientAngiographyReportSchema>
function reviewSources(estimate: InpatientMaterialEstimate, pciDraft: PciSelectionDraft | undefined, report: PciReport | undefined,
  reservationFingerprint: string | undefined, encounterVersion: string | undefined) {
  return JSON.stringify([estimate.version, estimate.requestVersion, estimate.status, estimate.candidates, estimate.analysis,
    estimate.costs, pciDraft, report, reservationFingerprint, encounterVersion])
}
const statusLabels = {
  incomplete: ['预计依据不完整，请核对缺项', 'Sources are incomplete; review missing facts'],
  queued: ['已保存计划，等待 AI 预计', 'Plan saved; waiting for AI estimate'],
  running: ['AI 正在准备预计清单', 'AI is preparing the estimate'],
  succeeded: ['AI 预计与独立核验已完成', 'AI estimate and independent verification completed'],
  stale: ['依据已变化，请更新预计', 'Sources changed; update the estimate'],
  blocked: ['AI 预计受阻，可核对院内方案', 'AI estimate blocked; hospital plan remains available'],
  unknown: ['原AI请求结果未知，请先核查原尝试', 'Original model outcome unknown; reconcile the original attempt'],
  failed: ['AI 预计失败，可核对院内方案', 'AI estimate failed; hospital plan remains available'],
  cancelled: ['本次预计已取消', 'This estimate was cancelled'],
} as const

export function InpatientMaterialEstimates({ admission, session, locale, write, requests, inProgressRequestIds = [], active = true }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = [...inpatientScopeKey(session), admission.id]
  const writeContext = JSON.stringify([active, session.user.id, session.actor, admission.id, admission.status, admission.recordStatus,
    requests?.map(request => [request.id, request.version, request.status]), inProgressRequestIds])
  const latestContext = useRef({ value: writeContext, version: 0 })
  if (latestContext.current.value !== writeContext) latestContext.current = { value: writeContext, version: latestContext.current.version + 1 }
  const contextVersion = latestContext.current.version
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const isCurrent = () => alive.current && active && latestContext.current.version === contextVersion
  const query = useQuery({ queryKey: [...scope, 'material-estimates'], retry: false, enabled: active,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal),
    refetchInterval: active && admission.status === 'admitted' && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const reservations = useQuery({ queryKey: [...scope, 'drg-reservations'], retry: false, enabled: active,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const hasPciPlan = requests?.some(request => pciSelectionProcedureCodes.includes(request.plannedProcedure.coding.code)) ?? false
  const selection = useQuery({ queryKey: [...scope, 'pci-selection'], retry: false, enabled: active && hasPciPlan,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal),
    refetchInterval: active && admission.status === 'admitted' && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const reports = useQuery({ queryKey: [...scope, 'angiography-reports'], retry: false, enabled: active && hasPciPlan,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/angiography-reports`, inpatientAngiographyReportsSchema, signal),
    refetchInterval: active && admission.status === 'admitted' && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const editable = active && session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const command = write.pending?.command ?? write.mutation.variables
  const error = query.error ?? reservations.error ?? selection.error ?? reports.error ?? ((command?.operation.startsWith('inpatient.material-estimate.') || command?.operation === 'inpatient.pci-selection.save')
    && 'admissionId' in command.input && command.input.admissionId === admission.id ? write.mutation.error : null)
  return <section aria-label={t('手术耗材预计', 'Surgery material estimates')} className="flex flex-col gap-3">
    <h4 className="font-medium">{t('手术耗材预计', 'Surgery material estimates')}</h4>
    <p>{t('保存冠脉计划后自动预计一次，无需开启持续跟进。耗材清单与有效预留分别保存；预留只用于费用预计，实际使用与正式费用另行记录。', 'A coronary plan triggers one estimate without continuous follow-up. Material lists and active reservations are saved separately. Reservations support estimate; actual use and charges are recorded separately.')}</p>
    {query.isPending ? <div role="status" aria-label={t('正在读取耗材预计', 'Loading material estimates')}><Skeleton className="h-16 w-full" /></div> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {query.data?.estimates.map(estimate => <EstimateEditor key={JSON.stringify([session.user.id, session.actor.actorId, ...scope, estimate.requestId])} estimate={estimate} admission={admission}
      title={requests?.find(request => request.id === estimate.requestId)?.plannedProcedure.coding.display ?? estimate.requestId}
      preoperative={!inProgressRequestIds.includes(estimate.requestId) && (requests === undefined || requests.some(request => request.id === estimate.requestId && ['requested', 'ready'].includes(request.status)))}
      reservations={reservations.data?.reservations ?? []} encounterVersion={reservations.data?.encounterVersion}
      pciDraft={selection.data?.drafts?.find(draft => draft.requestId === estimate.requestId)}
      reports={reports.data?.reports ?? []}
      reservationFingerprint={reservations.data?.reservationSets.find(set => set.requestId === estimate.requestId)?.fingerprint}
      locale={locale} session={session} write={write} editable={editable} active={active}
      readable={query.error === null}
      current={!query.isFetching && query.error === null && !reservations.isFetching && reservations.error === null
        && (!hasPciPlan || selection.isSuccess && reports.isSuccess && !selection.isFetching && !reports.isFetching)} />)}
    {query.data?.unprepared.map(plan => <article key={plan.requestId} className="flex flex-col gap-2 rounded-md border p-3">
      <p>{requests?.find(request => request.id === plan.requestId)?.plannedProcedure.coding.display ?? plan.requestId} · {t('历史计划尚未准备预计', 'Historical plan has no estimate')}</p>
      {editable ? <Button variant="outline" disabled={write.blocked || query.isFetching || query.error !== null} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.request', input: {
        admissionId: admission.id, requestId: plan.requestId, expectedRequestVersion: plan.requestVersion, expectedVersion: 0, expectedBasisFingerprint: plan.basisFingerprint,
      }, isCurrent })}>{t('为此计划准备一次预计', 'Prepare one estimate for this plan')}</Button> : null}
    </article>)}
    {query.data?.estimates.length === 0 && query.data.unprepared.length === 0 ? <p>{t('暂无需要预计的冠脉手术计划。', 'No coronary surgery plans require an estimate.')}</p> : null}
  </section>
}

function EstimateEditor({ estimate, admission, title, reservations, encounterVersion, reservationFingerprint, locale, session, write, editable, current, readable, preoperative, pciDraft, reports, active }: {
  estimate: InpatientMaterialEstimate; admission: InpatientAdmission; title: string; reservations: InpatientMaterialReservation[];
  encounterVersion: string | undefined; reservationFingerprint: string | undefined; locale: WorkspaceLocale; session: SessionContext; write: Props['write']; editable: boolean; current: boolean; preoperative: boolean;
  pciDraft: PciSelectionDraft | undefined; reports: z.infer<typeof inpatientAngiographyReportSchema>[]; active: boolean; readable: boolean;
}) {
  const client = useQueryClient()
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [editing, setEditing] = useState<Editing | null>(null)
  const [reviewed, setReviewed] = useState<string | null>(null)
  const [failedSave, setFailedSave] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [pciEditing, setPciEditing] = useState<PciSelectionDraft | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const writeContext = JSON.stringify([active, editable, preoperative, session.user.id, session.actor, admission.id, admission.status, admission.recordStatus])
  const visibility = useRef({ active, context: writeContext, version: 0 })
  if (visibility.current.context !== writeContext) visibility.current = { active, context: writeContext, version: visibility.current.version + 1 }
  const visibilityVersion = visibility.current.version
  useEffect(() => { if (!active) setReviewed(null) }, [active])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const isCurrent = () => alive.current && visibility.current.active && visibility.current.version === visibilityVersion
  const draft = estimate.draft
  const base: Editing = { items: (draft?.items ?? []).map(item => ({ ...item, quantity: String(item.quantity) })), note: draft?.note ?? '',
    analysisId: draft?.analysisId ?? null, revision: draft?.revision ?? 0, basisFingerprint: draft?.basisFingerprint ?? estimate.basisFingerprint }
  const value = editing ?? base
  const contentKey = JSON.stringify([value.items, value.note, value.analysisId, value.basisFingerprint])
  const inputKey = JSON.stringify([value.items, value.note])
  const latestInput = useRef(inputKey)
  latestInput.current = inputKey
  const latestEstimate = useRef(estimate)
  latestEstimate.current = estimate
  const update = (patch: Partial<Editing>) => { setReviewed(null); setEditing(previous => ({ ...(previous ?? base), ...patch })) }
  const candidates = estimate.candidates
  const eligible = candidates.filter(candidate => candidate.eligibility === 'valid' && candidate.item !== null)
  const activeReservations = reservations.filter(reservation => reservation.requestId === estimate.requestId && reservation.status === 'reserved')
  const fingerprintCurrent = value.basisFingerprint === estimate.basisFingerprint
  const analysisCurrent = value.analysisId === null || value.analysisId === estimate.analysis?.id
  const draftCurrent = value.revision === (draft?.revision ?? 0) && (editing === null || analysisCurrent)
  const supported = value.items.length > 0 && value.items.every(item => eligible.some(candidate => candidate.materialId === item.materialId
    && candidate.catalogVersion === item.catalogVersion && candidate.expectedQuantity === Number(item.quantity)))
  const saveInput = inpatientMaterialEstimateSaveInputSchema.safeParse({ admissionId: admission.id, requestId: estimate.requestId,
    expectedVersion: estimate.version, expectedDraftRevision: value.revision, expectedBasisFingerprint: value.basisFingerprint,
    analysisId: value.analysisId, items: value.items.map(item => ({ ...item, quantity: Number(item.quantity) })), note: value.note })
  const report = reports.find(report => report.id === pciDraft?.reportId && report.version === pciDraft.reportVersion)
  const pciCurrent = pciEditing === null || pciDraft !== undefined && pciEditing.version === pciDraft.version && pciEditing.reportId === pciDraft.reportId && pciEditing.reportVersion === pciDraft.reportVersion
  const pciParameters = pciEditing === null ? null : inpatientPciSelectionSaveInputSchema.shape.parameters.safeParse(pciEditing.parameters)
  const pciIssues = pciParameters !== null && !pciParameters.success ? pciParameters.error.issues : []
  const sourceKey = reviewSources(estimate, pciDraft, report, reservationFingerprint, encounterVersion)
  const reviewKey = JSON.stringify([value, sourceKey])
  const canConfirm = pciEditing === null && reservationFingerprint !== undefined && !['queued', 'running', 'stale', 'unknown', 'cancelled'].includes(estimate.status) && fingerprintCurrent && draftCurrent && supported && saveInput.success
  const confirmed = draft !== null && draft.confirmedRevision === draft.revision && editing === null
  const blocked = write.blocked || !editable
  const command = write.pending?.command ?? write.mutation.variables
  const saving = command?.operation === 'inpatient.material-estimate.save' && command.input.admissionId === admission.id
    && command.input.requestId === estimate.requestId && write.mutation.isPending
  const fieldsBlocked = blocked && !saving
  const reviewOpen = reviewed === reviewKey && !confirmed
  const reviewing = reviewOpen || finalizing
  const confirmDisabled = blocked || !current || !canConfirm || !encounterVersion || !preoperative
  const confirmation = useWorkspaceConfirmation({ open: reviewing, pending: finalizing, disabled: confirmDisabled,
    scope: JSON.stringify([session.user.id, session.actor, admission.id, estimate.requestId]), onCancel: () => setReviewed(null) })
  const savePci = async () => {
    if (!pciEditing || !pciParameters?.success || !pciCurrent || blocked || !current || !preoperative) return
    try {
      const result = await write.mutation.mutateAsync({ operation: 'inpatient.pci-selection.save', input: { admissionId: admission.id,
        requestId: estimate.requestId, expectedDraftVersion: pciEditing.version, parameters: pciParameters.data }, isCurrent })
      const saved = inpatientPciSelectionResponseSchema.parse(result.response).data.drafts?.find(draft => draft.requestId === estimate.requestId)
      const latest = client.getQueryData<z.infer<typeof inpatientPciSelectionSchema>>([...inpatientScopeKey(session), admission.id, 'pci-selection'])?.drafts?.find(draft => draft.requestId === estimate.requestId)
      if (alive.current && saved && (JSON.stringify(latest) === JSON.stringify(pciDraft) || JSON.stringify(latest) === JSON.stringify(saved))) {
        client.setQueryData<z.infer<typeof inpatientPciSelectionSchema>>([...inpatientScopeKey(session), admission.id, 'pci-selection'],
          data => data && { ...data, drafts: data.drafts?.map(item => item.requestId === saved.requestId ? saved : item) })
        setPciEditing(value => value === pciEditing ? null : value && { ...value, version: saved.version, reportId: saved.reportId, reportVersion: saved.reportVersion })
        setReviewed(null)
      }
    } catch { /* The shared write intent preserves the original draft save for recovery. */ }
  }
  const common = { admissionId: admission.id, requestId: estimate.requestId, expectedRequestVersion: estimate.requestVersion,
    expectedVersion: estimate.version, expectedBasisFingerprint: estimate.basisFingerprint }
  const adopt = (items: DraftItems, analysisId: string | null) => {
    setReviewed(null)
    setEditing({ items: items.map(item => ({ ...item, quantity: String(item.quantity) })),
      note: value.note, revision: value.revision, basisFingerprint: estimate.basisFingerprint, analysisId })
  }
  const save = async () => {
    if (!saveInput.success || blocked || !current || !fingerprintCurrent || !draftCurrent) return undefined
    try {
      const result = await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.save', input: saveInput.data, isCurrent })
      const saved = inpatientMaterialEstimateResponseSchema.parse(result.response).data
      if (alive.current) {
        setFailedSave(null)
        const latest = client.getQueryData<z.infer<typeof inpatientMaterialEstimatesSchema>>(
          [...inpatientScopeKey(session), admission.id, 'material-estimates'])?.estimates.find(item => item.requestId === estimate.requestId) ?? latestEstimate.current
        const ownReceipt = latest.version === saved.version && (latest.basisFingerprint === value.basisFingerprint
          && (latest.draft?.revision ?? 0) === value.revision || latest.basisFingerprint === saved.basisFingerprint
          && latest.draft?.revision === saved.draft?.revision)
        if (!ownReceipt) { setReviewed(null); return undefined }
        client.setQueryData<z.infer<typeof inpatientMaterialEstimatesSchema>>([...inpatientScopeKey(session), admission.id, 'material-estimates'],
          data => data && { ...data, estimates: data.estimates.map(item => item.requestId !== saved.requestId ? item
            : JSON.stringify(item) === JSON.stringify(estimate) ? saved : { ...item, draft: saved.draft }) })
        setEditing(current => latestInput.current === inputKey ? null : current === null ? null : { ...current,
          revision: saved.draft!.revision, basisFingerprint: saved.draft!.basisFingerprint, analysisId: saved.draft!.analysisId })
      }
      return saved
    } catch (error) {
      if (alive.current) setFailedSave(contentKey)
      throw error
    }
  }
  const saveLatest = useRef(save)
  saveLatest.current = save
  const autoSave = editing !== null && saveInput.success && fingerprintCurrent && draftCurrent && !blocked && current && failedSave !== contentKey
  useEffect(() => {
    if (!autoSave) return
    const timer = setTimeout(() => { void saveLatest.current().catch(() => undefined) }, 750)
    return () => clearTimeout(timer)
  }, [autoSave, contentKey, editing])
  const reestimate = async () => {
    if (blocked || !current || !preoperative || ['queued', 'running', 'unknown'].includes(estimate.status)) return
    try {
      const saved = editing !== null ? await save() : estimate
      if (!saved || !alive.current || !visibility.current.active || visibility.current.version !== visibilityVersion || latestInput.current !== inputKey) return
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.request', input: { ...common,
        expectedVersion: saved.version, expectedRequestVersion: saved.requestVersion, expectedBasisFingerprint: saved.basisFingerprint }, isCurrent })
    } catch { /* Preserve the original save or request intent for recovery. */ }
  }
  const confirm = async () => {
    if (blocked || !current || !preoperative || !canConfirm || reviewed !== reviewKey || !encounterVersion || !reservationFingerprint) return
    setFinalizing(true)
    try {
      const saved = editing !== null || !draft ? await save() : estimate
      if (!saved?.draft || !alive.current || !visibility.current.active || visibility.current.version !== visibilityVersion || latestInput.current !== inputKey) return
      const scope = [...inpatientScopeKey(session), admission.id]
      const latest = client.getQueryData<z.infer<typeof inpatientMaterialEstimatesSchema>>([...scope, 'material-estimates'])?.estimates.find(item => item.requestId === estimate.requestId) ?? saved
      const latestDraft = client.getQueryData<z.infer<typeof inpatientPciSelectionSchema>>([...scope, 'pci-selection'])?.drafts?.find(item => item.requestId === estimate.requestId)
      const latestReport = client.getQueryData<z.infer<typeof inpatientAngiographyReportsSchema>>([...scope, 'angiography-reports'])?.reports.find(item => item.id === latestDraft?.reportId && item.version === latestDraft.reportVersion)
      const latestReservations = client.getQueryData<z.infer<typeof inpatientMaterialReservationListSchema>>([...scope, 'drg-reservations'])
      if (reviewSources(latest, latestDraft, latestReport, latestReservations?.reservationSets.find(set => set.requestId === estimate.requestId)?.fingerprint,
        latestReservations?.encounterVersion) !== sourceKey) return
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.confirm', input: { admissionId: admission.id,
        requestId: estimate.requestId, expectedVersion: saved.version, expectedDraftRevision: saved.draft.revision,
        expectedBasisFingerprint: saved.basisFingerprint, expectedRequestVersion: saved.requestVersion,
        encounterVersion, expectedReservationFingerprint: reservationFingerprint,
        reason: saved.draft.note || t('医生已核对整批预计耗材及原预留处理', 'Doctor reviewed the material estimate and reservation changes') }, isCurrent })
      if (alive.current) setReviewed(null)
    } catch { /* The shared write intent retains the original operation and exposes recovery. */ }
    finally { if (alive.current) setFinalizing(false) }
  }
  const modelFailure = estimate.failureCode ? modelUsageMessages(locale).rejectionLabel(estimate.failureCode) : null
  const costExplanation = estimate.analysis?.costExplanation
  const currentCostExplanation = readable && estimate.status === 'succeeded' && estimate.costs !== null
    && estimate.analysis?.basisFingerprint === estimate.basisFingerprint
  return <article aria-label={`${t('耗材预计：', 'Material estimate: ')}${title}`} className="flex flex-col gap-3 rounded-md border p-3">
    <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{title}</h5><Badge variant="secondary">{t(statusLabels[estimate.status][0], statusLabels[estimate.status][1])}</Badge></div>
    <p className="text-sm text-muted-foreground">{t('关联计划：', 'Plan: ')}{estimate.requestId} v{estimate.requestVersion}</p>
    {pciDraft ? <>
      <InpatientPciDraftFields draft={pciDraft} value={(pciEditing ?? pciDraft).parameters} report={report} locale={locale} disabled={blocked || !preoperative} issues={pciIssues}
        onChange={parameters => { setReviewed(null); setPciEditing({ ...(pciEditing ?? pciDraft), parameters }) }} />
      {pciEditing ? <p role="status">{t('选型参数有未保存修改；保存并核对更新后的清单、费用后才能确认。', 'PCI parameters have unsaved edits. Save and review the updated material list and costs before confirming.')}</p> : null}
      {!pciCurrent ? <Alert><AlertDescription>{t('选型参数或绑定报告已更新，当前输入仍保留。请核对最新参数后再继续。', 'The selection draft or linked report changed. Your input is retained; review the latest parameters before continuing.')}
        <Button variant="outline" disabled={blocked || !current} onClick={() => { setReviewed(null); setPciEditing(value => value && { ...pciDraft, parameters: value.parameters }) }}>{t('保留输入并核对最新选型', 'Keep edits after reviewing the latest selection parameters')}</Button>
      </AlertDescription></Alert> : null}
      {editable && preoperative ? <Button variant="outline" disabled={blocked || !current || !pciEditing || !pciCurrent || pciParameters?.success !== true}
        onClick={() => { void savePci() }}>{t('保存选型参数', 'Save selection parameters')}</Button> : null}
    </> : null}
    {estimate.missing.length > 0 ? <Alert><AlertDescription><ul>{estimate.missing.map(reason => <li key={reason}>{reason}</li>)}</ul></AlertDescription></Alert> : null}
    {estimate.failureCode ? <Alert variant="destructive"><AlertDescription>{estimate.failureCode === 'INPATIENT_DRG_AGENT_INVALID'
      ? t('AI 建议未通过材料、兼容性或数量依据核验，未发布为可确认清单。请核对有效院内方案。', 'The AI suggestion failed material, compatibility or quantity verification and was not published as a confirmable list. Review a verified hospital plan.')
      : modelFailure !== estimate.failureCode ? modelFailure : estimate.status === 'unknown'
        ? t('原请求结果尚未查明，请核查原尝试后再继续。', 'The original request outcome is unresolved. Reconcile that attempt before continuing.')
        : t('本次 AI 预计未完成，请查看请求记录；有效院内方案仍可核对。', 'The AI estimate did not complete. Review its request record; verified hospital plans remain available.')}</AlertDescription></Alert> : null}
    {estimate.status === 'unknown' ? <p>{t('请展开下方AI请求记录核查原尝试；核查前不会重新安排。有效的原业务记录仍保留。', 'Expand the AI request records below to reconcile the original attempt. Existing business records are retained.')}</p> : null}
    <details onToggle={event => setUsageOpen(event.currentTarget.open)}><summary>{t('查看本次预计AI请求与恢复', 'Review AI requests and recovery for this estimate')}</summary>
      {usageOpen ? <InpatientDrgUsagePanel admissionId={admission.id} taskId={estimate.id} session={session} locale={locale} active={active} taskKind="estimate" /> : null}
    </details>
    {estimate.analysis ? <details><summary>{t('查看生成快照与依据', 'Review generated snapshot and evidence')}</summary>
      <p>{estimate.analysis.model} · {estimate.analysis.createdAt}</p>
      <p>{estimate.analysis.sources.evidencePackageId} · {estimate.analysis.sources.evidencePackageVersion}</p>
      <p>{t('仅证明明示的有限合成范围，不代表真实临床金标准。', 'Evidence supports only the stated synthetic scope, not a clinical gold standard.')}</p>
      {estimate.analysis.items.map(item => <p key={item.materialId}>{item.display} · {item.materialId} v{item.catalogVersion} · {item.quantity}{item.unit} · {formatFen(item.estimatedFen, locale)} · {item.reason}</p>)}
      {estimate.analysis.sources.materialEvidence.map(evidence => <div key={evidence.id}><p>{evidence.id} · {evidence.version} · {evidence.specification}</p><p>{evidence.scope}</p><p>{evidence.applicability}</p><p>{evidence.compatibility}</p><p>{evidence.quantityBasis}</p><p>{evidence.sourceLocator}</p></div>)}
    </details> : null}
    {editable ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={blocked || !current || !preoperative || ['queued', 'running', 'unknown'].includes(estimate.status) || editing !== null && (!fingerprintCurrent || !draftCurrent || !saveInput.success)} onClick={() => { void reestimate() }}>{t('重新预计，保留耗材清单', 'Re-estimate and retain material list')}</Button>
      {['queued', 'running'].includes(estimate.status) ? <Button variant="outline" disabled={blocked || !current} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.cancel', input: common, isCurrent })}>{t('取消本次预计', 'Cancel this estimate')}</Button> : null}
      <Button variant="outline" disabled={blocked || !current || eligible.length === 0 || estimate.status === 'unknown'} onClick={() => adopt(eligible.map(candidate => ({ materialId: candidate.materialId,
        catalogVersion: candidate.catalogVersion, quantity: candidate.expectedQuantity!, reason: candidate.quantityBasis })), null)}>{t('从有效院内方案带入', 'Use verified hospital plan')}</Button>
    </div> : null}
    {estimate.candidateItems.length > 0 ? <section aria-label={t('新预计候选差异', 'New estimate candidates')} className="flex flex-col gap-2">
      <h6 className="font-medium">{t('新预计候选差异，尚未替换耗材清单', 'New estimate candidates have not replaced the material list')}</h6>
      {estimate.candidateItems.map(item => <p key={item.materialId}>{item.display} · {item.quantity}{item.unit} · {item.reason} · {formatFen(item.estimatedFen, locale)}</p>)}
      {editable ? <Button variant="outline" disabled={blocked || !current || estimate.status !== 'succeeded' || estimate.analysis?.basisFingerprint !== estimate.basisFingerprint}
        onClick={() => adopt(estimate.candidateItems.map(({ materialId, catalogVersion, quantity, reason }) => ({ materialId, catalogVersion, quantity, reason })), estimate.analysis?.id ?? null)}>{t('采用新候选到耗材清单', 'Apply new candidates to material list')}</Button> : null}
    </section> : null}
    <AgentDraftField locale={locale} assisted={editing === null && draft?.edited === false && draft.analysisId !== null}>
    <FieldSet disabled={fieldsBlocked}><FieldLegend>{t('未确认耗材清单', 'Unconfirmed material list')}{draft ? ` v${draft.revision}` : ''}</FieldLegend><FieldGroup>
      {value.items.length === 0 ? <p>{t('耗材清单暂无材料，可从有效院内方案带入或选择候选。', 'The material list is empty. Use a verified hospital plan or select candidates.')}</p> : null}
      {value.items.map((item, index) => {
        const candidate = candidates.find(candidate => candidate.materialId === item.materialId && candidate.catalogVersion === item.catalogVersion)
        const name = candidate?.item?.display ?? item.materialId
        const valid = candidate?.eligibility === 'valid' && candidate.expectedQuantity === Number(item.quantity)
        const quantity = Number(item.quantity), price = candidate?.item?.chargeDefinition.priceFen
        const amount = price === undefined || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(price * quantity) ? null : price * quantity
        const change = (patch: Partial<Editing['items'][number]>) => update({ items: value.items.map((value, position) => position === index ? { ...value, ...patch } : value) })
        return <FieldGroup key={item.materialId}>
          <p>{name} · {item.materialId} v{item.catalogVersion}</p>
          <p>{candidate?.evidence.specification} · {candidate?.item ? `${formatFen(candidate.item.chargeDefinition.priceFen, locale)}/${candidate.item.chargeDefinition.unit}` : t('目录修订不可用', 'Catalog revision unavailable')}</p>
          <p>{t('数量依据：', 'Quantity basis: ')}{candidate?.quantityBasis ?? t('缺少依据', 'Evidence missing')}</p>
          {candidate?.missing.map(reason => <p key={reason}>{reason}</p>)}
          {editable ? <>
            <Field data-invalid={!valid}><FieldLabel htmlFor={`estimate-quantity-${estimate.requestId}-${item.materialId}`}>{t('预计数量：', 'Estimated quantity: ')}{name}</FieldLabel>
              <Input id={`estimate-quantity-${estimate.requestId}-${item.materialId}`} type="number" min="1" max="1000" step="1" aria-invalid={!valid} value={item.quantity} onChange={event => change({ quantity: event.currentTarget.value })} /></Field>
            <Field data-invalid={!item.reason.trim()}><FieldLabel htmlFor={`estimate-reason-${estimate.requestId}-${item.materialId}`}>{t('预计理由：', 'Estimate reason: ')}{name}</FieldLabel>
              <Input id={`estimate-reason-${estimate.requestId}-${item.materialId}`} maxLength={2000} aria-invalid={!item.reason.trim()} value={item.reason} onChange={event => change({ reason: event.currentTarget.value })} /></Field>
            <Button variant="outline" onClick={() => update({ items: value.items.filter((_, position) => position !== index) })}>{t('移除', 'Remove')} {name}</Button>
          </> : <p>{t('预计数量：', 'Estimated quantity: ')}{item.quantity}{candidate?.item?.chargeDefinition.unit} · {item.reason}</p>}
          <p>{t('目录金额：', 'Catalog amount: ')}{amount === null ? t('待核对', 'Review required') : formatFen(amount, locale)}</p>
        </FieldGroup>
      })}
      {editable ? <>
        <Field><FieldLabel htmlFor={`estimate-add-${estimate.requestId}`}>{t('添加候选耗材', 'Add candidate material')}</FieldLabel><WorkspaceSelect id={`estimate-add-${estimate.requestId}`} value={null}
          items={candidates.filter(candidate => candidate.item !== null && !value.items.some(item => item.materialId === candidate.materialId)).map(candidate => ({ value: candidate.materialId, label: `${candidate.item!.display} · v${candidate.catalogVersion}` }))}
          onValueChange={id => { const candidate = candidates.find(candidate => candidate.materialId === id); if (candidate) update({ items: [...value.items, { materialId: candidate.materialId,
            catalogVersion: candidate.catalogVersion, quantity: candidate.expectedQuantity === null ? '' : String(candidate.expectedQuantity), reason: candidate.quantityBasis }], analysisId: null }) }} /></Field>
        <Field><FieldLabel htmlFor={`estimate-note-${estimate.requestId}`}>{t('耗材清单说明', 'Material list note')}</FieldLabel><Input id={`estimate-note-${estimate.requestId}`} maxLength={2000} value={value.note} onChange={event => update({ note: event.currentTarget.value })} /></Field>
        {!draftCurrent ? <Alert><AlertDescription>
          <p>{t('已保存耗材清单或生成结果已更新，当前输入仍保留。请核对最新内容，再保留当前编辑继续保存；过期生成关联将移除，材料和说明保留为手工清单。', 'The saved material list or generated result changed. Your input is retained. Review the latest contents before continuing; an outdated generated-result link will be removed while your items and note remain as a manual material list.')}</p>
          <p>{t('最新已保存说明：', 'Latest saved note: ')}{draft?.note || t('无说明', 'None')}</p>
          {draft?.items.map(item => <p key={item.materialId}>{item.materialId} v{item.catalogVersion} · {item.quantity} · {item.reason}</p>)}
          <Button variant="outline" disabled={blocked || !current} onClick={() => {
            update({ revision: draft?.revision ?? 0, analysisId: analysisCurrent ? value.analysisId : null }); setFailedSave(null); setReviewed(null)
          }}>{t('保留当前编辑并核对最新耗材清单', 'Keep current edits after reviewing the latest material list')}</Button>
        </AlertDescription></Alert> : null}
        {!fingerprintCurrent ? <Alert><AlertDescription>{t('耗材清单依据已变化，原编辑仍保留。核对当前目录、数量和缺项后再保存。', 'Material list sources changed; edits are retained. Review current catalog, quantities and missing facts before saving.')}
          <Button variant="outline" disabled={blocked || !current || !supported} onClick={() => update({ basisFingerprint: estimate.basisFingerprint, analysisId: null })}>{t('按当前依据核对耗材清单', 'Review material list against current sources')}</Button>
        </AlertDescription></Alert> : null}
        {!supported && value.items.length > 0 ? <Alert><AlertDescription>{t('具体产品或数量尚未通过当前依据核对。可保存耗材清单，核对通过前不能确认为预留。', 'The product or quantity is not verified against current evidence. You may save the material list; reservation confirmation requires verification.')}</AlertDescription></Alert> : null}
        <Button variant="outline" disabled={blocked || !current || !fingerprintCurrent || !draftCurrent || !saveInput.success || editing === null} onClick={() => { void save().catch(() => undefined) }}>{t('保存耗材清单', 'Save material list')}</Button>
      </> : <p>{value.note}</p>}
    </FieldGroup></FieldSet></AgentDraftField>
    {saving ? <p role="status">{t('正在保存耗材清单', 'Saving material list')}</p> : null}
    {failedSave === contentKey ? <Alert variant="destructive"><AlertDescription>{t('耗材清单自动保存失败，编辑仍保留。请先恢复原操作，或手动保存。', 'Automatic material list save failed; edits are retained. Recover the original operation or save manually.')}</AlertDescription></Alert> : null}
    {draft ? <p>{t('服务端耗材清单：', 'Saved material list: ')}v{draft.revision} · {draft.updatedAt}{editing ? t(' · 有未保存修改，停止输入后自动保存', ' · Unsaved changes; saves automatically after typing stops') : t(' · 已保存', ' · Saved')}</p> : null}
    <section aria-label={t('本计划有效预留', 'Active reservations for this plan')} className="flex flex-col gap-2">
      <h6 className="font-medium">{t('本计划有效预留', 'Active reservations for this plan')}</h6>
      {activeReservations.length === 0 ? <p>{t('本计划暂无有效预留。', 'This plan has no active reservations.')}</p> : activeReservations.map(reservation => <p key={reservation.id}>{reservation.materialDisplay} · {reservation.specification} · {reservation.remainingQuantity ?? reservation.quantity - reservation.consumedQuantity}{reservation.unit} · {formatFen(reservation.priceFen, locale)}/{reservation.unit ?? t('单位待核对', 'Unit unknown')} · {reservation.id} v{reservation.version}</p>)}
      {activeReservations.length > 0 ? <p>{t('再次确认将整批替代以上本计划预留，已发生使用与其他计划预留保留。', 'Confirmation replaces the reservations listed above as one batch. Actual use and other plans are retained.')}</p> : null}
    </section>
    {estimate.planBasis ? <InpatientMaterialPlanBasisDetails basis={estimate.planBasis} locale={locale} /> : null}
    <InpatientPciCosts costs={estimate.costs} locale={locale} />
    {costExplanation && currentCostExplanation ? <section aria-label={t('当前AI费用说明', 'Current AI cost explanation')} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><h6 className="font-medium">{t('当前AI费用说明', 'Current AI cost explanation')}</h6><Badge variant="outline" className="border-info/40 text-info">{t('助手', 'Assistant')}</Badge></div>
      <p className="max-w-prose whitespace-pre-wrap break-words text-sm">{costExplanation}</p>
      <details><summary className="cursor-pointer text-sm text-info">{t('费用说明依据', 'Cost explanation sources')}</summary>
        <p className="text-sm text-muted-foreground">{t('金额来自上方确定性费用块；请对照费用组成、分组及医院支付参考核对，不据此改变临床选择。', 'Amounts come from the deterministic cost block above. Review the components, grouping and hospital payment references; this does not change clinical choices.')}</p>
      </details>
    </section> : costExplanation ? <details><summary>{t('历史AI费用说明（不用于当前费用）', 'Historical AI cost explanation (not current costs)')}</summary>
      <section aria-label={t('历史AI费用说明', 'Historical AI cost explanation')} className="flex min-w-0 flex-col gap-2 pt-2">
        <p className="text-sm text-muted-foreground">{t('以下文字保留生成时的依据；当前金额以上方确定性费用块为准。', 'This text retains its original sources. Use the deterministic cost block above for current amounts.')}</p>
        <p className="max-w-prose whitespace-pre-wrap break-words text-sm">{costExplanation}</p>
      </section>
    </details> : null}
    {editable && !preoperative ? <p role="status">{t('仅能在手术开始前确认；当前术前确认依据只读，工作稿编辑不会改写原确认清单。', 'Confirmation is available only before surgery starts. The preoperative basis is read-only; draft edits do not change the confirmed list.')}</p> : null}
    {!finalizing && reviewed !== null && reviewed !== reviewKey ? <Alert><AlertDescription>{t('参数、报告、清单、费用或原预留已更新，请重新审阅后确认。', 'Parameters, report, material list, costs or reservations changed. Review again before confirming.')}</AlertDescription></Alert> : null}
    {editable ? <FieldSet disabled={blocked || !preoperative}><FieldLegend>{t('整批审阅与确认', 'Batch review and confirmation')}</FieldLegend><FieldGroup>
      <p>{t('本次确认同时留存术前清单，术后按原确认数量核查；无需再确认另一份计划，也不会自动开启持续跟进。', 'Confirmation retains the preoperative list for review against its original quantities. No second plan confirmation is required, and continuous follow-up does not start automatically.')}</p>
      <Field orientation="horizontal"><Checkbox id={`estimate-review-${estimate.requestId}`} checked={reviewed === reviewKey} onCheckedChange={checked => { if (checked) confirmation.captureTrigger(); setReviewed(checked ? reviewKey : null) }} />
        <FieldLabel htmlFor={`estimate-review-${estimate.requestId}`}>{pciDraft ? t('已核对选型参数、材料、数量、费用、依据及原预留处理', 'Reviewed PCI parameters, materials, quantities, costs, evidence and reservation changes') : t('已核对材料、数量、依据及以上原预留处理', 'Reviewed materials, quantities, evidence and reservation changes')}</FieldLabel></Field>
      {!reviewing ? <Button disabled>{confirmed ? t('本版耗材清单已确认', 'This material list revision is confirmed') : pciDraft ? t('确认选型、清单与预留', 'Confirm selection, material list and reservations') : t('确认整批预留', 'Confirm reservation batch')}</Button> : null}
    </FieldGroup></FieldSet> : <p>{t('当前岗位或病案状态只允许查看。', 'Your role or record state permits viewing only.')}</p>}
    {editable && preoperative && reviewing ? <InpatientPrimaryAction stage="surgery" priority={30}><WorkspaceActionBar tone="assistant"
      summary={title} reason={!current ? t('最新参数、清单与预留尚未核对完成，暂不能确认。', 'The latest parameters, material list and reservations have not finished checking; confirmation is temporarily unavailable.')
        : pciDraft ? t('一次确认选型、术前清单与本计划预留', 'Confirm selection, preoperative list and this plan’s reservations together') : t('确认术前清单与本计划预留', 'Confirm the preoperative list and this plan’s reservations')}
      busy={finalizing ? t('正在确认清单与预留', 'Confirming material list and reservations') : undefined} onKeyDown={confirmation.onKeyDown}
      action={<><Button variant="outline" disabled={finalizing} onClick={() => setReviewed(null)}>{t('返回修改', 'Return to editing')}</Button>
        <Button ref={confirmation.confirmRef} disabled={confirmDisabled} onClick={() => { void confirm() }}>{pciDraft ? t('确认选型、清单与预留', 'Confirm selection, material list and reservations') : t('确认整批预留', 'Confirm reservation batch')}</Button></>} />
    </InpatientPrimaryAction> : null}
  </article>
}
