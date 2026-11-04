import { inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import { Button } from '@clinmesh/ui/components/button'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { DiagnosisConfirmation, DoctorCaseDetail, SessionContext } from '@clinmesh/contracts/his'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'

export function InpatientReferral({ diagnosisConfirmation, encounterId, encounterVersion, locale, patient, registrationNumber, session }: {
  diagnosisConfirmation?: DiagnosisConfirmation | undefined
  encounterId: string; encounterVersion: string; locale: WorkspaceLocale; session: SessionContext
  patient: DoctorCaseDetail['patient']; registrationNumber: DoctorCaseDetail['registrationNumber']
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [wardId, setWardId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const catalog = useQuery({ queryKey: ['inpatient', 'referral-catalog', encounterId], enabled: open,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/catalog', inpatientCatalogSchema, signal) })
  const wards = (catalog.data?.wards ?? []).filter(ward => ward.acceptingAdmissions !== false)
  const receivingWardId = wardId ?? (wards.length === 1 ? wards[0]!.id : null)
  const write = useInpatientWriteIntent(session, () => undefined)
  const messages = getWorkspaceMessages(locale)
  const error = catalog.error ?? write.storageFailure ?? write.mutation.error
  const completed = write.mutation.data?.command
  const issued = write.mutation.isSuccess && completed?.operation === 'inpatient.referral.issue' && completed.input.encounterId === encounterId
  const hint = issued ? (zh ? '住院证已开具' : 'Referral issued') : write.mutation.isPending ? (zh ? '正在办理，请稍候' : 'Processing, please wait') : write.blocked ? (zh ? '请先恢复原住院操作' : 'Recover the original operation first')
    : receivingWardId === null ? (zh ? '请选择收治病区' : 'Choose a receiving ward') : !reason.trim() ? (zh ? '还差：住院原因' : 'Enter the admission reason')
      : (zh ? '核对后确认开具' : 'Review before issuing')
  const handoff = zh ? '住院证已开具。下一步：登记员 → 住院登记 → 门诊住院证转收，选择本患者住院证并办理住院；完成后由病区护士接诊分床。' : 'Referral issued. Next: registrar → Admission registration → Outpatient referral. Select this patient’s referral and register the admission, then the ward nurse receives and assigns a bed.'
  return <>{issued && !open ? <p role="status" aria-label={zh ? '住院证交接' : 'Admission referral handoff'} className="text-sm">{handoff}</p> : null}<Dialog open={open} onOpenChange={nextOpen => { if (nextOpen || !write.mutation.isPending) setOpen(nextOpen) }}>
    <DialogTrigger render={<Button className="self-end" size="sm" variant="outline" />}>{zh ? '开具住院证' : 'Issue admission referral'}</DialogTrigger>
    <DialogContent className="sm:max-w-[600px]"><DialogHeader><DialogTitle>{zh ? '开具住院证' : 'Admission referral'}</DialogTitle>
      <DialogDescription>{zh ? '选择收治病区，说明住院原因；开具后交登记处办理住院。' : 'Select the receiving ward and admission reason, then hand the referral to registration.'}</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col p-0" onSubmit={event => { event.preventDefault(); if (receivingWardId !== null && reason.trim() && !write.blocked && !issued) write.mutation.mutate({ operation: 'inpatient.referral.issue', input: { encounterId, encounterVersion, wardId: receivingWardId, reason } }) }}>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <section aria-label={zh ? '当前患者' : 'Current patient'} className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b pb-4 text-sm">
          <strong>{patient.name}</strong>
          <span className="break-all text-muted-foreground">{zh ? '门诊号：' : 'Outpatient number: '}<span>{registrationNumber ?? (zh ? '未分配' : 'Not assigned')}</span></span>
          <p className="basis-full">{zh ? '已确认诊断：' : 'Confirmed diagnoses: '}<span className="text-muted-foreground">{diagnosisConfirmation?.entries.map(entry => entry.display).join('、') || (zh ? '尚未确认诊断' : 'No confirmed diagnosis')}</span></p>
        </section>
        <InpatientWriteRecovery write={write} locale={locale} />
        <FieldSet disabled={write.blocked}><FieldGroup>
        <Field><FieldLabel id="referral-ward-label" htmlFor={wards.length === 1 ? undefined : 'referral-ward'}>{zh ? '收治病区' : 'Receiving ward'}</FieldLabel>
          {wards.length === 1 ? <div aria-labelledby="referral-ward-label" className="text-sm" id="referral-ward" role="group"><span>{wards[0]!.name}</span> <span className="text-muted-foreground">{zh ? '（当前唯一收治病区）' : '(Only receiving ward)'}</span></div>
            : <WorkspaceSelect id="referral-ward" value={receivingWardId} onValueChange={setWardId} items={wards.map(ward => ({ value: ward.id, label: ward.name }))} />}</Field>
        <Field><div className="flex items-baseline justify-between gap-3"><FieldLabel htmlFor="referral-reason">{zh ? '住院原因' : 'Admission reason'}</FieldLabel><span className="text-xs tabular-nums text-muted-foreground" id="referral-reason-count">{reason.length} / 2000</span></div>
          <Textarea aria-describedby="referral-reason-count" id="referral-reason" maxLength={2000} required rows={4} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
        {error ? <p role="alert">{getWorkspaceErrorMessage(error, messages)}</p> : null}
        {issued ? <p role="status" aria-label={zh ? '住院证交接' : 'Admission referral handoff'}>{handoff}</p> : null}
      </FieldGroup></FieldSet></div>
      <OrderComposerFooter hint={hint}>
        <DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="outline" />}>{zh ? '取消' : 'Cancel'}</DialogClose>
        <Button aria-busy={write.mutation.isPending || undefined} data-busy={write.mutation.isPending || undefined} disabled={receivingWardId === null || !reason.trim() || write.blocked || issued} type="submit">{write.mutation.isPending ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{write.mutation.isPending ? (zh ? '正在开具住院证' : 'Issuing referral') : (zh ? '确认开具住院证' : 'Issue referral')}</Button>
      </OrderComposerFooter></form>
    </DialogContent>
  </Dialog></>
}
