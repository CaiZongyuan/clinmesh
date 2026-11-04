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
import { apiGet } from './api-client.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { z } from 'zod'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { InpatientNumber } from './inpatient-number.tsx'
import { inpatientAdmissionConditionLabel, inpatientChargeCategoryLabel, inpatientDepartureLabel } from './inpatient-labels.ts'

function Kv({ label, mono = false, children }: { label: string; mono?: boolean; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={mono ? 'select-text break-all font-mono text-sm' : 'break-words text-sm font-medium'}>{children}</span>
  </div>
}

export function InpatientRecord({ admission, session, locale, write, catalog }: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  catalog?: z.infer<typeof inpatientCatalogSchema> | undefined
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
  const timestamp = (value: string | undefined) => value === undefined ? '—' : new Date(value).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })
  const birthDate = snapshot?.patient.birthDate ? new Date(`${snapshot.patient.birthDate}T00:00:00+08:00`).toLocaleDateString(locale, { timeZone: 'Asia/Shanghai' }) : t('未记录', 'Not recorded')
  const submit = () => { if (expected)
    write.mutation.mutate({ operation: 'inpatient.record.submit', input: { ...expected, expectedRevision: draft?.revision ?? expected.expectedRevision, expectedSourcesHash: draft?.hash ?? expected.expectedSourcesHash, mainProcedureExecutionId: draft?.main ?? null } }); }
  const coreFields = snapshot && data ? <>
     <div className="clinmesh-inpatient-record-sections">
      <Card role="region" size="sm" aria-label={t('患者基本信息', 'Patient information')}>
       <CardHeader className="border-b"><CardTitle>{t('患者基本信息', 'Patient information')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('姓名', 'Name')}>{snapshot.patient.name}</Kv>
        <Kv label={t('性别 / 出生日期', 'Gender / birth date')}>{genderLabel} · {birthDate}</Kv>
        <div>{data.recordNumber ? <InpatientNumber locale={locale} number={data.recordNumber} label={t('病案号', 'Record number')} /> : <Kv label={t('病案号', 'Record number')}>—</Kv>}</div>
        <div><InpatientNumber locale={locale} number={snapshot.stay.inpatientNumber} /></div>
        <Kv label={t('住院次数', 'Admission count')} mono>{snapshot.patient.admissionCount}</Kv>
       </CardContent>
      </Card>
      <Card role="region" size="sm" aria-label={t('住院过程', 'Hospital stay')}>
       <CardHeader className="border-b"><CardTitle>{t('住院过程', 'Hospital stay')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('实际入科', 'Received at')} mono>{timestamp(snapshot.stay.admittedAt)}</Kv>
        <Kv label={t('入院病区', 'Initial ward')}>{wardName(snapshot.stay.initialWardId)}</Kv>
        <Kv label={t('实际离院', 'Departed at')} mono>{timestamp(snapshot.stay.departedAt)}</Kv>
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
          <span className="font-mono text-xs text-muted-foreground">{timestamp(item.performedAt)}</span>
         </div>)}
        <details className="clinmesh-inpatient-disclosure"><summary>{t('查看编码与上报范围', 'Coding and reporting scope')}</summary><p className="text-xs text-muted-foreground">{t('诊断采用固定临床版2022来源（原始工作簿权威身份尚未独立验证）；操作采用临床版3.0固定有界摘录。核心字段集不能直接用于国家首页或医保清单上报。', 'Diagnosis uses the fixed 2022 clinical source, whose original workbook authority is not independently verified; procedures use a bounded 3.0 excerpt. This core set is not a national reporting dataset.')}</p></details>
       </CardContent>
      </Card>
      <Card role="region" size="sm" aria-label={t('病案费用', 'Record fees')}>
       <CardHeader className="border-b"><CardTitle>{t('病案费用', 'Record fees')}</CardTitle></CardHeader>
       <CardContent className="grid gap-3 sm:grid-cols-2">
        <Kv label={t('医疗费用合计', 'Net medical charges')} mono>{formatFen(snapshot.fees.chargesFen, locale)}</Kv>
        <Kv label={t('预交金（独立资金）', 'Deposit (separate funds)')} mono>{formatFen(snapshot.fees.depositFen, locale)}</Kv>
        {Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <Kv key={kind} label={inpatientChargeCategoryLabel(kind, locale)} mono>{formatFen(amount, locale)}</Kv>)}
        <div className="flex flex-col gap-1 sm:col-span-2">
         <span className="text-xs text-muted-foreground">{t('费用明细', 'Charge items')}</span>
         {snapshot.fees.charges.length === 0 ? <span className="text-sm">{t('无', 'None')}</span>
          : snapshot.fees.charges.map(item => <span key={item.id} className="break-all font-mono text-sm">{item.label} · {formatFen(item.amountFen, locale)}{item.reversalOf ? ` · ${t('退费', 'Charge correction')}` : ''}</span>)}
        </div>
        <Kv label={t('结算', 'Settlement')} mono>{timestamp(snapshot.fees.settlement?.settledAt)}</Kv>
       </CardContent>
      </Card>
     </div>
     {data.reviews.length > 0 || archived ? <Card role="region" size="sm" aria-label={t('审核与归档记录', 'Review and archive history')}>
      <CardHeader className="border-b"><CardTitle>{t('审核与归档记录', 'Review and archive history')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
       {data.reviews.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无编码审核记录', 'No coding review yet')}</p> : data.reviews.map(review => <div key={review.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
         <Badge variant={review.outcome === 'approved' ? 'success' : 'destructive'}>{review.outcome === 'approved' ? t('审核通过', 'Approved') : t('退回', 'Returned')}</Badge>
         <span className="text-muted-foreground">{t('修订', 'Revision')} <span className="font-mono">{review.revision}</span></span>
         <span className="font-mono text-xs text-muted-foreground">{timestamp(review.recordedAt)}{review.reason ? ` · ${review.reason}` : ''}</span>
        </div>)}
       {archived ? <p className="text-sm text-muted-foreground">{t('归档', 'Archived')} <span className="font-mono">{timestamp(data.archive!.recordedAt)}</span></p> : null}
      </CardContent>
     </Card> : null}
  </> : null
  return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="flex min-w-0 flex-col gap-4">
  <div className="flex flex-col gap-3">
    <h3 className={doctor ? 'sr-only' : 'text-lg'}>{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
    {record.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {record.error ? <Alert variant="destructive"><AlertDescription>{t('病案读取失败：', 'Medical record failed to load: ')}{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void record.refetch()}>{t('重试病案', 'Retry medical record')}</Button></AlertDescription></Alert> : null}
    {snapshot && data ? <>
     {doctor ? <section aria-label={t('病案首页状态', 'Medical record status')} className="clinmesh-inpatient-summary">
       <h3 className="font-semibold">{t('病案首页', 'Medical record')}</h3>
       <p>{archived ? t('病案已归档，核心字段与审核记录只读可查。', 'The record is archived. Its fields and review history are read only.')
         : admission.status === 'registered' ? t('患者待入科。接诊后可核对并提交首页。', 'The patient awaits ward admission. Review and submit the record after reception.')
           : admission.status === 'admitted' ? t('患者在院中，可核对核心字段并提交首页修订。', 'The patient is admitted. Core fields can be reviewed and a record revision submitted.')
             : t('核对本次住院核心字段，提交后交病案人员审核。', 'Review this admission’s core fields and submit them for coding review.')}</p>
       <p className="text-sm text-muted-foreground">{t(`正式诊断 ${snapshot.clinical.diagnosis.entries.length} 项 · 实际操作 ${snapshot.clinical.operations.length} 项`, `${snapshot.clinical.diagnosis.entries.length} diagnoses · ${snapshot.clinical.operations.length} performed procedures`)}</p>
     </section> : null}
     <p className="flex flex-wrap items-center gap-2 text-sm">
      {archived ? <Badge variant="success">{t('病案已归档，只读可查', 'Archived record · read only')}</Badge>
        : data.reviewCurrent ? <Badge variant="success">{t('当前修订编码审核通过', 'Current revision approved')}</Badge>
        : <Badge variant="warning">{t('等待提交或编码审核', 'Awaiting submission or coding review')}</Badge>}
      <span className="text-muted-foreground">{t('修订', 'Revision')} <span className="font-mono">{data.revision?.revision ?? 0}</span></span>
     </p>
     {data.revision && data.revision.sourcesHash !== data.sourcesHash ? <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">{t('来源已变化，请医生重新审阅并提交首页修订', 'Sources changed; physician must review and resubmit')}</p> : null}
     {doctor ? <details className="clinmesh-inpatient-disclosure"><summary>{t('查看病案核心字段', 'View medical record fields')}</summary>{coreFields}</details> : coreFields}
     {coder && admission.financialStatus === 'settled' ? <InpatientFinancialAdjustments key={admission.id} admission={admission} session={session} locale={locale} /> : null}
     {doctor && !archived ? <section aria-label={t('提交病案首页', 'Submit record')} className="flex min-w-0 flex-col gap-3">
      <h4 className="font-semibold">{t('提交病案首页', 'Submit record')}</h4>
      <div className="flex min-w-0 flex-col gap-3">
       {snapshot.clinical.operations.length > 0 ? <Field><FieldLabel htmlFor="inpatient-record-main">{t('确认本次主操作', 'Confirm primary performed procedure')}</FieldLabel><WorkspaceSelect id="inpatient-record-main" value={draft?.main ?? null} items={snapshot.clinical.operations.map(item => ({ value: item.id, label: `${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}` }))} onValueChange={value => setDraft(current => ({ main: value, revision: current?.revision ?? expected!.expectedRevision, hash: current?.hash ?? expected!.expectedSourcesHash }))}/></Field> : null}
       <div className="flex flex-wrap gap-2">
        <InpatientPrimaryAction stage="record"><WorkspaceActionBar tone={blocked || admission.status === 'registered' || snapshot.clinical.operations.length > 0 && !draft?.main ? 'blocked' : 'normal'}
          reason={snapshot.clinical.operations.length > 0 && !draft?.main ? t('还差：确认本次主操作。', 'Confirm the primary performed procedure.') : undefined}
          action={<Button disabled={blocked || admission.status === 'registered' || (snapshot.clinical.operations.length > 0 && !draft?.main)} onClick={submit}>{snapshot.clinical.operations.length === 0 ? t('提交首页（本次无已实施操作）', 'Submit record with no performed procedure') : t('提交首页修订', 'Submit record revision')}</Button>} /></InpatientPrimaryAction>
        {draft && (draft.hash !== data.sourcesHash || draft.revision !== (data.revision?.revision ?? 0)) ? <Button variant="outline" onClick={() => setDraft(null)}>{t('放弃原主操作选择，重新审阅来源', 'Discard selection and review updated sources')}</Button> : null}
       </div>
      </div>
     </section> : null}
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
