import { inpatientCatalogSchema, inpatientReferralResponseSchema } from '@clinmesh/contracts/inpatient'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientReferral({ encounterId, encounterVersion, locale }: {
  encounterId: string; encounterVersion: string; locale: WorkspaceLocale
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [wardId, setWardId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const catalog = useQuery({ queryKey: ['inpatient', 'referral-catalog', encounterId], enabled: open,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/catalog', inpatientCatalogSchema, signal) })
  const issue = useMutation({ mutationFn: () => apiMutation('/api/his/v1/inpatient/referrals', inpatientReferralResponseSchema,
    { input: { encounterId, encounterVersion, wardId, reason } }, { idempotencyKey: newIdempotencyKey() }) })
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button className="self-end" size="sm" variant="outline" />}>{zh ? '开具住院证' : 'Issue admission referral'}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{zh ? '开具住院证' : 'Admission referral'}</DialogTitle>
      <DialogDescription>{zh ? '选择收治病区，说明住院原因；开具后交登记处办理住院。' : 'Select the receiving ward and admission reason, then hand the referral to registration.'}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); issue.mutate() }}><FieldGroup>
        <Field><FieldLabel htmlFor="referral-ward">{zh ? '收治病区' : 'Receiving ward'}</FieldLabel>
          <WorkspaceSelect id="referral-ward" value={wardId} onValueChange={setWardId} items={(catalog.data?.wards ?? []).map(ward => ({ value: ward.id, label: ward.name }))} /></Field>
        <Field><FieldLabel htmlFor="referral-reason">{zh ? '住院原因' : 'Admission reason'}</FieldLabel>
          <Textarea id="referral-reason" maxLength={2000} required value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
        {catalog.error || issue.error ? <p role="alert">{(catalog.error ?? issue.error)?.message}</p> : null}
        {issue.isSuccess ? <p role="status">{zh ? '住院证已开具，请到登记处办理住院' : 'Referral issued. Continue at registration.'}</p> : null}
        <Button disabled={wardId === null || !reason.trim() || issue.isPending || issue.isSuccess} type="submit">{zh ? '确认开具住院证' : 'Issue referral'}</Button>
      </FieldGroup></form>
    </DialogContent>
  </Dialog>
}
