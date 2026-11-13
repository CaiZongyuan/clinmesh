import { inpatientSurgeryRequestReasonResponseSchema, inpatientSurgeryRequestReasonSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { SessionContext } from '@clinmesh/contracts/his'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { cn } from '@clinmesh/ui/lib/utils'
import { apiGet, apiMutation } from './api-client.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admissionId: string; session: SessionContext; open: boolean; locale: WorkspaceLocale; value: string;
  onChange: (value: string) => void; id: string; disabled: boolean }

export function SurgeryRequestReason({ admissionId, session, open, locale, value, onChange, id, disabled }: Props) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const client = useQueryClient()
  const path = `/api/his/v1/inpatient/admissions/${admissionId}/surgeries/request-reason`
  const scope = [session.user.id, session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId, admissionId]
  const key = ['inpatient', ...scope, 'surgery-request-reason']
  const attempted = useRef<string | null>(null), edited = useRef(false), accepted = useRef(false)
  const [assistant, setAssistant] = useState(false)
  const state = useQuery({ queryKey: key, enabled: open && session.actor.roleCode === 'inpatient-doctor' && !disabled, retry: false,
    queryFn: ({ signal }) => apiGet(path, inpatientSurgeryRequestReasonSchema, signal),
    refetchInterval: query => open && ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1_000 : false,
    refetchIntervalInBackground: false })
  const request = useMutation({ mutationFn: () => apiMutation(path, inpatientSurgeryRequestReasonResponseSchema, { input: {} }, { idempotencyKey: crypto.randomUUID() }),
    retry: false, onSuccess: response => { client.setQueryData(key, response.data) } })
  useEffect(() => {
    const current = state.data
    if (!open || disabled || state.error || state.isFetching || !current || !['idle', 'stale'].includes(current.status) || !current.fingerprint || attempted.current === current.fingerprint) return
    attempted.current = current.fingerprint
    request.mutate()
  }, [open, disabled, state.data, state.error, state.isFetching, request.mutate])
  useEffect(() => {
    if (!open || state.error || state.isFetching || edited.current || accepted.current || value.trim() || state.data?.status !== 'succeeded' || !state.data.reason) return
    accepted.current = true
    setAssistant(true)
    onChange(state.data.reason)
  }, [open, value, state.data, state.error, state.isFetching, onChange])
  return <Field>
    <FieldLabel htmlFor={id}>{t('手术申请理由', 'Surgery request reason')}</FieldLabel>
    {assistant ? <p className="flex flex-wrap items-center gap-1.5 text-xs text-info"><span className="rounded border border-info/40 px-1 py-0.5 font-semibold">{t('助手', 'Assistant')}</span>{t('已按主诊断和最近冠脉造影报告起草，可直接改。', 'Drafted from confirmed diagnoses and the latest coronary angiography report; edit as needed.')}</p> : null}
    <Input id={id} value={value} maxLength={2000} required disabled={disabled} className={cn(assistant && 'border-dashed border-info/50 bg-info/5')}
      onChange={event => { edited.current = true; setAssistant(false); onChange(event.currentTarget.value) }} />
  </Field>
}
