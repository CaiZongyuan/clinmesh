import { useState } from 'react'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import type { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import type { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { InpatientGuidelineAdvicePanel } from './inpatient-guideline-advice.tsx'
import { InpatientMaterialPlanBasisDetails } from './inpatient-material-plan.tsx'
import { InpatientMaterialReservations } from './inpatient-surgery-reservations.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type Props = {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>; plan: z.infer<typeof inpatientSurgeryRequestSchema>
  estimate: InpatientMaterialEstimate | undefined; selection: z.infer<typeof inpatientPciSelectionSchema> | undefined
  onOpenUsage: ((taskId?: string, taskKind?: 'estimate' | 'followup' | 'explanation' | 'guideline') => void) | undefined
}

export function InpatientSurgeryDetails({ admission, session, locale, write, plan, estimate, selection, onOpenUsage }: Props) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<'estimate' | 'guideline' | 'reservations' | null>(null)
  const parameters = selection?.drafts?.find(draft => draft.requestId === plan.id)?.parameters
    ?? (selection?.confirmation?.parameters.requestId === plan.id ? selection.confirmation.parameters : undefined)
  const title = detail === 'estimate' ? t('完整预计依据与扩展参数', 'Estimate evidence and extended parameters')
    : detail === 'guideline' ? t('完整指南依据', 'Full guideline evidence') : t('手工预留维护', 'Manual reservation maintenance')
  const writable = admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const estimateError = detail === 'estimate' && write.mutation.variables?.operation === 'inpatient.material-estimate.request'
    && write.mutation.variables.input.admissionId === admission.id && write.mutation.variables.input.requestId === plan.id
    ? write.mutation.error : null
  const categoryNames = { guidewire: t('导丝', 'Guidewire'), 'guiding-catheter': t('指引导管', 'Guiding catheter'), balloon: t('球囊', 'Balloon'), stent: t('支架', 'Stent') }
  const labels = [['estimate', t('预计依据', 'Estimate evidence')], ['guideline', t('指南详情', 'Guideline details')], ['reservations', t('手工预留维护', 'Manual reservations')]] as const
  return <Dialog open={open} pending={write.mutation.isPending} onOpenChange={setOpen}>
    {labels.filter(([kind]) => kind === 'reservations' || kind === 'estimate' && (estimate || parameters) || kind === 'guideline' && selection).map(([kind, label]) => <DialogTrigger key={kind} render={<Button type="button" variant="ghost" size="sm" />} onClick={() => { setDetail(kind); setOpen(true) }}>{label}</DialogTrigger>)}
    <DialogContent keepMounted={detail !== null} className="h-[min(85svh,800px)] sm:max-w-[800px]" showCloseButton={!write.mutation.isPending}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{plan.plannedProcedure.coding.display}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {estimateError ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(estimateError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
        {detail === 'estimate' ? <>
          {parameters ? <section aria-label={t('已保存的扩展参数', 'Saved extended parameters')} className="flex flex-col gap-2 text-sm">
            <h4 className="font-medium">{t('选型参数与测量来源', 'Selection parameters and measurement sources')}</h4>
            <p>{parameters.targetSite} · {parameters.treatmentPlan}</p>
            {parameters.measurements.map(measurement => <p key={measurement.kind}>{measurement.site} · {measurement.value ?? t('未测', 'Unmeasured')} {measurement.unit ?? ''} · {measurement.method} · {measurement.source.note}</p>)}
            {parameters.plannedQuantities.map(item => <p key={item.category}>{categoryNames[item.category]} × {item.quantity ?? t('未确定', 'Undetermined')} · {item.basis}</p>)}
          </section> : null}
          {estimate ? <section aria-label={t('耗材预计完整依据', 'Full material estimate evidence')} className="flex flex-col gap-3 text-sm">
            {estimate.missing.length ? <Alert><AlertDescription>{estimate.missing.join(' · ')}</AlertDescription></Alert> : null}
            {estimate.analysis ? <>
              <p>{t('生成时间：', 'Generated: ')}{formatShanghaiMinute(estimate.analysis.createdAt)}</p>
              {estimate.analysis.items.map(item => <div key={item.materialId} className="flex flex-col gap-1"><h5 className="font-medium">{item.display} × {item.quantity} {item.unit}</h5><p>{item.reason}</p><p className="text-muted-foreground">{item.quantityBasis}</p></div>)}
              {estimate.analysis.sources.materialEvidence.map(evidence => <div key={evidence.id} className="flex flex-col gap-1"><p>{evidence.specification} · {evidence.quantityBasis}</p><p className="text-muted-foreground">{evidence.scope} · {evidence.applicability} · {evidence.compatibility}</p><p className="break-words text-xs text-muted-foreground">{evidence.sourceLocator}</p></div>)}
            </> : <p>{t('尚无成功生成的预计快照，可在主流程手工填写。', 'No successful estimate snapshot is available. Enter materials in the main workflow.')}</p>}
            {estimate.planBasis ? <InpatientMaterialPlanBasisDetails basis={estimate.planBasis} locale={locale} procedureDisplay={plan.plannedProcedure.coding.display} /> : null}
            {estimate.status === 'unknown' && onOpenUsage ? <DialogClose render={<Button type="button" variant="outline" className="self-start" />} onClick={() => onOpenUsage(estimate.id, 'estimate')}>{t('核查原预计请求', 'Check original estimate request')}</DialogClose> : null}
            {writable && !['unknown', 'queued', 'running'].includes(estimate.status) ? <Button type="button" variant="outline" className="self-start" disabled={write.blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.request', input: { admissionId: admission.id, requestId: plan.id, expectedVersion: estimate.version, expectedRequestVersion: estimate.requestVersion, expectedBasisFingerprint: estimate.basisFingerprint } })}>{t('重新预计，保留耗材清单', 'Re-estimate and retain material list')}</Button> : null}
          </section> : null}
        </> : null}
        {detail === 'guideline' ? <InpatientGuidelineAdvicePanel admission={admission} session={session} locale={locale} write={write} requestId={plan.id} canReassess={writable} active={open} /> : null}
        {detail === 'reservations' ? <InpatientMaterialReservations admission={admission} session={session} locale={locale} write={write} active={open} requestId={plan.id} /> : null}
      </div>
      <OrderComposerFooter hint={t('关闭后继续手术主流程', 'Close to continue the surgery workflow')}><DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose></OrderComposerFooter>
    </DialogContent>
  </Dialog>
}
