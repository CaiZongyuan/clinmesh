import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { InpatientFinancialAdjustments } from './inpatient-financial-adjustments.tsx'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiGet } from './api-client.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type RecordStatusFilter = 'all' | InpatientAdmission['recordStatus']

function Kv({ label, mono = false, children }: { label: string; mono?: boolean; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={mono ? 'select-text break-all font-mono text-sm' : 'break-words text-sm font-medium'}>{children}</span>
  </div>
}

function recordStatusBadge(status: InpatientAdmission['recordStatus'], t: (cn: string, en: string) => string) {
  return status === 'archived' ? { label: t('已归档', 'Archived'), variant: 'success' as const }
    : status === 'reviewed' ? { label: t('编码审核通过', 'Coding approved'), variant: 'info' as const }
    : { label: t('待整理', 'Open'), variant: 'warning' as const }
}

/** 病案队列：按整理状态查看全部住院病案；当前病案高亮，选择仍由工作台拥有。 */
function RecordQueue({ session, locale, currentId }: { session: SessionContext; locale: WorkspaceLocale; currentId: string }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [filter, setFilter] = useState<RecordStatusFilter>('all')
  const queue = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, 'admissions'],
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const items = (queue.data?.items ?? []).filter(item => filter === 'all' || item.recordStatus === filter)
  const filters: Array<{ value: RecordStatusFilter; label: string }> = [
    { value: 'all', label: t('全部', 'All') },
    { value: 'open', label: t('待整理', 'Open') },
    { value: 'reviewed', label: t('审核通过', 'Reviewed') },
    { value: 'archived', label: t('已归档', 'Archived') },
  ]
  return <Card size="sm" aria-label={t('病案队列', 'Records queue')}>
    <CardHeader className="border-b">
      <CardTitle className="font-serif">{t('病案队列', 'Records queue')}</CardTitle>
      <CardDescription>{t('按整理状态查看住院病案，当前病案高亮', 'Admissions by record status; the current admission is highlighted')}</CardDescription>
      <CardAction>
        <div role="group" aria-label={t('按整理状态筛选', 'Filter by record status')} className="flex flex-wrap gap-1.5">
          {filters.map(item => <Button key={item.value} size="sm" variant={filter === item.value ? 'default' : 'outline'} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</Button>)}
        </div>
      </CardAction>
    </CardHeader>
    <CardContent className="flex flex-col gap-1.5">
      {queue.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {queue.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(queue.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
      {queue.data !== undefined && items.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无符合该状态的病案', 'No records match this status')}</p> : null}
      {items.map(item => {
        const meta = recordStatusBadge(item.recordStatus, t), current = item.id === currentId
        return <div key={item.id} aria-current={current ? 'true' : undefined}
          className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2${current ? ' bg-accent/60' : ''}`}>
          <span className="text-sm font-medium">{item.bedId !== undefined ? `${t('床', 'Bed')} ${item.bedId} · ` : ''}{item.patientName}</span>
          <span className="font-mono text-xs text-muted-foreground">{item.inpatientNumber}</span>
          <Badge variant={meta.variant} className="ml-auto shrink-0">{meta.label}</Badge>
        </div>
      })}
    </CardContent>
  </Card>
}

export function InpatientRecord({ admission, session, locale, write }: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
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
  const blocked = write.blocked || record.isFetching || archived
  const submit = () => { if (expected)
    write.mutation.mutate({ operation: 'inpatient.record.submit', input: { ...expected, expectedRevision: draft?.revision ?? expected.expectedRevision, expectedSourcesHash: draft?.hash ?? expected.expectedSourcesHash, mainProcedureExecutionId: draft?.main ?? null } }); }
  return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-4">
  <RecordQueue session={session} locale={locale} currentId={admission.id} />
  <div className="flex flex-col gap-3">
    <h3 className="font-serif text-lg">{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
    {record.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {snapshot && data ? <>
     <p className="flex flex-wrap items-center gap-2 text-sm">
      {archived ? <Badge variant="success">{t('病案已归档，只读可查', 'Archived record · read only')}</Badge>
        : data.reviewCurrent ? <Badge variant="success">{t('当前修订编码审核通过', 'Current revision approved')}</Badge>
        : <Badge variant="warning">{t('等待提交或编码审核', 'Awaiting submission or coding review')}</Badge>}
      <span className="text-muted-foreground">{t('修订', 'Revision')} <span className="font-mono">{data.revision?.revision ?? 0}</span></span>
     </p>
     {data.revision && data.revision.sourcesHash !== data.sourcesHash ? <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{t('来源已变化，请医生重新审阅并提交首页修订', 'Sources changed; physician must review and resubmit')}</p> : null}
     <div className="grid gap-3 xl:grid-cols-2">
      <Card size="sm" aria-label={t('患者基本信息', 'Patient information')}>
       <CardHeader className="border-b"><CardTitle className="font-serif">{t('患者基本信息', 'Patient information')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{snapshot.patient.gender} · {snapshot.patient.birthDate}</Kv>
        <Kv label={t('病案号', 'Record number')} mono>{data.recordNumber ?? '—'}</Kv>
        <Kv label={t('住院号', 'Inpatient number')} mono>{snapshot.stay.inpatientNumber}</Kv>
        <Kv label={t('住院次数', 'Admission count')} mono>{snapshot.patient.admissionCount}</Kv>
        <Kv label={t('患者身份标识', 'Patient identifier')} mono>{snapshot.patient.identifier}</Kv>
        <div className="sm:col-span-2"><Kv label="FHIR Patient" mono>{snapshot.patient.patientId}/_history/{snapshot.patient.patientVersion}</Kv></div>
       </CardContent>
      </Card>
      <Card size="sm" aria-label={t('住院过程', 'Hospital stay')}>
       <CardHeader className="border-b"><CardTitle className="font-serif">{t('住院过程', 'Hospital stay')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('实际入科', 'Received at')} mono>{snapshot.stay.admittedAt ?? '—'}</Kv>
        <Kv label={t('入生病区 / 组织', 'Initial ward / organization')} mono>{snapshot.stay.initialWardId ?? '—'} · {snapshot.stay.initialOrganizationId ?? '—'}</Kv>
        <Kv label={t('实际出区', 'Departed at')} mono>{snapshot.stay.departedAt ?? '—'}</Kv>
        <Kv label={t('离院方式 / 出院病区', 'Departure method / discharge ward')}>{snapshot.stay.departureMethod ?? '—'} · {snapshot.stay.dischargeWardId}</Kv>
        <div className="flex flex-col gap-1 sm:col-span-2">
         <span className="text-xs text-muted-foreground">{t('转科记录', 'Transfers')}</span>
         {snapshot.stay.transfers.length === 0 ? <span className="text-sm">{t('无', 'None')}</span>
          : snapshot.stay.transfers.map(item => <span key={item.id} className="break-all font-mono text-sm">{item.sourceWardId} → {item.targetWardId} · {item.receivedAt}</span>)}
        </div>
       </CardContent>
      </Card>
      <Card size="sm" aria-label={t('正式诊断与实际操作', 'Diagnoses and performed procedures')}>
       <CardHeader className="border-b"><CardTitle className="font-serif">{t('正式诊断与实际操作', 'Diagnoses and performed procedures')}</CardTitle></CardHeader>
       <CardContent className="flex flex-col gap-2">
        {snapshot.clinical.diagnosis.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无正式诊断', 'No formal diagnosis')}</p> : snapshot.clinical.diagnosis.entries.map(entry => <div key={entry.conditionId} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
           <Badge variant={entry.role === 'primary' ? 'default' : 'outline'}>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')}</Badge>
           <span className="text-sm font-medium">{entry.coding.code} {entry.coding.display}</span>
           <span className="font-mono text-xs text-muted-foreground">POA {entry.admissionCondition}</span>
          </div>
          <span className="break-all font-mono text-xs text-muted-foreground">{entry.coding.system} · {entry.coding.version} · {entry.coding.releaseId ?? t('院内备用编码，不能审核归档', 'Operational fallback; approval unavailable')} · {entry.coding.sourceLocator}</span>
         </div>)}
        {snapshot.clinical.operations.length === 0 ? <p className="text-sm text-muted-foreground">{t('本次无已实施操作', 'No performed procedure in this admission')}</p> : snapshot.clinical.operations.map(item => <div key={item.id} className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
           <Badge variant={item.primary ? 'default' : 'outline'}>{item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')}</Badge>
           <span className="text-sm font-medium">{item.actualProcedure.coding.code} {item.actualProcedure.coding.display}</span>
          </div>
          <span className="break-all font-mono text-xs text-muted-foreground">{item.performedAt} · {item.practitionerRoleId} · Procedure/{item.id}/_history/{item.procedureVersion}</span>
         </div>)}
        <p className="text-xs text-muted-foreground">{t('诊断采用固定临床版2022来源（原始工作簿权威身份尚未独立验证）；操作采用临床版3.0固定有界摘录。核心字段集不能直接用于国家首页或医保清单上报。', 'Diagnosis uses the fixed 2022 clinical source, whose original workbook authority is not independently verified; procedures use a bounded 3.0 excerpt. This core set is not a national reporting dataset.')}</p>
       </CardContent>
      </Card>
      <Card size="sm" aria-label={t('病案费用', 'Record fees')}>
       <CardHeader className="border-b"><CardTitle className="font-serif">{t('病案费用', 'Record fees')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('医疗费用净额', 'Net medical charges')} mono>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
        <Kv label={t('预交金（独立资金）', 'Deposit (separate funds)')} mono>{formatFen(snapshot.fees.depositFen, locale)}</Kv>
        {Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <Kv key={kind} label={kind} mono>{formatFen(amount, locale)}</Kv>)}
        <div className="flex flex-col gap-1 sm:col-span-2">
         <span className="text-xs text-muted-foreground">{t('费用明细', 'Charge items')}</span>
         {snapshot.fees.charges.length === 0 ? <span className="text-sm">{t('无', 'None')}</span>
          : snapshot.fees.charges.map(item => <span key={item.id} className="break-all font-mono text-sm">{item.label} · {formatFen(item.amountFen, locale)}{item.reversalOf ? ` · ${t('冲正', 'Reversal')} ${item.reversalOf}` : ''}</span>)}
        </div>
        <Kv label={t('结算', 'Settlement')} mono>{snapshot.fees.settlement?.id ?? '—'}</Kv>
       </CardContent>
      </Card>
     </div>
     {data.reviews.length > 0 || archived ? <Card size="sm" aria-label={t('审核与归档记录', 'Review and archive history')}>
      <CardHeader className="border-b"><CardTitle className="font-serif">{t('审核与归档记录', 'Review and archive history')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
       {data.reviews.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无编码审核记录', 'No coding review yet')}</p> : data.reviews.map(review => <div key={review.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
         <Badge variant={review.outcome === 'approved' ? 'success' : 'destructive'}>{review.outcome === 'approved' ? t('审核通过', 'Approved') : t('退回', 'Returned')}</Badge>
         <span className="text-muted-foreground">{t('修订', 'Revision')} <span className="font-mono">{review.revision}</span></span>
         <span className="break-all font-mono text-xs text-muted-foreground">{review.practitionerRoleId} · {review.recordedAt}{review.reason ? ` · ${review.reason}` : ''}</span>
        </div>)}
       {archived ? <p className="text-sm text-muted-foreground">{t('归档', 'Archived')} <span className="break-all font-mono">{data.archive!.recordedAt} · {data.archive!.practitionerRoleId}</span></p> : null}
      </CardContent>
     </Card> : null}
     {coder && admission.financialStatus === 'settled' ? <InpatientFinancialAdjustments key={admission.id} admission={admission} session={session} locale={locale} /> : null}
     {doctor && !archived ? <Card size="sm">
      <CardHeader className="border-b"><CardTitle className="font-serif">{t('提交病案首页', 'Submit record')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
       {snapshot.clinical.operations.length > 0 ? <Field><FieldLabel htmlFor="inpatient-record-main">{t('确认本次主操作', 'Confirm primary performed procedure')}</FieldLabel><WorkspaceSelect id="inpatient-record-main" value={draft?.main ?? null} items={snapshot.clinical.operations.map(item => ({ value: item.id, label: `${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}` }))} onValueChange={value => setDraft(current => ({ main: value, revision: current?.revision ?? expected!.expectedRevision, hash: current?.hash ?? expected!.expectedSourcesHash }))}/></Field> : null}
       <div className="flex flex-wrap gap-2">
        <Button disabled={blocked || admission.status === 'registered' || (snapshot.clinical.operations.length > 0 && !draft?.main)} onClick={submit}>{snapshot.clinical.operations.length === 0 ? t('提交首页（本次无已实施操作）', 'Submit record with no performed procedure') : t('提交首页修订', 'Submit record revision')}</Button>
        {draft && (draft.hash !== data.sourcesHash || draft.revision !== (data.revision?.revision ?? 0)) ? <Button variant="outline" onClick={() => setDraft(null)}>{t('放弃原主操作选择，重新审阅来源', 'Discard selection and review updated sources')}</Button> : null}
       </div>
      </CardContent>
     </Card> : null}
     {coder && !archived && data.revision ? <Card size="sm">
      <CardHeader className="border-b"><CardTitle className="font-serif">{t('编码审核与归档', 'Coding review and archive')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
       <Field><FieldLabel htmlFor="inpatient-record-return-reason">{t('编码审核说明', 'Coding review note')}</FieldLabel><Input id="inpatient-record-return-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)}/></Field>
       <div className="flex flex-wrap gap-2"><Button disabled={blocked || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'approved', ...(reason.trim() ? { reason } : {}) } })}>{t('编码审核通过', 'Approve coding')}</Button><Button variant="outline" disabled={blocked || !reason.trim() || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'returned', reason } })}>{t('退回医生修订', 'Return to physician')}</Button><Button disabled={blocked || !data.reviewCurrent || admission.status !== 'cleared' || admission.financialStatus !== 'settled'} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.archive', input: expected! })}>{t('归档病案', 'Archive record')}</Button></div>
      </CardContent>
     </Card> : null}
    </> : null}
   </div>
 </section>
}
