import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clinmesh/ui/components/tooltip'
import { useState } from 'react'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

export function resetImpact(locale: WorkspaceLocale, clearPatientLibrary = false): string {
  if (locale !== 'zh-CN') return clearPatientLibrary
    ? 'Clear the patient library, including source history, Patient Personas and case truth, from the current workspace. Previous clinical records and audits remain archived. Standard catalogs, orderable laboratory services and accounts are retained.'
    : 'Restart clinical progress for registrations, consultations, orders, reports, payments and dispensing. Generated patients, source history, Patient Personas and case truth are retained, and started cases return to registration. Previous records remain archived; standard catalogs, laboratory services and accounts are retained.'
  return clearPatientLibrary
    ? '从当前工作台清空合成患者、来源病史、患者档案和本次病例真值；旧轮次诊疗与审计记录归档，不物理删除。标准目录、可开检验和账号保留。'
    : '重置挂号、问诊、医嘱、报告、收费和发药进度，已开始病例重新进入待就诊状态。合成患者、来源病史、患者档案和本次病例真值保留；旧轮次记录归档，标准目录、可开检验和账号保留。'
}

export function ScenarioResetControl({ disabled, error, locale, onReset, pending }: {
  disabled: boolean
  error: Error | null
  locale: WorkspaceLocale
  onReset: (clearPatientLibrary: boolean) => Promise<unknown>
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [clearPatientLibrary, setClearPatientLibrary] = useState(false)
  const zh = locale === 'zh-CN'
  const confirm = async () => {
    try {
      await onReset(clearPatientLibrary)
      setOpen(false)
    } catch {
      // Mutation 错误由确认框展示，保留选择以便重试。
    }
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button aria-describedby="scenario-reset-impact" disabled={disabled || pending} onClick={() => { setClearPatientLibrary(false); setOpen(true) }} variant="outline" />}>
          {zh ? '重置数据' : 'Reset data'}
        </TooltipTrigger>
        <TooltipContent id="scenario-reset-impact" role="tooltip" className="max-w-sm">{resetImpact(locale)} {zh ? '确认时可选择同时清空患者库。' : 'You can also clear the patient library when confirming.'}</TooltipContent>
      </Tooltip>
      <AlertDialog onOpenChange={value => { if (!pending) setOpen(value) }} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{zh ? '确认重置数据' : 'Confirm data reset'}</AlertDialogTitle>
            <AlertDialogDescription>{resetImpact(locale, clearPatientLibrary)}</AlertDialogDescription>
          </AlertDialogHeader>
          <Field orientation="horizontal">
            <Checkbox checked={clearPatientLibrary} disabled={pending} id="reset-clear-patients" onCheckedChange={value => setClearPatientLibrary(value === true)} />
            <FieldLabel htmlFor="reset-clear-patients">{zh ? '同时清空合成患者库' : 'Also clear the synthetic patient library'}</FieldLabel>
          </Field>
          {error === null ? null : <Alert variant="destructive"><AlertTitle>{zh ? '重置失败' : 'Reset failed'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{zh ? '取消' : 'Cancel'}</AlertDialogCancel>
            <Button disabled={pending} onClick={() => void confirm()} variant="destructive">{pending ? (zh ? '正在重置…' : 'Resetting…') : (zh ? '确认重置' : 'Confirm reset')}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
