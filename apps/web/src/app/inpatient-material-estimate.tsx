import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
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
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>;
  requests?: z.infer<typeof inpatientSurgeryRequestSchema>[] }
type DraftItems = z.infer<typeof inpatientMaterialEstimateSaveInputSchema>['items']
type Editing = { items: Array<Omit<DraftItems[number], 'quantity'> & { quantity: string }>; note: string;
  analysisId: string | null; revision: number; basisFingerprint: string }
const statusLabels = {
  incomplete: ['预计依据不完整，请核对缺项', 'Sources are incomplete; review missing facts'],
  queued: ['已保存计划，等待 AI 预计', 'Plan saved; waiting for AI estimate'],
  running: ['AI 正在准备预计清单', 'AI is preparing the estimate'],
  succeeded: ['AI 预计与独立核验已完成', 'AI estimate and independent verification completed'],
  stale: ['依据已变化，请更新预计', 'Sources changed; update the estimate'],
  blocked: ['AI 预计受阻，可核对院内方案', 'AI estimate blocked; hospital plan remains available'],
  unknown: ['原模型请求结果未知，请先核查原尝试', 'Original model outcome unknown; reconcile the original attempt'],
  failed: ['AI 预计失败，可核对院内方案', 'AI estimate failed; hospital plan remains available'],
  cancelled: ['本次预计已取消', 'This estimate was cancelled'],
} as const

