import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import type { inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import { InpatientFinancialAdjustments } from './inpatient-financial-adjustments.tsx'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
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

type Stage = 'orders' | 'surgery' | 'fees'
function RecordSection({ label, link, children }: { label: string; link?: { label: string; onClick: (() => void) | undefined }; children: React.ReactNode }): React.JSX.Element {
  return <section role="region" aria-label={label} className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{label}</h4>
      {link?.onClick ? <Button variant="link" size="sm" onClick={link.onClick}>{link.label}</Button> : null}</div>
    {children}
  </section>
}

export function InpatientRecord({ admission, session, locale, write, catalog, onOpenStage }: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  catalog?: z.infer<typeof inpatientCatalogSchema> | undefined
  onOpenStage?: (stage: Stage) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const record = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'record'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/record`, inpatientRecordSchema, signal) })
  const [draft, setDraft] = useState<{
    main: string | null
    revision: number
    hash: string
  } | null>(null), [reason, setReason] = useState('')
  const data = record.data, snapshot = data?.snapshot, archived = data?.archive !== undefined, doctor = session.actor.roleCode === 'inpatient-doctor', coder = session.actor.roleCode === 'medical-records'
  const expected = data ? { admissionId: admission.id, expectedRevision: data.revision?.revision ?? 0, expectedSourcesHash: data.sourcesHash } : null
  const result = write.mutation.data
  useEffect(() => {
    if (draft && result?.command?.operation === 'inpatient.record.submit'
      && result.command.input.admissionId === admission.id
      && result.command.input.expectedRevision === draft.revision
      && result.command.input.expectedSourcesHash === draft.hash
      && result.command.input.mainProcedureExecutionId === draft.main
      && (data?.revision?.revision ?? 0) > draft.revision) setDraft(null)
  }, [admission.id, data?.revision?.revision, draft, result])
  // 提交被拒（如来源或修订已被其他请求推进）后重读病案，才能看到新修订并放弃原选择。
  const submitFailed = write.mutation.isError && write.mutation.variables?.operation === 'inpatient.record.submit', refetchRecord = record.refetch
  useEffect(() => { if (submitFailed) void refetchRecord() }, [submitFailed, refetchRecord])
  const blocked = write.blocked || record.isFetching || archived
  const wardName = (id: string | undefined) => catalog?.wards.find(ward => ward.id === id)?.name ?? t('病区未登记', 'Ward unavailable')
  const gender = snapshot?.patient.gender
  const genderLabel = gender === 'female' ? t('女', 'Female') : gender === 'male' ? t('男', 'Male') : gender === 'other' ? t('其他', 'Other') : t('未记录', 'Not recorded')
  const departureMethod = snapshot?.stay.departureMethod
  const departureLabel = departureMethod ? inpatientDepartureLabel(departureMethod, locale) : t('尚未离院', 'Not discharged')
  const timestamp = (value: string | undefined) => value === undefined ? '—' : formatShanghaiMinute(value)
  const birthDate = snapshot?.patient.birthDate ? new Date(`${snapshot.patient.birthDate}T00:00:00+08:00`).toLocaleDateString(locale, { timeZone: 'Asia/Shanghai' }) : t('未记录', 'Not recorded')
  const coreFields = snapshot && data ? <>
     <div className="clinmesh-inpatient-record-sections">
      <Card role="region" size="sm" aria-label={t('患者基本信息', 'Patient information')}>
       <CardHeader className="border-b"><CardTitle>{t('患者基本信息', 'Patient information')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{genderLabel} · {birthDate}</Kv>
        <div>{data.recordNumber ? <InpatientNumber locale={locale} number={data.recordNumber} label={t('病案号', 'Record number')} /> : <Kv label={t('病案号', 'Record number')}>—</Kv>}</div>
        <div><InpatientNumber locale={locale} number={snapshot.stay.inpatientNumber} /></div>
        <Kv label={t('住院次数', 'Admission count')}>{snapshot.patient.admissionCount}</Kv>
       </CardContent>
      </Card>
      <Card role="region" size="sm" aria-label={t('住院过程', 'Hospital stay')}>
       <CardHeader className="border-b"><CardTitle>{t('住院过程', 'Hospital stay')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('实际入科', 'Received at')}>{timestamp(snapshot.stay.admittedAt)}</Kv>
        <Kv label={t('入院病区', 'Initial ward')}>{wardName(snapshot.stay.initialWardId)}</Kv>
        <Kv label={t('实际离院', 'Departed at')}>{timestamp(snapshot.stay.departedAt)}</Kv>
        <Kv label={t('离院方式 / 出院病区', 'Departure method / discharge ward')}>{departureLabel} · {wardName(snapshot.stay.dischargeWardId)}</Kv>
        <div className="flex flex-col gap-1 sm:col-span-2">
         <span className="text-xs text-muted-foreground">{t('转科记录', 'Transfers')}</span>
         {snapshot.stay.transfers.length === 0 ? <span className="text-sm">{t('无', 'None')}</span>
          : snapshot.stay.transfers.map(item => <span key={item.id} className="break-words text-sm">{wardName(item.sourceWardId)} → {wardName(item.targetWardId)} · {timestamp(item.receivedAt)}</span>)}
        </div>
       </CardContent>
      </Card>
      <Card role="region" size="sm" aria-label={t('正式诊断与实际操作', 'Diagnoses and performed procedures')}>
       <CardHeader className="border-b"><CardTitle>{t('正式诊断与实际操作', 'Diagnoses and performed procedures')}</CardTitle></CardHeader>
       <CardContent className="flex flex-col gap-2">
        {snapshot.clinical.diagnosis.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无正式诊断', 'No formal diagnosis')}</p> : snapshot.clinical.diagnosis.entries.map(entry => <div key={entry.conditionId} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
           <Badge variant={entry.role === 'primary' ? 'default' : 'outline'}>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge>
           <span className="text-sm font-medium">{entry.coding.code} {entry.coding.display}</span>
           <span className="text-xs text-muted-foreground">{t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}</span>
          </div>
          {!entry.coding.releaseId ? <span className="text-xs text-muted-foreground">{t('诊断来源待核对，暂不能审核归档。', 'Confirm the diagnosis source before review and archive.')}</span> : null}
         </div>)}
        {snapshot.clinical.operations.length === 0 ? <p className="text-sm text-muted-foreground">{t('本次无已实施操作', 'No performed procedure in this admission')}</p> : snapshot.clinical.operations.map(item => <div key={item.id} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
           <Badge variant={item.primary ? 'default' : 'outline'}>{item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')}</Badge>
           <span className="text-sm font-medium">{item.actualProcedure.coding.code} {item.actualProcedure.coding.display}</span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{timestamp(item.performedAt)}</span>
         </div>)}
        <details className="clinmesh-inpatient-disclosure"><summary>{t('查看编码与上报范围', 'Coding and reporting scope')}</summary><p className="text-xs text-muted-foreground">{t('诊断采用固定临床版2022来源（原始工作簿权威身份尚未独立验证）；操作采用临床版3.0固定有界摘录。核心字段集不能直接用于国家首页或医保清单上报。', 'Diagnosis uses the fixed 2022 clinical source, whose original workbook authority is not independently verified; procedures use a bounded 3.0 excerpt. This core set is not a national reporting dataset.')}</p></details>
       </CardContent>
      </Card>
      <Card role="region" size="sm" aria-label={t('病案费用', 'Record fees')}>
       <CardHeader className="border-b"><CardTitle>{t('病案费用', 'Record fees')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('医疗费用合计', 'Net medical charges')}>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
        <Kv label={t('预交金（独立资金）', 'Deposit (separate funds)')}>{formatFen(snapshot.fees.depositFen, locale)}</Kv>
        {Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <Kv key={kind} label={inpatientChargeCategoryLabel(kind, locale)}>{formatFen(amount, locale)}</Kv>)}
        <div className="flex flex-col gap-1 sm:col-span-2">
         <span className="text-xs text-muted-foreground">{t('费用明细', 'Charge items')}</span>
         {snapshot.fees.charges.length === 0 ? <span className="text-sm">{t('无', 'None')}</span>
          : snapshot.fees.charges.map(item => <span key={item.id} className="break-all text-sm">{item.label} · {formatFen(item.amountFen, locale)}{item.reversalOf ? ` · ${t('退费', 'Charge correction')}` : ''}</span>)}
        </div>
        <Kv label={t('结算', 'Settlement')}>{timestamp(snapshot.fees.settlement?.settledAt)}</Kv>
       </CardContent>
      </Card>
     </div>
     {data.reviews.length > 0 || archived ? <Card role="region" size="sm" aria-label={t('审核与归档记录', 'Review and archive history')}>
      <CardHeader className="border-b"><CardTitle>{t('审核与归档记录', 'Review and archive history')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
       {data.reviews.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无编码审核记录', 'No coding review yet')}</p> : data.reviews.map(review => <div key={review.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
         <Badge variant={review.outcome === 'approved' ? 'success' : 'destructive'}>{review.outcome === 'approved' ? t('审核通过', 'Approved') : t('退回', 'Returned')}</Badge>
         <span className="text-muted-foreground">{t(`第 ${review.revision} 次提交`, `Submission #${review.revision}`)}</span>
         <span className="text-xs tabular-nums text-muted-foreground">{timestamp(review.recordedAt)}{review.reason ? ` · ${review.reason}` : ''}</span>
        </div>)}
       {archived ? <p className="text-sm text-muted-foreground">{t('归档', 'Archived')} <span className="tabular-nums">{timestamp(data.archive!.recordedAt)}</span></p> : null}
      </CardContent>
     </Card> : null}
  </> : null
  const phase = data ? inpatientRecordPhase(data) : 'none'
  const operations = snapshot?.clinical.operations ?? []
  const editable = phase === 'none' || phase === 'returned' || phase === 'stale'
  const previousMain = snapshot?.clinical.mainProcedureExecutionId ?? null
  const selectedMain = draft?.main ?? (previousMain && operations.some(item => item.id === previousMain) ? previousMain : null)
  const settled = admission.financialStatus === 'settled'
  const open = (stage: Stage) => onOpenStage ? () => onOpenStage(stage) : undefined
  if (doctor) {
    const entries = snapshot?.clinical.diagnosis.entries ?? [], primaries = entries.filter(entry => entry.role === 'primary')
    const unsourced = entries.filter(entry => !entry.coding.releaseId).length
    const lastReview = data?.reviews.at(-1)
    const checks = [
      { key: 'stay', done: snapshot?.stay.admittedAt !== undefined, title: t('患者基本信息与住院过程', 'Patient and stay information'), owner: snapshot?.stay.admittedAt ? t('自动汇总', 'Auto-collected') : t('病区护士', 'Ward nurse'),
        detail: snapshot?.stay.admittedAt ? `${t('住院号 ', 'Inpatient No. ')}${snapshot.stay.inpatientNumber} · ${t('入科 ', 'Admitted ')}${formatShanghaiMinute(snapshot.stay.admittedAt)}` : t('接诊后自动带入', 'Filled after reception') },
      { key: 'primary', done: primaries.length === 1, title: t('主诊断', 'Primary diagnosis'), owner: primaries.length === 1 ? '' : t('你', 'You'),
        detail: primaries.length === 1 ? `${primaries[0]!.coding.display}（${primaries[0]!.coding.code}）· ${t('唯一', 'unique')}` : primaries.length === 0 ? t('尚无主诊断', 'No primary diagnosis yet') : t(`有 ${primaries.length} 项主诊断，只能保留 1 项`, `${primaries.length} primary diagnoses; keep one`) },
      { key: 'coding', done: entries.length > 0 && unsourced === 0, title: t('诊断编码', 'Diagnosis coding'), owner: entries.length > 0 && unsourced === 0 ? '' : t('你', 'You'),
        detail: entries.length === 0 ? t('尚无正式诊断', 'No formal diagnosis yet') : unsourced === 0 ? t('均来自固定临床版 2022', 'All from the fixed 2022 clinical edition') : t(`${unsourced} 项诊断来源待核对`, `${unsourced} diagnosis sources need review`) },
      { key: 'departure', done: snapshot?.stay.departureMethod !== undefined, title: t('离院信息', 'Departure'), owner: snapshot?.stay.departureMethod ? '' : t('病区护士', 'Ward nurse'),
        detail: snapshot?.stay.departureMethod ? `${inpatientDepartureLabel(snapshot.stay.departureMethod, locale)} · ${snapshot.stay.departedAt ? formatShanghaiMinute(snapshot.stay.departedAt) : ''}` : t('护士办理离院后自动带入', 'Filled in when the ward nurse records departure') },
      { key: 'main', done: operations.length > 0 && selectedMain !== null, title: t('主操作', 'Primary procedure'), owner: t('你 · 提交时', 'You, at submission'),
        detail: operations.length === 0 ? t('尚无已实施操作；做了手术的，提交时要选定 1 项主操作', 'No performed procedure yet; choose one primary procedure at submission when surgery is done') : t(`${operations.length} 项已实施操作，提交时选定 1 项主操作`, `${operations.length} performed procedures; choose one at submission`) },
      { key: 'fees', done: false, title: t('费用', 'Charges'), owner: t('收费员', 'Cashier'), detail: `${t('当前累计 ', 'Current charges ')}${formatFen(snapshot?.fees.chargesFen ?? 0, locale)} · ${t('结算后费用固定；结算前有变化都要重新提交', 'Charges are fixed at settlement; any earlier change needs resubmission')}` },
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
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatShanghaiMinute(item.performedAt)}</span></label>)}</div>
      <p className="text-xs text-muted-foreground">{t('选一项作为本次主操作。DRG 分组按这里的主操作计算。', 'Choose one primary procedure. DRG grouping uses it.')}</p>
    </> : <div className="grid gap-2 text-sm">{operations.length === 0 ? <span className="text-muted-foreground">{t('本次无已实施操作', 'No performed procedure in this admission')}</span>
      : operations.map(item => <Kv key={item.id} label={item.id === previousMain || item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')}>{item.actualProcedure.coding.code} {item.actualProcedure.coding.display}</Kv>)}</div>
    const fields = snapshot && data ? <div role="region" aria-label={t('病案首页核心字段', 'Record core fields')} className="clinmesh-inpatient-preparation gap-3">
      <RecordSection label={t('患者基本信息', 'Patient information')}><div className="grid gap-3 sm:grid-cols-3">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{genderLabel} · {snapshot.patient.birthDate ?? t('未记录', 'Not recorded')}</Kv>
        <div>{data.recordNumber ? <InpatientNumber locale={locale} number={data.recordNumber} label={t('病案号', 'Record number')} /> : <Kv label={t('病案号', 'Record number')}>—</Kv>}</div>
        <div><InpatientNumber locale={locale} number={snapshot.stay.inpatientNumber} /></div>
        <Kv label={t('住院次数', 'Admission count')}>{snapshot.patient.admissionCount}</Kv>
      </div></RecordSection>
      <RecordSection label={t('住院过程', 'Hospital stay')}><div className="grid gap-3 sm:grid-cols-3">
        <Kv label={t('实际入科', 'Received at')}>{snapshot.stay.admittedAt ? formatShanghaiMinute(snapshot.stay.admittedAt) : '—'}</Kv>
        <Kv label={t('入院病区', 'Initial ward')}>{wardName(snapshot.stay.initialWardId)}</Kv>
        <Kv label={t('实际离院', 'Departed at')}>{snapshot.stay.departedAt ? formatShanghaiMinute(snapshot.stay.departedAt) : '—'}</Kv>
        <Kv label={t('实际住院天数', 'Length of stay')}>{snapshot.stay.admittedAt && snapshot.stay.departedAt ? t(`${Math.max(1, Math.floor((Date.parse(snapshot.stay.departedAt) - Date.parse(snapshot.stay.admittedAt)) / 86_400_000) + 1)} 天`, `${Math.max(1, Math.floor((Date.parse(snapshot.stay.departedAt) - Date.parse(snapshot.stay.admittedAt)) / 86_400_000) + 1)} days`) : '—'}</Kv>
        <Kv label={t('离院方式 / 出院病区', 'Departure method / discharge ward')}>{departureLabel} · {wardName(snapshot.stay.dischargeWardId)}</Kv>
        <Kv label={t('转科', 'Transfers')}>{snapshot.stay.transfers.length === 0 ? t('无', 'None') : snapshot.stay.transfers.map(item => `${wardName(item.sourceWardId)} → ${wardName(item.targetWardId)}`).join('；')}</Kv>
        <Kv label={t('离院后 31 天内再住院计划', '31-day readmission plan')}>{t('无', 'None')}</Kv>
      </div></RecordSection>
      <RecordSection label={t('正式诊断', 'Formal diagnoses')} link={{ label: t('去诊断医嘱', 'Open orders'), onClick: open('orders') }}><div className="grid gap-2">
        <span className="text-xs text-muted-foreground">{t('编码体系：国家临床版 2.0 / 2022', 'Coding system: National clinical edition 2022')}</span>
        {entries.length === 0 ? <span className="text-sm text-muted-foreground">{t('暂无正式诊断', 'No formal diagnosis')}</span> : entries.map(entry => <Kv key={entry.conditionId} label={entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}>
          {entry.coding.code} {entry.coding.display} · {t('入院病情：', 'On admission: ')}{inpatientAdmissionConditionLabel(entry.admissionCondition, locale)}{entry.coding.releaseId ? '' : ` · ${t('来源待核对', 'source needs review')}`}</Kv>)}
      </div></RecordSection>
      <RecordSection label={operations.length > 0 && editable ? t('实际操作 · 确认本次主操作', 'Performed procedures · confirm primary') : t('实际操作', 'Performed procedures')} link={{ label: t('去手术', 'Open surgery'), onClick: open('surgery') }}><div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">{t('操作编码体系：ICD-9-CM-3 临床版 3.0', 'Procedure coding: ICD-9-CM-3 clinical edition 3.0')}</span>
        {mainPicker}
      </div></RecordSection>
      <RecordSection label={t('病案费用', 'Record fees')} link={{ label: t('逐笔明细在「费用」页签', 'Itemised charges are under Charges'), onClick: open('fees') }}>
        <div className="grid gap-3 sm:grid-cols-3"><Kv label={t('医疗费用合计', 'Net medical charges')}>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
          <Kv label={t('结算', 'Settlement')}>{snapshot.fees.settlement ? formatShanghaiMinute(snapshot.fees.settlement.settledAt) : t('未结算', 'Not settled')}</Kv></div>
        <p className="text-xs text-muted-foreground">{Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => `${inpatientChargeCategoryLabel(kind, locale)} ${formatFen(amount, locale)}`).join(' · ')}</p>
      </RecordSection>
    </div> : null
    const submitBlocked = blocked || admission.status === 'registered' || operations.length > 0 && !selectedMain || !settled && operations.length === 0
    const submitLabel = phase === 'none' ? t('提交病案首页', 'Submit record') : t('重新提交病案首页', 'Resubmit record')
    const submitReason = admission.status === 'registered' ? t('患者待入科，接诊后再提交。', 'Receive the patient before submitting.')
      : !settled && operations.length === 0 ? t('出院结算后才能提交', 'Submit after discharge settlement')
        : operations.length > 0 && !selectedMain ? t('还差：确认本次主操作', 'Confirm the primary procedure')
          : !settled ? t('在院提交只用于 DRG 预分组的主操作；结算后需重新提交，病案人员才能审核', 'An in-hospital submission only sets the DRG primary procedure; resubmit after settlement for coding review')
            : t('提交后交病案人员编码审核', 'Medical records reviews coding next')
    const submitAction = () => { if (expected) write.mutation.mutate({ operation: 'inpatient.record.submit', input: { ...expected, expectedRevision: draft?.revision ?? expected.expectedRevision, expectedSourcesHash: draft?.hash ?? expected.expectedSourcesHash, mainProcedureExecutionId: selectedMain } }) }
    return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-3">
      <h3 className="sr-only">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
      {record.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {record.error ? <Alert variant="destructive"><AlertDescription>{t('病案读取失败：', 'Medical record failed to load: ')}{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void record.refetch()}>{t('重试病案', 'Retry medical record')}</Button></AlertDescription></Alert> : null}
      {snapshot && data ? <>
        {phase === 'returned' && lastReview ? <div role="status" className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"><b className="text-warning">{t('病案人员退回', 'Returned by medical records')} · {formatShanghaiMinute(lastReview.recordedAt)}</b><span>{lastReview.reason}</span></div>
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
              <div className="clinmesh-inpatient-preparation-owner">{item.owner ? <span>{item.owner}</span> : null}</div>
            </li>)}</ul>
          </section>
          {operations.length > 0 && editable ? <RecordSection label={t('实际操作 · 确认本次主操作', 'Performed procedures · confirm primary')} link={{ label: t('去手术', 'Open surgery'), onClick: open('surgery') }}>{mainPicker}</RecordSection> : null}
          <details className="clinmesh-inpatient-disclosure"><summary>{t('预览当前病案首页核心字段（草稿）', 'Preview current record core fields (draft)')}</summary>
            <div className="pt-2 text-xs text-muted-foreground">
              {t('姓名：', 'Name: ')}{snapshot.patient.name} · {t('性别：', 'Gender: ')}{genderLabel} · {t('出生日期：', 'Birth date: ')}{snapshot.patient.birthDate ?? t('未记录', 'Not recorded')} · {t('住院次数：', 'Admissions: ')}{snapshot.patient.admissionCount} · {t('入科：', 'Admitted: ')}{snapshot.stay.admittedAt ? formatShanghaiMinute(snapshot.stay.admittedAt) : '—'}
            </div>
          </details>
        </> : fields}
        {settled && history.length > 0 ? <section aria-label={t('提交与审核记录', 'Submission and review history')} className="clinmesh-inpatient-preparation"><h4 className="font-medium">{t('提交与审核记录', 'Submission and review history')}</h4>
          <ul className="clinmesh-inpatient-preparation-list">{history.map(item => <li key={`${item.at}-${item.text}`} className="!grid-cols-[auto_minmax(0,1fr)]"><time className="tabular-nums text-muted-foreground" dateTime={item.at}>{formatShanghaiMinute(item.at)}</time><span>{item.text}</span></li>)}</ul></section> : null}
        {!settled && data.revision ? <p className="text-sm text-muted-foreground">{t(`第 ${data.revision.revision} 次提交 · ${formatShanghaiMinute(data.revision.recordedAt)}`, `Submission #${data.revision.revision} · ${formatShanghaiMinute(data.revision.recordedAt)}`)}</p> : null}
        {settled ? <p className="text-xs text-muted-foreground">{t('核心字段集用于本系统审核归档，不能直接用于国家首页或医保清单上报。', 'The core field set supports review and archive here; it is not a national record or insurance reporting dataset.')}</p> : null}
        {phase !== 'archived' ? <InpatientPrimaryAction stage="record">{editable ? <WorkspaceActionBar tone={submitBlocked ? 'blocked' : 'normal'} reason={submitReason}
          action={<>{draft && (draft.hash !== data.sourcesHash || draft.revision !== (data.revision?.revision ?? 0)) ? <Button variant="outline" onClick={() => setDraft(null)}>{t('放弃原主操作选择，重新审阅来源', 'Discard selection and review updated sources')}</Button> : null}
            <Button disabled={submitBlocked} onClick={submitAction}>{submitLabel}</Button></>} />
          : <WorkspaceActionBar tone="complete" reason={phase === 'approved' ? t('编码审核通过，等病案人员归档', 'Coding approved; waiting for medical records to archive')
            : t('等病案人员编码审核；诊断、操作或费用变化后需要重新提交', 'Waiting for coding review; resubmit if diagnoses, procedures or charges change')} />}</InpatientPrimaryAction> : null}
      </> : null}
    </section>
  }
  return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-4">
  <div className="flex flex-col gap-3">
    <h3 className="sr-only">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
    {record.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {record.error ? <Alert variant="destructive"><AlertDescription>{t('病案读取失败：', 'Medical record failed to load: ')}{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void record.refetch()}>{t('重试病案', 'Retry medical record')}</Button></AlertDescription></Alert> : null}
    {snapshot && data ? <>
     {data.revision ? <p className="text-sm text-muted-foreground">{t(`第 ${data.revision.revision} 次提交 · ${formatShanghaiMinute(data.revision.recordedAt)}`, `Submission #${data.revision.revision} · ${formatShanghaiMinute(data.revision.recordedAt)}`)}</p> : null}
     {archived ? <InpatientPrimaryAction stage="record"><WorkspaceActionBar tone="complete" reason={t('病案已归档，只读可查', 'Archived record is read only')} /></InpatientPrimaryAction> : null}
     {data.revision && data.revision.sourcesHash !== data.sourcesHash ? <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{t('来源已变化，请医生重新审阅并提交首页修订', 'Sources changed; physician must review and resubmit')}</p> : null}
     {coreFields}
     {coder && admission.financialStatus === 'settled' ? <InpatientFinancialAdjustments key={admission.id} admission={admission} session={session} locale={locale} /> : null}
     {coder && !archived && data.revision ? <Card size="sm">
      <CardHeader className="border-b"><CardTitle>{t('编码审核与归档', 'Coding review and archive')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
       <Field><FieldLabel htmlFor="inpatient-record-return-reason">{t('编码审核说明', 'Coding review note')}</FieldLabel><Input id="inpatient-record-return-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)}/></Field>
       <div className="flex flex-wrap gap-2">
        <InpatientPrimaryAction stage="record" priority={data.reviewCurrent ? -10 : 10} fallback={<Button variant="outline" disabled={blocked || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'approved', ...(reason.trim() ? { reason } : {}) } })}>{t('编码审核通过', 'Approve coding')}</Button>}>
          <WorkspaceActionBar tone={blocked || data.revision.sourcesHash !== data.sourcesHash ? 'blocked' : 'normal'} reason={data.revision.sourcesHash !== data.sourcesHash ? t('等住院医生重新核对并提交首页。', 'Wait for the inpatient doctor to review and resubmit the record.') : undefined}
            action={<> <Button variant="outline" disabled={blocked || !reason.trim() || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'returned', reason } })}>{t('退回医生修订', 'Return to physician')}</Button><Button disabled={blocked || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'approved', ...(reason.trim() ? { reason } : {}) } })}>{t('编码审核通过', 'Approve coding')}</Button></>} />
        </InpatientPrimaryAction>
        <InpatientPrimaryAction stage="record" priority={data.reviewCurrent ? 10 : -10} fallback={<Button variant="outline" disabled={blocked || !data.reviewCurrent || admission.status !== 'cleared' || admission.financialStatus !== 'settled'} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.archive', input: expected! })}>{t('归档病案', 'Archive record')}</Button>}>
          <WorkspaceActionBar tone={blocked || !data.reviewCurrent || admission.status !== 'cleared' || admission.financialStatus !== 'settled' ? 'blocked' : 'normal'}
            reason={!data.reviewCurrent ? t('请先完成编码审核。', 'Complete coding review first.') : admission.financialStatus !== 'settled' ? t('等收费员结算后归档。', 'Wait for cashier settlement before archiving.') : admission.status !== 'cleared' ? t('等病区护士清床后归档。', 'Wait for the ward nurse to clear the bed before archiving.') : undefined}
            action={<Button disabled={blocked || !data.reviewCurrent || admission.status !== 'cleared' || admission.financialStatus !== 'settled'} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.archive', input: expected! })}>{t('归档病案', 'Archive record')}</Button>} />
        </InpatientPrimaryAction>
       </div>
      </CardContent>
     </Card> : null}
    </> : null}
   </div>
 </section>
}
