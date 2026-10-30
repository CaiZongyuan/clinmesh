import type { WorkspaceFlowStep } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export type OutpatientFlowState = Partial<Record<'registration' | 'triage' | 'consultation' | 'billing' | 'pharmacy', WorkspaceFlowStep['status']>>

const caseFlowStep: Readonly<Record<string, keyof OutpatientFlowState>> = {
  'awaiting-triage': 'triage', 'awaiting-doctor': 'consultation', 'first-visit': 'consultation',
  'awaiting-lab-payment': 'billing', 'awaiting-lis': 'consultation', 'awaiting-report': 'consultation',
  'awaiting-revisit': 'consultation', 'revisit-draft': 'consultation',
  'awaiting-medication-payment': 'billing', 'awaiting-dispense': 'pharmacy',
}

export function outpatientCaseFlowState(status: string): OutpatientFlowState {
  const state: OutpatientFlowState = { registration: 'completed' }
  if (status !== 'awaiting-triage') state.triage = 'completed'
  if (status === 'completed') state.consultation = 'completed'
  const current = caseFlowStep[status]
  if (current !== undefined) state[current] = 'current'
  return state
}

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