export function InpatientMaterialEstimates({ admission, session, locale, write, requests = [] }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = [...inpatientScopeKey(session), admission.id]
  const query = useQuery({ queryKey: [...scope, 'material-estimates'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal),
    refetchInterval: admission.status === 'admitted' && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const reservations = useQuery({ queryKey: [...scope, 'drg-reservations'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const editable = session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const command = write.pending?.command ?? write.mutation.variables
  const error = query.error ?? reservations.error ?? (command?.operation.startsWith('inpatient.material-estimate.')
    && 'admissionId' in command.input && command.input.admissionId === admission.id ? write.mutation.error : null)
  return <section aria-label={t('手术耗材预计', 'Surgery material estimates')} className="flex flex-col gap-3">
    <h4 className="font-medium">{t('手术耗材预计', 'Surgery material estimates')}</h4>
    <p>{t('保存冠脉计划后自动预计一次，无需开启持续跟进。工作稿与有效预留分别保存；预留只用于费用推演，实际使用与正式费用另行记录。', 'A coronary plan triggers one estimate without continuous follow-up. Drafts and active reservations are saved separately. Reservations support simulation; actual use and charges are recorded separately.')}</p>
    {query.isPending ? <div role="status" aria-label={t('正在读取耗材预计', 'Loading material estimates')}><Skeleton className="h-16 w-full" /></div> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {query.data?.estimates.map(estimate => <EstimateEditor key={JSON.stringify([session.user.id, session.actor.actorId, ...scope, estimate.requestId])} estimate={estimate} admission={admission}
      title={requests.find(request => request.id === estimate.requestId)?.plannedProcedure.coding.display ?? estimate.requestId}
      reservations={reservations.data?.reservations ?? []} encounterVersion={reservations.data?.encounterVersion}
      reservationFingerprint={reservations.data?.reservationSets.find(set => set.requestId === estimate.requestId)?.fingerprint}
      locale={locale} session={session} write={write} editable={editable} current={!query.isFetching && query.error === null && !reservations.isFetching && reservations.error === null} />)}
    {query.data?.unprepared.map(plan => <article key={plan.requestId} className="flex flex-col gap-2 rounded-md border p-3">
      <p>{requests.find(request => request.id === plan.requestId)?.plannedProcedure.coding.display ?? plan.requestId} · {t('历史计划尚未准备预计', 'Historical plan has no estimate')}</p>
      {editable ? <Button variant="outline" disabled={write.blocked || query.isFetching || query.error !== null} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.request', input: {
        admissionId: admission.id, requestId: plan.requestId, expectedRequestVersion: plan.requestVersion, expectedVersion: 0, expectedBasisFingerprint: plan.basisFingerprint,
      } })}>{t('为此计划准备一次预计', 'Prepare one estimate for this plan')}</Button> : null}
    </article>)}
    {query.data?.estimates.length === 0 && query.data.unprepared.length === 0 ? <p>{t('暂无需要预计的冠脉手术计划。', 'No coronary surgery plans require an estimate.')}</p> : null}
  </section>
}

function EstimateEditor({ estimate, admission, title, reservations, encounterVersion, reservationFingerprint, locale, session, write, editable, current }: {
  estimate: InpatientMaterialEstimate; admission: InpatientAdmission; title: string; reservations: InpatientMaterialReservation[];
  encounterVersion: string | undefined; reservationFingerprint: string | undefined; locale: WorkspaceLocale; session: SessionContext; write: Props['write']; editable: boolean; current: boolean;
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [editing, setEditing] = useState<Editing | null>(null)
  const [reviewed, setReviewed] = useState<string | null>(null)
  const [failedSave, setFailedSave] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const draft = estimate.draft
  const base: Editing = { items: (draft?.items ?? []).map(item => ({ ...item, quantity: String(item.quantity) })), note: draft?.note ?? '',
    analysisId: draft?.analysisId ?? null, revision: draft?.revision ?? 0, basisFingerprint: draft?.basisFingerprint ?? estimate.basisFingerprint }
  const value = editing ?? base
  const contentKey = JSON.stringify([value.items, value.note, value.analysisId, value.basisFingerprint])
  const latestContent = useRef(contentKey)
  latestContent.current = contentKey
  const update = (patch: Partial<Editing>) => setEditing(previous => ({ ...(previous ?? base), ...patch }))
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
  const reviewKey = JSON.stringify([estimate.version, value, reservationFingerprint])
  const canConfirm = reservationFingerprint !== undefined && !['queued', 'running', 'stale', 'unknown', 'cancelled'].includes(estimate.status) && fingerprintCurrent && draftCurrent && supported && saveInput.success
  const confirmed = draft !== null && draft.confirmedRevision === draft.revision && editing === null
  const blocked = write.blocked || !editable
  const command = write.pending?.command ?? write.mutation.variables
  const saving = command?.operation === 'inpatient.material-estimate.save' && command.input.admissionId === admission.id
    && command.input.requestId === estimate.requestId && write.mutation.isPending
  const fieldsBlocked = blocked && !saving
  const common = { admissionId: admission.id, requestId: estimate.requestId, expectedRequestVersion: estimate.requestVersion,
    expectedVersion: estimate.version, expectedBasisFingerprint: estimate.basisFingerprint }
  const adopt = (items: DraftItems, analysisId: string | null) => setEditing({ items: items.map(item => ({ ...item, quantity: String(item.quantity) })),
    note: value.note, revision: value.revision, basisFingerprint: estimate.basisFingerprint, analysisId })
  const save = async () => {
    if (!saveInput.success || blocked || !current || !fingerprintCurrent || !draftCurrent) return undefined
    try {
      const result = await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.save', input: saveInput.data })
      const saved = inpatientMaterialEstimateResponseSchema.parse(result.response).data
      if (alive.current) {
        setFailedSave(null)
        setEditing(current => latestContent.current === contentKey ? null : current === null ? null : { ...current, revision: saved.draft!.revision })
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
    if (blocked || !current || ['queued', 'running', 'unknown'].includes(estimate.status)) return
    try {
      const saved = editing !== null ? await save() : estimate
      if (!saved || !alive.current || latestContent.current !== contentKey) return
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.request', input: { ...common,
        expectedVersion: saved.version, expectedRequestVersion: saved.requestVersion, expectedBasisFingerprint: saved.basisFingerprint } })
    } catch { /* Preserve the original save or request intent for recovery. */ }
  }
  const confirm = async () => {
    if (blocked || !current || !canConfirm || reviewed !== reviewKey || !encounterVersion || !reservationFingerprint) return
    try {
      const saved = editing !== null || !draft ? await save() : estimate
      if (!saved?.draft || !alive.current || latestContent.current !== contentKey) return
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.confirm', input: { admissionId: admission.id,
        requestId: estimate.requestId, expectedVersion: saved.version, expectedDraftRevision: saved.draft.revision,
        expectedBasisFingerprint: saved.basisFingerprint, expectedRequestVersion: saved.requestVersion,
        encounterVersion, expectedReservationFingerprint: reservationFingerprint,
        reason: saved.draft.note || t('医生已核对整批预计耗材及原预留处理', 'Doctor reviewed the material estimate and reservation changes') } })
      if (alive.current) setReviewed(null)
    } catch { /* The shared write intent retains the original operation and exposes recovery. */ }
  }
  return <article aria-label={`${t('耗材预计：', 'Material estimate: ')}${title}`} className="flex flex-col gap-3 rounded-md border p-3">
    <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{title}</h5><Badge variant="secondary">{t(statusLabels[estimate.status][0], statusLabels[estimate.status][1])}</Badge></div>
    <p className="text-sm text-muted-foreground">{t('关联计划：', 'Plan: ')}{estimate.requestId} v{estimate.requestVersion}</p>
    {estimate.missing.length > 0 ? <Alert><AlertDescription><ul>{estimate.missing.map(reason => <li key={reason}>{reason}</li>)}</ul></AlertDescription></Alert> : null}
    {estimate.failureCode ? <Alert variant="destructive"><AlertDescription>{estimate.failureCode === 'INPATIENT_DRG_AGENT_INVALID'
      ? t('AI 建议未通过材料、兼容性或数量依据核验，未发布为可确认清单。请核对有效院内方案。', 'The AI suggestion failed material, compatibility or quantity verification and was not published as a confirmable list. Review a verified hospital plan.')
      : modelUsageMessages(locale).rejectionLabel(estimate.failureCode)} ({estimate.failureCode})</AlertDescription></Alert> : null}
    {estimate.status === 'unknown' ? <p>{t('请展开下方模型请求记录核查原尝试；核查前不会重新派发。有效的原业务记录仍保留。', 'Expand the model request records below to reconcile the original attempt. Existing business records are retained.')}</p> : null}
    <details onToggle={event => setUsageOpen(event.currentTarget.open)}><summary>{t('查看本次预计模型请求与恢复', 'Review model requests and recovery for this estimate')}</summary>
      {usageOpen ? <InpatientDrgUsagePanel admissionId={admission.id} taskId={estimate.id} session={session} locale={locale} active taskKind="estimate" /> : null}
    </details>
    {estimate.analysis ? <details><summary>{t('查看生成快照与依据', 'Review generated snapshot and evidence')}</summary>
      <p>{estimate.analysis.model} · {estimate.analysis.createdAt}</p>
      <p>{estimate.analysis.sources.evidencePackageId} · {estimate.analysis.sources.evidencePackageVersion}</p>
      <p>{t('仅证明明示的有限合成范围，不代表真实临床金标准。', 'Evidence supports only the stated synthetic scope, not a clinical gold standard.')}</p>
      {estimate.analysis.items.map(item => <p key={item.materialId}>{item.display} · {item.materialId} v{item.catalogVersion} · {item.quantity}{item.unit} · {formatFen(item.estimatedFen, locale)} · {item.reason}</p>)}
      {estimate.analysis.sources.materialEvidence.map(evidence => <div key={evidence.id}><p>{evidence.id} · {evidence.version} · {evidence.specification}</p><p>{evidence.scope}</p><p>{evidence.applicability}</p><p>{evidence.compatibility}</p><p>{evidence.quantityBasis}</p><p>{evidence.sourceLocator}</p></div>)}
    </details> : null}
    {editable ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={blocked || !current || ['queued', 'running', 'unknown'].includes(estimate.status) || editing !== null && (!fingerprintCurrent || !draftCurrent || !saveInput.success)} onClick={() => { void reestimate() }}>{t('重新预计，保留工作稿', 'Re-estimate and retain draft')}</Button>
      {['queued', 'running'].includes(estimate.status) ? <Button variant="outline" disabled={blocked || !current} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.cancel', input: common })}>{t('取消本次预计', 'Cancel this estimate')}</Button> : null}
      <Button variant="outline" disabled={blocked || !current || eligible.length === 0 || estimate.status === 'unknown'} onClick={() => adopt(eligible.map(candidate => ({ materialId: candidate.materialId,
        catalogVersion: candidate.catalogVersion, quantity: candidate.expectedQuantity!, reason: candidate.quantityBasis })), null)}>{t('从有效院内方案带入', 'Use verified hospital plan')}</Button>
    </div> : null}
    {estimate.candidateItems.length > 0 ? <section aria-label={t('新预计候选差异', 'New estimate candidates')} className="flex flex-col gap-2">
      <h6 className="font-medium">{t('新预计候选差异，尚未替换工作稿', 'New estimate candidates have not replaced the draft')}</h6>
      {estimate.candidateItems.map(item => <p key={item.materialId}>{item.display} · {item.quantity}{item.unit} · {item.reason} · {formatFen(item.estimatedFen, locale)}</p>)}
      {editable ? <Button variant="outline" disabled={blocked || !current || estimate.status !== 'succeeded' || estimate.analysis?.basisFingerprint !== estimate.basisFingerprint}
        onClick={() => adopt(estimate.candidateItems.map(({ materialId, catalogVersion, quantity, reason }) => ({ materialId, catalogVersion, quantity, reason })), estimate.analysis?.id ?? null)}>{t('采用新候选到工作稿', 'Apply new candidates to draft')}</Button> : null}
    </section> : null}
    <FieldSet disabled={fieldsBlocked}><FieldLegend>{t('未确认工作稿', 'Unconfirmed draft')}{draft ? ` v${draft.revision}` : ''}</FieldLegend><FieldGroup>
      {value.items.length === 0 ? <p>{t('工作稿暂无材料，可从有效院内方案带入或选择候选。', 'The draft is empty. Use a verified hospital plan or select candidates.')}</p> : null}
      {value.items.map((item, index) => {
        const candidate = candidates.find(candidate => candidate.materialId === item.materialId && candidate.catalogVersion === item.catalogVersion)
        const name = candidate?.item?.display ?? item.materialId
        const valid = candidate?.eligibility === 'valid' && candidate.expectedQuantity === Number(item.quantity)
        const quantity = Number(item.quantity), price = candidate?.item?.chargeDefinition.priceFen
        const amount = price === undefined || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(price * quantity) ? null : price * quantity
        const change = (patch: Partial<Editing['items'][number]>) => update({ items: value.items.map((value, position) => position === index ? { ...value, ...patch } : value) })
        return <FieldGroup key={item.materialId}>
          <p>{name} · {item.materialId} v{item.catalogVersion}</p>
          <p>{candidate?.evidence.specification} · {candidate?.item ? `${formatFen(candidate.item.chargeDefinition.priceFen, locale)}/${candidate.item.chargeDefinition.unit}` : t('目录版本不可用', 'Catalog version unavailable')}</p>
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
        <Field><FieldLabel htmlFor={`estimate-note-${estimate.requestId}`}>{t('工作稿说明', 'Draft note')}</FieldLabel><Input id={`estimate-note-${estimate.requestId}`} maxLength={2000} value={value.note} onChange={event => update({ note: event.currentTarget.value })} /></Field>
        {!draftCurrent ? <Alert><AlertDescription>
          <p>{t('已保存工作稿或生成结果已更新，当前输入仍保留。请核对最新内容，再保留当前编辑继续保存；过期生成关联将移除，材料和说明保留为人工稿。', 'The saved draft or generated result changed. Your input is retained. Review the latest contents before continuing; an outdated generated-result link will be removed while your items and note remain as a manual draft.')}</p>
          <p>{t('最新已保存说明：', 'Latest saved note: ')}{draft?.note || t('无说明', 'None')}</p>
          {draft?.items.map(item => <p key={item.materialId}>{item.materialId} v{item.catalogVersion} · {item.quantity} · {item.reason}</p>)}
          <Button variant="outline" disabled={blocked || !current} onClick={() => {
            update({ revision: draft?.revision ?? 0, analysisId: analysisCurrent ? value.analysisId : null }); setFailedSave(null); setReviewed(null)
          }}>{t('保留当前编辑并核对最新工作稿', 'Keep current edits after reviewing the latest draft')}</Button>
        </AlertDescription></Alert> : null}
        {!fingerprintCurrent ? <Alert><AlertDescription>{t('工作稿依据已变化，原编辑仍保留。核对当前目录、数量和缺项后再保存。', 'Draft sources changed; edits are retained. Review current catalog, quantities and missing facts before saving.')}
          <Button variant="outline" disabled={blocked || !current || !supported} onClick={() => update({ basisFingerprint: estimate.basisFingerprint, analysisId: null })}>{t('按当前依据核对工作稿', 'Review draft against current sources')}</Button>
        </AlertDescription></Alert> : null}
        {!supported && value.items.length > 0 ? <Alert><AlertDescription>{t('具体产品或数量尚未通过当前依据核对。可保存工作稿，核对通过前不能确认为预留。', 'The product or quantity is not verified against current evidence. You may save the draft; reservation confirmation requires verification.')}</AlertDescription></Alert> : null}
        <Button variant="outline" disabled={blocked || !current || !fingerprintCurrent || !draftCurrent || !saveInput.success || editing === null} onClick={() => { void save().catch(() => undefined) }}>{t('保存工作稿', 'Save draft')}</Button>
      </> : <p>{value.note}</p>}
    </FieldGroup></FieldSet>
    {saving ? <p role="status">{t('正在保存工作稿', 'Saving draft')}</p> : null}
    {failedSave === contentKey ? <Alert variant="destructive"><AlertDescription>{t('工作稿自动保存失败，编辑仍保留。请先恢复原操作，或手动保存。', 'Automatic draft save failed; edits are retained. Recover the original operation or save manually.')}</AlertDescription></Alert> : null}
    {draft ? <p>{t('服务端工作稿：', 'Saved draft: ')}v{draft.revision} · {draft.updatedAt}{editing ? t(' · 有未保存修改，停止输入后自动保存', ' · Unsaved changes; saves automatically after typing stops') : t(' · 已保存', ' · Saved')}</p> : null}
    <section aria-label={t('本计划有效预留', 'Active reservations for this plan')} className="flex flex-col gap-2">
      <h6 className="font-medium">{t('本计划有效预留', 'Active reservations for this plan')}</h6>
      {activeReservations.length === 0 ? <p>{t('本计划暂无有效预留。', 'This plan has no active reservations.')}</p> : activeReservations.map(reservation => <p key={reservation.id}>{reservation.materialDisplay} · {reservation.specification} · {reservation.remainingQuantity ?? reservation.quantity - reservation.consumedQuantity}{reservation.unit} · {formatFen(reservation.priceFen, locale)}/{reservation.unit ?? t('单位待核对', 'Unit unknown')} · {reservation.id} v{reservation.version}</p>)}
      {activeReservations.length > 0 ? <p>{t('再次确认将整批替代以上本计划预留，已发生使用与其他计划预留保留。', 'Confirmation replaces the reservations listed above as one batch. Actual use and other plans are retained.')}</p> : null}
    </section>
    {editable ? <FieldSet disabled={blocked}><FieldLegend>{t('整批审阅与确认', 'Batch review and confirmation')}</FieldLegend><FieldGroup>
      <Field orientation="horizontal"><Checkbox id={`estimate-review-${estimate.requestId}`} checked={reviewed === reviewKey} onCheckedChange={checked => setReviewed(checked ? reviewKey : null)} />
        <FieldLabel htmlFor={`estimate-review-${estimate.requestId}`}>{t('已核对材料、数量、依据及以上原预留处理', 'Reviewed materials, quantities, evidence and reservation changes')}</FieldLabel></Field>
      <Button disabled={blocked || !current || !canConfirm || reviewed !== reviewKey || !encounterVersion || confirmed} onClick={() => { void confirm() }}>{confirmed ? t('本版工作稿已确认', 'This draft revision is confirmed') : t('确认整批预留', 'Confirm reservation batch')}</Button>
    </FieldGroup></FieldSet> : <p>{t('当前岗位或病案状态只允许查看。', 'Your role or record state permits viewing only.')}</p>}
  </article>
}
