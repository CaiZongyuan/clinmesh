import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiGet } from './api-client.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
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
  useEffect(() => { if (draft && result?.command?.operation === 'inpatient.record.submit' && result.command.input.admissionId === admission.id && result.command.input.expectedRevision === draft.revision && (data?.revision?.revision ?? 0) > draft.revision)
    setDraft(null); }, [admission.id, data?.revision?.revision, draft, result])
  const blocked = write.blocked || record.isFetching || archived
  const submit = () => { if (expected)
    write.mutation.mutate({ operation: 'inpatient.record.submit', input: { ...expected, expectedRevision: draft?.revision ?? expected.expectedRevision, expectedSourcesHash: draft?.hash ?? expected.expectedSourcesHash, mainProcedureExecutionId: draft?.main ?? null } }); }
  return <section aria-label={t('住院病案首页核心字段集', 'Inpatient record core fields')} className="mt-4 flex flex-col gap-3 rounded-md border p-4">
  <h3>{t('住院病案首页核心字段集', 'Inpatient record core fields')}</h3>
  {record.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(record.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
  {snapshot && data ? <>
   <p>{archived ? t('病案已归档，只读可查', 'Archived record · read only') : data.reviewCurrent ? t('当前修订编码审核通过', 'Current revision approved') : t('等待提交或编码审核', 'Awaiting submission or coding review')} · {t('修订', 'Revision')} {data.revision?.revision ?? 0}</p>
   {data.revision && data.revision.sourcesHash !== data.sourcesHash ? <p role="status">{t('来源已变化，请医生重新审阅并提交首页修订', 'Sources changed; physician must review and resubmit')}</p> : null}
   <section aria-label={t('患者基本信息', 'Patient information')}><h4>{t('患者基本信息', 'Patient information')}</h4><p>{snapshot.patient.name} · {snapshot.patient.gender} · {snapshot.patient.birthDate}</p><p>{t('病案号', 'Record number')} {data.recordNumber} · {t('住院号', 'Inpatient number')} {snapshot.stay.inpatientNumber} · {t('住院次数', 'Admission count')} {snapshot.patient.admissionCount}</p><p>{snapshot.patient.identifier} · Patient/{snapshot.patient.patientId}/_history/{snapshot.patient.patientVersion}</p></section>
   <section aria-label={t('住院过程', 'Hospital stay')}><h4>{t('住院过程', 'Hospital stay')}</h4><p>{t('实际入科', 'Received')} {snapshot.stay.admittedAt ?? '—'} · {snapshot.stay.initialWardId ?? '—'} · {snapshot.stay.initialOrganizationId ?? '—'}</p><p>{t('实际出区', 'Departed')} {snapshot.stay.departedAt ?? '—'} · {snapshot.stay.departureMethod ?? '—'} · {snapshot.stay.dischargeWardId}</p>{snapshot.stay.transfers.map(item => <p key={item.id}>{item.sourceWardId} → {item.targetWardId} · {item.receivedAt}</p>)}</section>
   <section aria-label={t('正式诊断与实际操作', 'Diagnoses and performed procedures')}><h4>{t('正式诊断与实际操作', 'Diagnoses and performed procedures')}</h4>
    {snapshot.clinical.diagnosis.entries.map(entry => <div key={entry.conditionId}><p>{entry.role === 'primary' ? t('主诊断', 'Primary') : t('次诊断', 'Secondary')} · {entry.coding.code} {entry.coding.display} · POA {entry.admissionCondition}</p><p className="break-all text-sm">{entry.coding.system} · {entry.coding.version} · {entry.coding.releaseId ?? t('院内备用编码，不能审核归档', 'Operational fallback; approval unavailable')} · {entry.coding.sourceLocator}</p></div>)}
    {snapshot.clinical.operations.length === 0 ? <p>{t('本次无已实施操作', 'No performed procedure in this admission')}</p> : snapshot.clinical.operations.map(item => <p key={item.id}>{item.primary ? t('主操作', 'Primary procedure') : t('其他操作', 'Other procedure')} · {item.actualProcedure.coding.code} {item.actualProcedure.coding.display} · {item.performedAt} · {item.practitionerRoleId} · Procedure/{item.id}/_history/{item.procedureVersion}</p>)}
    <p className="text-sm">{t('诊断采用固定临床版2022来源（原始工作簿权威身份尚未独立验证）；操作采用临床版3.0固定有界摘录。核心字段集不能直接用于国家首页或医保清单上报。', 'Diagnosis uses the fixed 2022 clinical source, whose original workbook authority is not independently verified; procedures use a bounded 3.0 excerpt. This core set is not a national reporting dataset.')}</p>
   </section>
   <section aria-label={t('病案费用', 'Record fees')}><h4>{t('病案费用', 'Record fees')}</h4><p>{t('医疗费用净额', 'Net medical charges')} {formatFen(snapshot.fees.chargesFen, locale)} · {t('预交金（独立资金）', 'Deposit (separate funds)')} {formatFen(snapshot.fees.depositFen, locale)}</p>{Object.entries(snapshot.fees.categoryNetFen).map(([kind, amount]) => <p key={kind}>{kind} · {formatFen(amount, locale)}</p>)}{snapshot.fees.charges.map(item => <p key={item.id}>{item.label} · {formatFen(item.amountFen, locale)}{item.reversalOf ? ` · ${t('冲正', 'Reversal')} ${item.reversalOf}` : ''}</p>)}<p>{t('结算', 'Settlement')} {snapshot.fees.settlement?.id ?? '—'}</p></section>
   {data.reviews.map(review => <p key={review.id}>{review.outcome === 'approved' ? t('审核通过', 'Approved') : t('退回', 'Returned')} · {t('修订', 'Revision')} {review.revision} · {review.practitionerRoleId} · {review.recordedAt}{review.reason ? ` · ${review.reason}` : ''}</p>)}
   {archived ? <p>{t('归档', 'Archived')} {data.archive!.recordedAt} · {data.archive!.practitionerRoleId}</p> : null}
   {doctor && !archived ? <>
    {snapshot.clinical.operations.length > 0 ? <Field><FieldLabel htmlFor="inpatient-record-main">{t('确认本次主操作', 'Confirm primary performed procedure')}</FieldLabel><WorkspaceSelect id="inpatient-record-main" value={draft?.main ?? null} items={snapshot.clinical.operations.map(item => ({ value: item.id, label: `${item.actualProcedure.coding.code} · ${item.actualProcedure.coding.display}` }))} onValueChange={value => setDraft({ main: value, revision: expected!.expectedRevision, hash: expected!.expectedSourcesHash })}/></Field> : null}
    <Button disabled={blocked || admission.status === 'registered' || (snapshot.clinical.operations.length > 0 && !draft?.main)} onClick={submit}>{snapshot.clinical.operations.length === 0 ? t('提交首页（本次无已实施操作）', 'Submit record with no performed procedure') : t('提交首页修订', 'Submit record revision')}</Button>
    {draft && draft.hash !== data.sourcesHash ? <Button variant="outline" onClick={() => setDraft(null)}>{t('放弃原主操作选择，重新审阅来源', 'Discard selection and review updated sources')}</Button> : null}
   </> : null}
   {coder && !archived && data.revision ? <>
    <Field><FieldLabel htmlFor="inpatient-record-return-reason">{t('编码审核说明', 'Coding review note')}</FieldLabel><Input id="inpatient-record-return-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)}/></Field>
    <div className="flex flex-wrap gap-2"><Button disabled={blocked || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'approved', ...(reason.trim() ? { reason } : {}) } })}>{t('编码审核通过', 'Approve coding')}</Button><Button variant="outline" disabled={blocked || !reason.trim() || data.revision.sourcesHash !== data.sourcesHash} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.review', input: { ...expected!, outcome: 'returned', reason } })}>{t('退回医生修订', 'Return to physician')}</Button><Button disabled={blocked || !data.reviewCurrent || admission.status !== 'cleared' || admission.financialStatus !== 'settled'} onClick={() => write.mutation.mutate({ operation: 'inpatient.record.archive', input: expected! })}>{t('归档病案', 'Archive record')}</Button></div>
   </> : null}
  </> : null}
 </section>
}
