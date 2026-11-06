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
  if (status === 'awaiting-dispense') {
    state.billing = 'completed'
  }
  const current = caseFlowStep[status]
  if (current !== undefined) state[current] = 'current'
  return state
}

export function outpatientFlow(locale: WorkspaceLocale, state: OutpatientFlowState = {}): readonly WorkspaceFlowStep[] {
  const zh = locale === 'zh-CN'
  const resolved: OutpatientFlowState = { ...state }
  if (resolved.pharmacy !== undefined) {
    resolved.registration ??= 'completed'
    resolved.triage ??= 'completed'
    resolved.billing ??= 'completed'
  } else if (resolved.billing !== undefined) {
    resolved.registration ??= 'completed'
    resolved.triage ??= 'completed'
  }
  const steps: Array<WorkspaceFlowStep & { value: keyof OutpatientFlowState }> = [
    { value: 'registration', label: zh ? '挂号' : 'Registration' },
    { value: 'triage', label: zh ? '分诊' : 'Triage' },
    { value: 'consultation', label: zh ? '接诊' : 'Consultation' },
    { value: 'billing', label: zh ? '缴费' : 'Payment' },
    { value: 'pharmacy', label: zh ? '发药' : 'Dispensing' },
  ]
  return steps.map(step => {
    const status = resolved[step.value]
    return { ...step, ...(status === undefined ? {} : { status }), label: step.label }
  })
}
