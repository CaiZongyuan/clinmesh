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
  const write = useInpatientWriteIntent(session, () => undefined)
  const messages = getWorkspaceMessages(locale)
  const error = catalog.error ?? write.storageFailure ?? write.mutation.error
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button className="self-end" size="sm" variant="outline" />}>{zh ? '开具住院证' : 'Issue admission referral'}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{zh ? '开具住院证' : 'Admission referral'}</DialogTitle>
      <DialogDescription>{zh ? '选择收治病区，说明住院原因；开具后交登记处办理住院。' : 'Select the receiving ward and admission reason, then hand the referral to registration.'}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (wardId !== null) write.mutation.mutate({ operation: 'inpatient.referral.issue', input: { encounterId, encounterVersion, wardId, reason } }) }}>
        <InpatientWriteRecovery write={write} locale={locale} />
        <FieldSet disabled={write.blocked}><FieldGroup>
        <Field><FieldLabel htmlFor="referral-ward">{zh ? '收治病区' : 'Receiving ward'}</FieldLabel>
          <WorkspaceSelect id="referral-ward" value={wardId} onValueChange={setWardId} items={(catalog.data?.wards ?? []).map(ward => ({ value: ward.id, label: ward.name }))} /></Field>
        <Field><FieldLabel htmlFor="referral-reason">{zh ? '住院原因' : 'Admission reason'}</FieldLabel>
          <Textarea id="referral-reason" maxLength={2000} required value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
        {error ? <p role="alert">{getWorkspaceErrorMessage(error, messages)}</p> : null}
        {write.mutation.isSuccess ? <p role="status">{zh ? '住院证已开具，请到登记处办理住院' : 'Referral issued. Continue at registration.'}</p> : null}
        <Button disabled={wardId === null || !reason.trim() || write.blocked || write.mutation.isSuccess} type="submit">{zh ? '确认开具住院证' : 'Issue referral'}</Button>
      </FieldGroup></FieldSet></form>
    </DialogContent>
  </Dialog>
}
