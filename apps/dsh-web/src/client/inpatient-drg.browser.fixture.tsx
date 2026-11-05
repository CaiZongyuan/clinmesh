import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { inpatientDetailSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import type { SessionContext } from '@clinmesh/contracts/his'
import { InpatientDrgPanel } from '../../../web/src/app/inpatient-drg.tsx'
import { InpatientClinical } from '../../../web/src/app/inpatient-clinical.tsx'
import { InpatientDrgPayer } from '../../../web/src/app/inpatient-drg-payer.tsx'
import { InpatientDrgUsagePanel } from '../../../web/src/app/inpatient-drg-usage.tsx'
import { InpatientMaterialReservations } from '../../../web/src/app/inpatient-surgery-reservations.tsx'
import { InpatientWorkspace } from '../../../web/src/app/inpatient-workspace.tsx'
import { InpatientWriteRecovery } from '../../../web/src/app/inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from '../../../web/src/app/inpatient-write-intent.ts'
import { OrderComposerFooter } from '../../../web/src/app/doctor/order-composer-layout.tsx'
import { apiGet, getSession } from '../../../web/src/app/api-client.ts'

function FollowupHeader({ admission, session, write }: { admission: InpatientAdmission; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent> }) {
  const [dialog, setDialog] = React.useState<'start' | 'stop' | null>(null)
  const [usageOpen, setUsageOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const followup = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-followup'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/followup`, inpatientDrgFollowupSchema, signal) })
  const task = followup.error === null ? followup.data?.task : undefined
  const active = task?.status === 'active'
  const toggle = () => {
    const encounterVersion = followup.data?.encounterVersion ?? admission.versionId
    if (dialog === 'start') {
      write.mutation.mutate({ operation: 'inpatient.drg.followup.start', input: { admissionId: admission.id, encounterVersion, expectedTaskVersion: task?.version ?? 0 } }, {
        onSuccess: () => { setDialog(null); void followup.refetch() },
      })
    } else if (dialog === 'stop' && task && reason.trim()) {
      write.mutation.mutate({ operation: 'inpatient.drg.followup.stop', input: { admissionId: admission.id, encounterVersion, expectedTaskVersion: task.version, reason: reason.trim() } }, {
        onSuccess: () => { setReason(''); setDialog(null); void followup.refetch() },
      })
    }
  }
  return <section aria-label="当前住院患者">
    <button type="button" aria-pressed={active} onClick={() => { setReason(''); setDialog(active ? 'stop' : 'start') }}>助手自动跟进</button>
    <Button type="button" variant="link" size="sm" onClick={() => setUsageOpen(true)}>本次住院 AI 用量</Button>
    <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>本次住院 AI 用量</DialogTitle>
          <DialogDescription className="sr-only">本次住院的 AI 调用明细与额度使用</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <InpatientDrgUsagePanel admissionId={admission.id} taskId={task?.id} taskKind={task ? 'followup' : 'estimate'} session={session} locale="zh-CN" active={usageOpen} />
        </div>
        <OrderComposerFooter hint="按患者住院累计展示本次住院 AI 调用">
          <DialogClose render={<Button type="button" variant="outline" />}>关闭</DialogClose>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !write.mutation.isPending) setDialog(null) }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{dialog === 'stop' ? '停止助手自动跟进' : '开启助手自动跟进'}</DialogTitle>
          <DialogDescription className="sr-only">{dialog === 'stop' ? '停止本次住院的助手自动跟进' : '开启本次住院的助手自动跟进'}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 p-4 text-sm">
          {dialog === 'stop' ? <Field>
            <FieldLabel htmlFor={`follow-stop-reason-${admission.id}`}>停止理由（必填）</FieldLabel>
            <Input id={`follow-stop-reason-${admission.id}`} value={reason} onChange={event => setReason(event.currentTarget.value)} maxLength={2000} />
          </Field> : <p>开启后，本次住院内诊断、手术或费用变化时，助手自动：</p>}
        </div>
        <OrderComposerFooter hint={dialog === 'stop' ? (reason.trim() ? '确认后停止' : '还差：停止理由') : '每次住院只需开一次'}>
          <DialogClose render={<Button type="button" variant="ghost" />}>取消</DialogClose>
          <Button type="button" disabled={write.blocked || (dialog === 'stop' && !reason.trim())} onClick={toggle}>{dialog === 'stop' ? '确认停止' : '开启'}</Button>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
  </section>
}

function Fixture({ session }: { session: SessionContext }) {
  const client = useQueryClient()
  const detail = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, document.documentElement.dataset.admissionId, 'detail'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${document.documentElement.dataset.admissionId}`, inpatientDetailSchema, signal) })
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  return <><InpatientWriteRecovery write={write} locale="zh-CN" />{detail.data ? session.actor.roleCode === 'medical-insurance'
    ? <InpatientDrgPayer admission={detail.data.admission} session={session} locale="zh-CN" write={write} />
    : document.documentElement.dataset.view === 'clinical'
      ? <InpatientClinical admission={detail.data.admission} session={session} locale="zh-CN" write={write} />
      : document.documentElement.dataset.view === 'reservations'
        ? <InpatientMaterialReservations admission={detail.data.admission} session={session} locale="zh-CN" write={write} />
        : <><FollowupHeader admission={detail.data.admission} session={session} write={write} /><InpatientDrgPanel admission={detail.data.admission} session={session} locale="zh-CN" write={write} /></> : null}</>
}
const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'large'
container.dataset.theme = 'light'
container.style.cssText = 'padding:16px;min-width:0'
shadow.append(container)
void getSession().then(session => {
  createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortalContainerProvider container={container}>{document.documentElement.dataset.view === 'workspace' ? <InpatientWorkspace session={session} locale="zh-CN" /> : <Fixture session={session} />}</PortalContainerProvider></QueryClientProvider>)
})
