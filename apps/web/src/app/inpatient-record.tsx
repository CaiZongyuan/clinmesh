import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import type { inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { AlertCircleIcon, CheckCircle2Icon, CircleIcon } from 'lucide-react'
import { apiGet } from './api-client.ts'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { z } from 'zod'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { InpatientNumber } from './inpatient-number.tsx'
import { inpatientAdmissionConditionLabel, inpatientChargeCategoryLabel, inpatientDepartureLabel } from './inpatient-labels.ts'
import { patientAge } from './doctor/patient-summary.tsx'
import { useInpatientReviewDraft } from './inpatient-review-draft.ts'
import { ReviewDraftFailure } from './review-draft-failure.tsx'
import type { ReviewQueueCommand } from './inpatient-review-queue.ts'

function Kv({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="break-words text-sm font-medium">{children}</span>
  </div>
}

export type InpatientRecordPhase = 'none' | 'submitted' | 'returned' | 'stale' | 'approved' | 'archived'
/** 医生视角的病案首页进度：退回只算针对当前修订且来源未变的那次。 */
export function inpatientRecordPhase(data: z.infer<typeof inpatientRecordSchema>): InpatientRecordPhase {
  if (data.archive) return 'archived'
  if (!data.revision) return 'none'
  if (data.revision.sourcesHash !== data.sourcesHash) return 'stale'
  if (data.reviewCurrent) return 'approved'
  const last = data.reviews.at(-1)
  return last?.revision === data.revision.revision && last.outcome === 'returned' ? 'returned' : 'submitted'
}

type Stage = 'orders' | 'surgery' | 'fees' | 'discharge'
function RecordSection({ label, subtitle, link, children }: { label: string; subtitle?: string | undefined; link?: { label: string; onClick: (() => void) | undefined } | undefined; children: React.ReactNode }): React.JSX.Element {
  return <section role="region" aria-label={label} className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold">{label}</h4>
        {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
      </div>
      {link?.onClick ? <Button variant="link" size="sm" onClick={link.onClick}>{link.label}</Button> : null}
    </div>
    {children}
  </section>
}

export function InpatientRecord({ admission, session, locale, write, catalog, onOpenStage, onBeforeRecordAction, continuation }: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  catalog?: z.infer<typeof inpatientCatalogSchema> | undefined
  onOpenStage?: (stage: Stage) => void
  onBeforeRecordAction?: ((command: ReviewQueueCommand) => boolean) | undefined
  continuation?: React.ReactNode
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const record = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'record'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/record`, inpatientRecordSchema, signal) })
  const privateDraft = useInpatientReviewDraft(session, admission.patientId, admission.id, 'record')
  const { main: draft, setMain: setDraft, reason, setReason } = privateDraft
  const data = record.data, snapshot = data?.snapshot, archived = data?.archive !== undefined, doctor = session.actor.roleCode === 'inpatient-doctor', coder = session.actor.roleCode === 'medical-records'
  const expected = data ? { admissionId: admission.id, expectedRevision: data.revision?.revision ?? 0, expectedSourcesHash: data.sourcesHash } : null
  // 提交被拒（如来源或修订已被其他请求推进）后重读病案，才能看到新修订并放弃原选择。
  const submitFailed = write.mutation.isError && write.mutation.variables?.operation === 'inpatient.record.submit' && write.mutation.variables.input.admissionId === admission.id, refetchRecord = record.refetch
  useEffect(() => { if (submitFailed) void refetchRecord() }, [submitFailed, refetchRecord])
  const blocked = write.blocked || privateDraft.error || record.isFetching || archived
  const draftFailure = <ReviewDraftFailure key={admission.id} failure={privateDraft.failure} locked={write.blocked} retry={privateDraft.retry} discardUnread={privateDraft.discardUnread} zh={zh} />
  const reviewRecord = (outcome: 'approved' | 'returned') => {
    if (!expected) return
    const command = { operation: 'inpatient.record.review' as const, input: { ...expected, outcome, ...(reason.trim() ? { reason: reason.trim() } : {}) } }
    if (!privateDraft.prepare(command)) return
    if (onBeforeRecordAction?.(command) === false) return
    write.mutation.mutate(command)
  }
  const archiveRecord = () => {
    if (!expected) return
    const command = { operation: 'inpatient.record.archive' as const, input: expected }
    if (onBeforeRecordAction?.(command) === false) return
    write.mutation.mutate(command)
  }
  const wardName = (id: string | undefined) => catalog?.wards.find(ward => ward.id === id)?.name ?? t('病区未登记', 'Ward unavailable')
  const bedName = catalog?.beds.find(bed => bed.id === (admission.bedId ?? admission.lastBedId))?.name
  const gender = snapshot?.patient.gender
  const genderLabel = gender === 'female' ? t('女', 'Female') : gender === 'male' ? t('男', 'Male') : gender === 'other' ? t('其他', 'Other') : t('未记录', 'Not recorded')
  const departureMethod = snapshot?.stay.departureMethod
  const departureLabel = departureMethod ? inpatientDepartureLabel(departureMethod, locale) : t('尚未离院', 'Not discharged')
  const timestamp = (value: string | undefined) => value === undefined ? '—' : formatShanghaiMinute(value).slice(5)
  const birthDate = snapshot?.patient.birthDate ?? t('未记录', 'Not recorded')
  const ageRefDate = snapshot?.stay.admittedAt ? new Date(Date.parse(snapshot.stay.admittedAt) + 8 * 60 * 60 * 1000) : new Date(Date.parse(admission.registeredAt) + 8 * 60 * 60 * 1000)
  const age = snapshot?.patient.birthDate ? patientAge(snapshot.patient.birthDate, ageRefDate) : undefined
  const genderBirthDisplay = `${genderLabel}${age !== undefined && age >= 0 ? ` · ${t(`${age} 岁`, `${age}y`)}` : ''} · ${birthDate}`
  const stayDays = snapshot?.stay.admittedAt && snapshot?.stay.departedAt
    ? Math.max(1, Math.floor((Date.parse(snapshot.stay.departedAt) - Date.parse(snapshot.stay.admittedAt)) / 86_400_000) + 1)
    : undefined
  const coreFields = snapshot && data ? <div className="clinmesh-inpatient-preparation gap-3">
    <div className="text-xs font-semibold text-foreground">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</div>
    <RecordSection label={t('患者基本信息', 'Patient information')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{genderBirthDisplay}</Kv>
        <div>{data.recordNumber ? <InpatientNumber locale={locale} number={data.recordNumber} label={t('病案号', 'Record number')} /> : <Kv label={t('病案号', 'Record number')}>—</Kv>}</div>
      </div>
    </RecordSection>
    <RecordSection label={t('住院过程', 'Hospital stay')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div><InpatientNumber locale={locale} number={snapshot.stay.inpatientNumber} /></div>
        <Kv label={t('住院次数', 'Admission count')}>{snapshot.patient.admissionCount}</Kv>
        <Kv label={t('实际入科', 'Received at')}>{timestamp(snapshot.stay.admittedAt)}</Kv>
        <Kv label={t('入院病区', 'Initial ward')}>{wardName(snapshot.stay.initialWardId)}{bedName ? ` · ${bedName}` : ''}</Kv>
        <Kv label={t('实际离院', 'Departed at')}>{timestamp(snapshot.stay.departedAt)}</Kv>
        <Kv label={t('住院天数', 'Length of stay')}>{stayDays !== undefined ? t(`${stayDays} 天`, `${stayDays} days`) : '—'}</Kv>
        <Kv label={t('离院方式 / 出院病区', 'Departure method / discharge ward')}>{departureLabel} · {wardName(snapshot.stay.dischargeWardId)}{bedName ? ` · ${bedName}` : ''}</Kv>
        <Kv label={t('转科记录', 'Transfers')}>
          {snapshot.stay.transfers.length === 0 ? t('无', 'None')
            : snapshot.stay.transfers.map(item => `${wardName(item.sourceWardId)} → ${wardName(item.targetWardId)} · ${timestamp(item.receivedAt)}`).join('；')}
        </Kv>
      </div>
    </RecordSection>
    <RecordSection label={t('正式诊断与实际操作', 'Diagnoses and performed procedures')} subtitle={coder ? t('国家临床版 2022 · ICD-9-CM-3 临床版 3.0', 'Clinical edition 2022 · ICD-9-CM-3 3.0') : undefined}>
      <div className="flex flex-col gap-2">
        {snapshot.clinical.diagnosis.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无正式诊断', 'No formal diagnosis')}</p> : snapshot.clinical.diagnosis.entries.map(entry => <div key={entry.conditionId} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={entry.role === 'primary' ? 'default' : 'outline'}>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge>
            <span className="text-sm font-medium">{entry.coding.code} {entry.coding.display}</span>
            <span className="text-xs text-muted-foreground">{t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}</span>
          </div>
          {coder && !entry.coding.releaseId ? <span className="text-xs text-muted-foreground">{t('诊断来源待核对，暂不能审核归档。', 'Confirm the diagnosis source before review and archive.')}</span> : null}
        </div>)}
        {snapshot.clinical.operations.length === 0 ? <p className="text-sm text-muted-foreground">{t('本次无已实施操作', 'No performed procedure in this admission')}</p> : snapshot.clinical.operations.map(item => <div key={item.id} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.primary ? 'default' : 'outline'}>{item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')}</Badge>
            <span className="text-sm font-medium">{item.actualProcedure.coding.code} {item.actualProcedure.coding.display}</span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{timestamp(item.performedAt)}{item.performedBy ? ` · ${item.performedBy}` : ''}</span>
        </div>)}
        {coder ? <details className="clinmesh-inpatient-disclosure"><summary>{t('查看编码与上报范围', 'Coding and reporting scope')}</summary><p className="text-xs text-muted-foreground">{t('诊断采用固定临床版2022来源（原始工作簿权威身份尚未独立验证）；操作采用临床版3.0固定有界摘录。核心字段集不能直接用于国家首页或医保清单上报。', 'Diagnosis uses the fixed 2022 clinical source, whose original workbook authority is not independently verified; procedures use a bounded 3.0 excerpt. This core set is not a national reporting dataset.')}</p></details> : null}
      </div>
    </RecordSection>
    <RecordSection label={t('病案费用', 'Record fees')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Kv label={t('医疗费用合计', 'Net medical charges')}>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
        {Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <Kv key={kind} label={inpatientChargeCategoryLabel(kind, locale)}>{formatFen(amount, locale)}</Kv>)}
        <Kv label={t('结算', 'Settlement')}>{timestamp(snapshot.fees.settlement?.settledAt)}</Kv>
      </div>
    </RecordSection>
    {data.revision || data.reviews.length > 0 || archived || coder ? <RecordSection label={t('审核与归档记录', 'Review and archive history')}>
      <div className="flex flex-col gap-2">
        {data.revision ? <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t(`第 ${data.revision.revision} 次提交`, `Submission #${data.revision.revision}`)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{timestamp(data.revision.recordedAt)}</span>
        </div> : null}
        {data.reviews.length === 0 && !data.revision ? <p className="text-sm text-muted-foreground">{t('暂无编码审核记录', 'No coding review yet')}</p> : data.reviews.map(review => <div key={review.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Badge variant={review.outcome === 'approved' ? 'success' : 'destructive'}>{review.outcome === 'approved' ? t('审核通过', 'Approved') : t('退回', 'Returned')}</Badge>
          <span className="text-muted-foreground">{t(`第 ${review.revision} 次提交`, `Submission #${review.revision}`)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{timestamp(review.recordedAt)}{review.reason ? ` · ${review.reason}` : ''}</span>
        </div>)}
        {archived ? <p className="text-sm text-muted-foreground">{t('归档', 'Archived')} <span className="tabular-nums">{timestamp(data.archive!.recordedAt)}</span></p> : null}
        {coder && !archived && data.revision && !data.reviewCurrent ? <Field className="pt-1">
          <FieldLabel htmlFor="inpatient-record-return-reason">{t('编码审核说明', 'Coding review note')}</FieldLabel>
          <Textarea id="inpatient-record-return-reason" disabled={write.blocked || privateDraft.failure === 'read'} rows={2} value={reason} maxLength={2000} placeholder={t('退回医生修订时必填；审核通过选填', 'Required when returning to physician; optional when approving')} onChange={event => setReason(event.currentTarget.value)} />
        </Field> : null}
      </div>
    </RecordSection> : null}
  </div> : null
  const phase = data ? inpatientRecordPhase(data) : 'none'
  const operations = snapshot?.clinical.operations ?? []
  const editable = phase === 'none' || phase === 'returned' || phase === 'stale'
  const previousMain = snapshot?.clinical.mainProcedureExecutionId ?? null
  const selectedMain = draft?.main ?? (previousMain && operations.some(item => item.id === previousMain) ? previousMain : null)
  const settled = admission.financialStatus === 'settled'
  const open = (stage: Stage) => !archived && onOpenStage ? () => onOpenStage(stage) : undefined
  if (doctor) {
    const entries = snapshot?.clinical.diagnosis.entries ?? [], primaries = entries.filter(entry => entry.role === 'primary')
    const unsourced = entries.filter(entry => !entry.coding.releaseId).length
    const lastReview = data?.reviews.at(-1)
    const checks: Array<{ key: string; done: boolean; title: string; owner: string; detail: string; go?: { label: string; stage: Stage } }> = [
      { key: 'primary', done: primaries.length === 1, title: t('主诊断', 'Primary diagnosis'), owner: primaries.length === 1 ? '' : t('你', 'You'),
        detail: primaries.length === 1 ? `${primaries[0]!.coding.display}（${primaries[0]!.coding.code}）· ${t('唯一', 'unique')}` : primaries.length === 0 ? t('尚无主诊断', 'No primary diagnosis yet') : t(`有 ${primaries.length} 项主诊断，只能保留 1 项`, `${primaries.length} primary diagnoses; keep one`),
        ...(primaries.length === 1 ? {} : { go: { label: t('去诊断医嘱', 'Open orders'), stage: 'orders' as const } }) },
      { key: 'coding', done: entries.length > 0 && unsourced === 0, title: t('诊断编码', 'Diagnosis coding'), owner: entries.length > 0 && unsourced === 0 ? '' : t('你', 'You'),
        detail: entries.length === 0 ? t('尚无正式诊断', 'No formal diagnosis yet') : unsourced === 0 ? t('均来自固定临床版 2022', 'All from the fixed 2022 clinical edition') : t(`${unsourced} 项诊断来源待核对`, `${unsourced} diagnosis sources need review`),
        ...(entries.length > 0 && unsourced === 0 ? {} : { go: { label: t('去诊断医嘱', 'Open orders'), stage: 'orders' as const } }) },
      { key: 'departure', done: snapshot?.stay.departureMethod !== undefined, title: t('离院信息', 'Departure'), owner: snapshot?.stay.departureMethod ? '' : t('病区护士', 'Ward nurse'),
        detail: snapshot?.stay.departureMethod ? `${inpatientDepartureLabel(snapshot.stay.departureMethod, locale)} · ${snapshot.stay.departedAt ? formatShanghaiMinute(snapshot.stay.departedAt).slice(5) : ''}` : t('护士办理离院后自动带入', 'Filled in when the ward nurse records departure'),
        ...(snapshot?.stay.departureMethod ? {} : { go: { label: t('去出院', 'Open discharge'), stage: 'discharge' as const } }) },
      { key: 'main', done: operations.length > 0 && selectedMain !== null, title: t('主操作', 'Primary procedure'), owner: t('你 · 提交时', 'You, at submission'),
        detail: operations.length === 0 ? t('尚无已实施操作；做了手术的，提交时要选定 1 项主操作', 'No performed procedure yet; choose one primary procedure at submission when surgery is done') : t(`${operations.length} 项已实施操作，提交时选定 1 项主操作`, `${operations.length} performed procedures; choose one at submission`),
        ...(operations.length === 0 ? { go: { label: t('去手术', 'Open surgery'), stage: 'surgery' as const } } : {}) },
      { key: 'fees', done: false, title: t('费用', 'Charges'), owner: t('收费员', 'Cashier'), detail: `${t('当前累计 ', 'Current charges ')}${formatFen(snapshot?.fees.chargesFen ?? 0, locale)} · ${t('结算后费用固定；结算前有变化都要重新提交', 'Charges are fixed at settlement; any earlier change needs resubmission')}`,
        go: { label: t('看费用', 'Open charges'), stage: 'fees' as const } },
    ]
    const history = data ? [
      ...data.revision ? [{ at: data.revision.recordedAt, text: t(`第 ${data.revision.revision} 次提交首页`, `You submitted the record (#${data.revision.revision})`) }] : [],
      ...data.reviews.map(review => ({ at: review.recordedAt, text: review.outcome === 'approved' ? t('病案人员编码审核通过', 'Medical records approved coding') : `${t('病案人员退回：', 'Returned by medical records: ')}${review.reason ?? ''}` })),
      ...data.archive ? [{ at: data.archive.recordedAt, text: t('病案人员归档', 'Archived by medical records') }] : [],
    ].sort((a, b) => a.at.localeCompare(b.at)) : []
    const mainPicker = operations.length > 0 && editable ? <>
      <div role="radiogroup" aria-label={t('本次主操作', 'Primary procedure')} className="flex flex-col gap-1.5">{operations.map(item => <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-muted">
        <input type="radio" name={`inpatient-record-main-${admission.id}`} aria-label={`${item.actualProcedure.coding.code} ${item.actualProcedure.coding.display}`} value={item.id} checked={selectedMain === item.id} disabled={blocked}
          onChange={() => setDraft(current => ({ main: item.id, revision: current?.revision ?? expected!.expectedRevision, hash: current?.hash ?? expected!.expectedSourcesHash }))} />
        <span className="font-medium">{item.actualProcedure.coding.code} {item.actualProcedure.coding.display}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatShanghaiMinute(item.performedAt).slice(5)}{item.performedBy ? ` · ${item.performedBy}` : ''}</span></label>)}</div>
      <p className="text-xs text-muted-foreground">{t('选一项作为本次主操作。DRG 分组按这里的主操作计算。', 'Choose one primary procedure. DRG grouping uses it.')}</p>
    </> : <div className="grid gap-2 text-sm">{operations.length === 0 ? <span className="text-muted-foreground">{t('本次无已实施操作', 'No performed procedure in this admission')}</span>
      : operations.map(item => <Kv key={item.id} label={item.id === previousMain || item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')}>{item.actualProcedure.coding.code} {item.actualProcedure.coding.display} · {formatShanghaiMinute(item.performedAt).slice(5)}{item.performedBy ? ` · ${item.performedBy}` : ''}</Kv>)}</div>
    const fields = snapshot && data ? <div role="region" aria-label={t('病案首页核心字段', 'Record core fields')} className="clinmesh-inpatient-preparation gap-3">
      <RecordSection label={t('患者基本信息', 'Patient information')}><div className="grid gap-3 sm:grid-cols-3">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{genderBirthDisplay}</Kv>
        <div>{data.recordNumber ? <InpatientNumber locale={locale} number={data.recordNumber} label={t('病案号', 'Record number')} /> : <Kv label={t('病案号', 'Record number')}>—</Kv>}</div>
      </div></RecordSection>
      <RecordSection label={t('住院过程', 'Hospital stay')}><div className="grid gap-3 sm:grid-cols-3">
        <div><InpatientNumber locale={locale} number={snapshot.stay.inpatientNumber} /></div>
        <Kv label={t('住院次数', 'Admission count')}>{snapshot.patient.admissionCount}</Kv>
        <Kv label={t('实际入科', 'Received at')}>{snapshot.stay.admittedAt ? formatShanghaiMinute(snapshot.stay.admittedAt).slice(5) : '—'}</Kv>
        <Kv label={t('入院病区', 'Initial ward')}>{wardName(snapshot.stay.initialWardId)}{bedName ? ` · ${bedName}` : ''}</Kv>
        <Kv label={t('实际离院', 'Departed at')}>{snapshot.stay.departedAt ? formatShanghaiMinute(snapshot.stay.departedAt).slice(5) : '—'}</Kv>
        <Kv label={t('住院天数', 'Length of stay')}>{stayDays !== undefined ? t(`${stayDays} 天`, `${stayDays} days`) : '—'}</Kv>
        <Kv label={t('离院方式 / 出院病区', 'Departure method / discharge ward')}>{departureLabel} · {wardName(snapshot.stay.dischargeWardId)}{bedName ? ` · ${bedName}` : ''}</Kv>
        <Kv label={t('转科', 'Transfers')}>{snapshot.stay.transfers.length === 0 ? t('无', 'None') : snapshot.stay.transfers.map(item => `${wardName(item.sourceWardId)} → ${wardName(item.targetWardId)}`).join('；')}</Kv>
        <Kv label={t('离院后 31 天内再住院计划', '31-day readmission plan')}>{t('无', 'None')}</Kv>
      </div></RecordSection>
      <RecordSection label={t('正式诊断', 'Formal diagnoses')} subtitle={t('国家临床版 2022', 'National clinical edition 2022')} link={!archived ? { label: t('去诊断医嘱', 'Open orders'), onClick: open('orders') } : undefined}><div className="grid gap-2">
        {entries.length === 0 ? <span className="text-sm text-muted-foreground">{t('暂无正式诊断', 'No formal diagnosis')}</span> : entries.map(entry => <Kv key={entry.conditionId} label={entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}>
          {entry.coding.code} {entry.coding.display} · {t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}{entry.coding.releaseId ? '' : ` · ${t('来源待核对', 'source needs review')}`}</Kv>)}
      </div></RecordSection>
      <RecordSection label={operations.length > 0 && editable ? t('实际操作 · 确认本次主操作', 'Performed procedures · confirm primary') : t('实际操作', 'Performed procedures')} subtitle={t('ICD-9-CM-3 临床版 3.0', 'ICD-9-CM-3 clinical edition 3.0')} link={!archived ? { label: t('去手术', 'Open surgery'), onClick: open('surgery') } : undefined}><div className="flex flex-col gap-2">
        {mainPicker}
      </div></RecordSection>
      <RecordSection label={t('病案费用', 'Record fees')} link={!archived ? { label: t('逐笔明细在「费用」页签', 'Itemised charges are under Charges'), onClick: open('fees') } : undefined}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Kv label={t('医疗费用合计', 'Net medical charges')}>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
          {Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <Kv key={kind} label={inpatientChargeCategoryLabel(kind, locale)}>{formatFen(amount, locale)}</Kv>)}
          <Kv label={t('结算', 'Settlement')}>{snapshot.fees.settlement ? formatShanghaiMinute(snapshot.fees.settlement.settledAt).slice(5) : t('未结算', 'Not settled')}</Kv>
        </div>
      </RecordSection>
    </div> : null
    const submitBlocked = blocked || !settled || (operations.length > 0 && !selectedMain)
    const submitLabel = phase === 'none' ? t('提交病案首页', 'Submit record') : t('重新提交病案首页', 'Resubmit record')
    const submitReason = admission.status === 'registered' ? t('患者待入科，接诊后再提交。', 'Receive the patient before submitting.')
      : !settled ? t('出院结算后才能提交', 'Submit after discharge settlement')
        : operations.length > 0 && !selectedMain ? t('还差：确认本次主操作', 'Confirm the primary procedure')
          : t('提交后交病案人员编码审核', 'Medical records reviews coding next')
    const submitAction = () => {
      if (!expected) return
      const command = { operation: 'inpatient.record.submit' as const, input: { ...expected, expectedRevision: draft?.revision ?? expected.expectedRevision, expectedSourcesHash: draft?.hash ?? expected.expectedSourcesHash, mainProcedureExecutionId: selectedMain } }
      if (privateDraft.prepare(command)) write.mutation.mutate(command)
    }
    return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-3">
      {draftFailure}
      <h3 className="sr-only">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
      {record.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {record.error ? <Alert variant="destructive"><AlertDescription>{t('病案读取失败：', 'Medical record failed to load: ')}{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void record.refetch()}>{t('重试病案', 'Retry medical record')}</Button></AlertDescription></Alert> : null}
      {snapshot && data ? <>
        {phase === 'returned' && lastReview ? <div role="status" className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"><b className="text-warning">{t('病案人员退回', 'Returned by medical records')} · {formatShanghaiMinute(lastReview.recordedAt).slice(5)}</b><span>{lastReview.reason}</span></div>
          : phase === 'stale' ? <div role="status" className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"><b className="text-warning">{t('提交后来源有变化', 'Sources changed after submission')}</b><span>{t('诊断、操作或费用在提交后有变化。病案人员只能审核最新内容，请核对后重新提交。', 'Diagnoses, procedures or charges changed after submission. Medical records can only review the latest content, so review and resubmit.')}</span></div> : null}
        {!settled ? <>
          <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"><AlertCircleIcon aria-hidden="true" className="size-4 shrink-0" />{admission.status === 'departed'
            ? t('患者已离院，等收费员结算。结算后费用固定，再提交病案首页。下面是提交时要满足的条件。', 'The patient has departed and awaits settlement. Submit the record once charges are fixed. These are the submission conditions.')
            : t('患者在院中。离院和结算前，离院信息与费用还会变，现在提交病案人员也无法审核通过。下面是提交时要满足的条件，可以提前处理诊断。', 'The patient is still in hospital. Departure and charges will change before settlement, so medical records cannot approve a submission yet. These are the conditions; diagnoses can be handled now.')}</p>
          <section aria-label={t('提交首页前', 'Before submitting')} className="clinmesh-inpatient-preparation">
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{t('提交首页前', 'Before submitting')}</h4><Badge variant="outline">{t('出院结算后提交', 'Submit after settlement')}</Badge></div>
            <ul className="clinmesh-inpatient-preparation-list">{checks.map(item => <li key={item.key} data-complete={item.done}>
              {item.done ? <CheckCircle2Icon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
              <div><strong>{item.title}</strong><span className="text-muted-foreground">{item.detail}</span></div>
              <div className="clinmesh-inpatient-preparation-owner">
                {item.owner ? <span>{item.owner}</span> : null}
                {item.go && onOpenStage ? <Button variant="link" size="sm" onClick={() => onOpenStage(item.go!.stage)}>{item.go.label}</Button> : null}
              </div>
            </li>)}</ul>
          </section>
        </> : fields}
        {settled && history.length > 0 ? <section aria-label={t('提交与审核记录', 'Submission and review history')} className="clinmesh-inpatient-preparation"><h4 className="font-medium">{t('提交与审核记录', 'Submission and review history')}</h4>
          <ul className="clinmesh-inpatient-preparation-list">{history.map(item => <li key={`${item.at}-${item.text}`} className="!grid-cols-[auto_minmax(0,1fr)]"><time className="tabular-nums text-muted-foreground" dateTime={item.at}>{formatShanghaiMinute(item.at).slice(5)}</time><span>{item.text}</span></li>)}</ul></section> : null}
        {!settled && data.revision ? <p className="text-sm text-muted-foreground">{t(`第 ${data.revision.revision} 次提交 · ${formatShanghaiMinute(data.revision.recordedAt).slice(5)}`, `Submission #${data.revision.revision} · ${formatShanghaiMinute(data.revision.recordedAt).slice(5)}`)}</p> : null}
        {settled ? <p className="text-xs text-muted-foreground">{t('核心字段集用于本系统审核归档，不能直接用于国家首页或医保清单上报。', 'The core field set supports review and archive here; it is not a national record or insurance reporting dataset.')}</p> : null}
        <InpatientPrimaryAction stage="record">{phase === 'archived'
          ? <WorkspaceActionBar tone="complete" reason={t('病案已归档，只读可查', 'Archived record is read only')} />
          : editable ? <WorkspaceActionBar tone={submitBlocked ? 'blocked' : 'normal'} reason={submitReason}
            action={<>{draft && (draft.hash !== data.sourcesHash || draft.revision !== (data.revision?.revision ?? 0)) ? <Button variant="outline" onClick={() => setDraft(null)}>{t('放弃原主操作选择，重新审阅来源', 'Discard selection and review updated sources')}</Button> : null}
              <Button disabled={submitBlocked} onClick={submitAction}>{submitLabel}</Button></>} />
            : <WorkspaceActionBar showWithoutAction reason={phase === 'approved' ? t('编码审核通过，等病案人员归档', 'Coding approved; waiting for medical records to archive')
              : t('等病案人员编码审核；诊断、操作或费用变化后需要重新提交', 'Waiting for coding review; resubmit if diagnoses, procedures or charges change')} />}</InpatientPrimaryAction>
      </> : null}
    </section>
  }
  return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-4">
  {draftFailure}
  {continuation}
  <div className="flex flex-col gap-3">
    <h3 className="sr-only">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
    {record.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {record.error ? <Alert variant="destructive"><AlertDescription>{t('病案读取失败：', 'Medical record failed to load: ')}{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void record.refetch()}>{t('重试病案', 'Retry medical record')}</Button></AlertDescription></Alert> : null}
    {snapshot && data ? <>
     {archived ? <InpatientPrimaryAction stage="record"><WorkspaceActionBar tone="complete" reason={t('病案已归档，只读可查', 'Archived record is read only')} /></InpatientPrimaryAction> : null}
     {coder && !archived && data.revision && data.reviewCurrent && data.revision.sourcesHash === data.sourcesHash ? <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">✓ {t('编码审核已通过，核对无误后可归档病案；归档后病案与分组结果锁定为只读', 'Coding review passed; verify and archive the record. Once archived, the record and grouping result are locked as read-only')}</p> : null}
     {data.revision && data.revision.sourcesHash !== data.sourcesHash ? <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{t('来源已变化，请医生重新审阅并提交首页修订', 'Sources changed; physician must review and resubmit')}</p> : null}
     {coreFields}
     {coder && !archived && data.revision ? <>
        {!data.reviewCurrent ? <InpatientPrimaryAction stage="record" priority={10}>
          <WorkspaceActionBar tone={blocked || data.revision.sourcesHash !== data.sourcesHash ? 'blocked' : 'normal'} reason={data.revision.sourcesHash !== data.sourcesHash ? t('等住院医生重新核对并提交首页。', 'Wait for the inpatient doctor to review and resubmit the record.') : t('核对诊断与操作编码后通过或退回', 'Review diagnosis and procedure coding, then approve or return')}
            action={<><Button variant="outline" disabled={blocked || !reason.trim() || data.revision.sourcesHash !== data.sourcesHash} onClick={() => reviewRecord('returned')}>{t('退回医生修订', 'Return to physician')}</Button><Button disabled={blocked || data.revision.sourcesHash !== data.sourcesHash} onClick={() => reviewRecord('approved')}>{t('编码审核通过', 'Approve coding')}</Button></>} />
        </InpatientPrimaryAction> : <InpatientPrimaryAction stage="record" priority={10}>
          <WorkspaceActionBar tone={blocked || admission.status !== 'cleared' || admission.financialStatus !== 'settled' ? 'blocked' : 'normal'}
            reason={admission.financialStatus !== 'settled' ? t('等收费员结算后归档。', 'Wait for cashier settlement before archiving.') : admission.status !== 'cleared' ? t('等病区护士清床后归档。', 'Wait for the ward nurse to clear the bed before archiving.') : t('编码审核已通过，可归档病案', 'Coding review passed; ready to archive')}
            action={<Button disabled={blocked || admission.status !== 'cleared' || admission.financialStatus !== 'settled'} onClick={archiveRecord}>{t('归档病案', 'Archive record')}</Button>} />
        </InpatientPrimaryAction>}
     </> : null}
    </> : null}
   </div>
 </section>
}
