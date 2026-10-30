import type { WorkspaceFlowStep } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export type OutpatientFlowState = Partial<Record<'registration' | 'triage' | 'consultation' | 'billing' | 'pharmacy', WorkspaceFlowStep['status']>>

export function outpatientFlow(locale: WorkspaceLocale, state: OutpatientFlowState = {}): readonly WorkspaceFlowStep[] {
  const zh = locale === 'zh-CN'
  const steps: Array<WorkspaceFlowStep & { value: keyof OutpatientFlowState }> = [
    { value: 'registration', label: zh ? '挂号' : 'Registration' },
    { value: 'triage', label: zh ? '分诊' : 'Triage' },
    { value: 'consultation', label: zh ? '接诊' : 'Consultation' },
    { value: 'billing', label: zh ? '缴费' : 'Payment' },
    { value: 'pharmacy', label: zh ? '发药' : 'Dispensing' },
  ]
  return steps.map(step => {
    const status = state[step.value]
    return { ...step, ...(status === undefined ? {} : { status }),
      label: status === 'completed' ? `${step.label} · ${zh ? '已完成' : 'Completed'}` : step.label }
  })
}
