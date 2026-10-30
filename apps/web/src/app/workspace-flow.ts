import type { WorkspaceFlowStep } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function outpatientFlow(locale: WorkspaceLocale): readonly WorkspaceFlowStep[] {
  const zh = locale === 'zh-CN'
  return [
    { value: 'registration', label: zh ? '挂号' : 'Registration' },
    { value: 'triage', label: zh ? '分诊' : 'Triage' },
    { value: 'consultation', label: zh ? '接诊' : 'Consultation' },
    { value: 'billing', label: zh ? '缴费' : 'Payment' },
    { value: 'pharmacy', label: zh ? '发药' : 'Dispensing' },
  ]
}
