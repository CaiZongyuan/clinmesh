import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { FieldDescription, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useState } from 'react'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { getWorkspaceMessages } from '../workspace-i18n.ts'
import { DoctorDraftField as Field } from './doctor-draft-fields.tsx'

export interface ClinicalVisitKindAction {
  error: Error | null
  pending: boolean
  onSubmit: (input: { visitKind: 'initial' | 'follow-up'; reason: string }) => Promise<unknown>
}

export function ClinicalVisitKindControl({ context, action, messages }: {
  context: DoctorCaseDetail['clinicalHistory']
  action: ClinicalVisitKindAction | undefined
  messages: ReturnType<typeof getWorkspaceMessages>
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [visitKind, setVisitKind] = useState<'initial' | 'follow-up'>('initial')
  const [reason, setReason] = useState('')
  if (!context) return null
  const relevant = context.reason === 'context-incomplete' || context.reason.startsWith('specialty-') || context.visitKind !== 'unknown'
  if (!relevant) return null
  return <div className="flex flex-wrap items-center gap-2">
    {context.reason === 'context-incomplete' ? <FieldDescription>{messages.clinicalHistoryContextUnknown}</FieldDescription> : null}
    {context.reason === 'specialty-initial' ? <FieldDescription>{messages.clinicalHistorySpecialtyRequired}</FieldDescription> : null}
    {!context.classificationEditable || !action ? null : <Dialog pending={action.pending} open={open} onOpenChange={value => {
        if (value) { setVisitKind(context.visitKind === 'follow-up' ? 'follow-up' : 'initial'); setReason('') }
      setOpen(value)
    }}>
      <DialogTrigger render={<Button disabled={action.pending} variant="outline" size="sm" type="button" />}>{messages.clinicalVisitConfirm}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{messages.clinicalVisitConfirm}</DialogTitle><DialogDescription>{messages.clinicalVisitDescription}</DialogDescription></DialogHeader>
        <form aria-label={messages.clinicalVisitConfirm} onSubmit={async event => {
          event.preventDefault()
          try { await action.onSubmit({ visitKind, reason: reason.trim() }); setOpen(false) } catch { /* Mutation owns the displayed error. */ }
        }}>
          <FieldGroup>
            <Field><FieldLabel>{messages.clinicalVisitKind}</FieldLabel>
              <ToggleGroup variant="outline" value={[visitKind]} disabled={action.pending} aria-label={messages.clinicalVisitKind}
                onValueChange={values => { const value = values[0]; if (value === 'initial' || value === 'follow-up') setVisitKind(value) }}>
                <ToggleGroupItem value="initial">{messages.clinicalVisitInitial}</ToggleGroupItem>
                <ToggleGroupItem value="follow-up">{messages.clinicalVisitFollowUp}</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field><FieldLabel htmlFor="clinical-visit-reason">{messages.clinicalVisitReason}</FieldLabel>
              <Input id="clinical-visit-reason" value={reason} onChange={event => setReason(event.currentTarget.value)} minLength={2} maxLength={500} required disabled={action.pending} />
            </Field>
            {action.error === null ? null : <p role="alert">{getWorkspaceErrorMessage(action.error, messages)}</p>}
            <Button type="submit" disabled={action.pending || reason.trim().length < 2}>{messages.clinicalVisitConfirm}</Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>}
  </div>
}
