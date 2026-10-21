import { inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { SessionContext } from '@clinmesh/contracts/his'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

export function InpatientReferral({ encounterId, encounterVersion, locale, session }: {
  encounterId: string; encounterVersion: string; locale: WorkspaceLocale; session: SessionContext
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
  const handoff = zh ? '住院证已开具。下一步：登记员 → 住院登记 → 门诊住院证转收，选择本患者住院证并办理住院；完成后由病区护士接诊分床。' : 'Referral issued. Next: registrar → Admission registration → Outpatient referral. Select this patient’s referral and register the admission, then the ward nurse receives and assigns a bed.'
  return <>{issued && !open ? <p role="status" aria-label={zh ? '住院证交接' : 'Admission referral handoff'} className="text-sm">{handoff}</p> : null}<Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button className="self-end" size="sm" variant="outline" />}>{zh ? '开具住院证' : 'Issue admission referral'}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{zh ? '开具住院证' : 'Admission referral'}</DialogTitle>
      <DialogDescription>{zh ? '选择收治病区，说明住院原因；开具后交登记处办理住院。' : 'Select the receiving ward and admission reason, then hand the referral to registration.'}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (receivingWardId !== null) write.mutation.mutate({ operation: 'inpatient.referral.issue', input: { encounterId, encounterVersion, wardId: receivingWardId, reason } }) }}>
        <InpatientWriteRecovery write={write} locale={locale} />
        <FieldSet disabled={write.blocked}><FieldGroup>
        <Field><FieldLabel htmlFor="referral-ward">{zh ? '收治病区' : 'Receiving ward'}</FieldLabel>
          <WorkspaceSelect id="referral-ward" value={receivingWardId} onValueChange={setWardId} items={wards.map(ward => ({ value: ward.id, label: ward.name }))} /></Field>
        <Field><FieldLabel htmlFor="referral-reason">{zh ? '住院原因' : 'Admission reason'}</FieldLabel>
          <Textarea id="referral-reason" maxLength={2000} required value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
        {error ? <p role="alert">{getWorkspaceErrorMessage(error, messages)}</p> : null}
        {issued ? <p role="status">{handoff}</p> : null}
        <Button disabled={receivingWardId === null || !reason.trim() || write.blocked || issued} type="submit">{zh ? '确认开具住院证' : 'Issue referral'}</Button>
      </FieldGroup></FieldSet></form>
    </DialogContent>
  </Dialog></>
}
