import type { EncounterCompletionItem, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { CheckCircleIcon, ListChecksIcon } from 'lucide-react'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'

const checklistLabels: Record<WorkspaceLocale, Record<EncounterCompletionItem['code'], string>> = {
  'zh-CN': {
    'primary-diagnosis-confirmed': '主诊断确认',
    'clinical-document-signed': '门诊病历签署',
    'required-reports-acknowledged': '必需报告查阅',
    'medication-conclusion-recorded': '用药结论记录',
    'no-pending-drafts': '待提交草稿处理',
    'disposition-complete': '处置方案',
    'follow-up-complete': '随访安排',
  },
  'en-US': {
    'primary-diagnosis-confirmed': 'Primary diagnosis',
    'clinical-document-signed': 'Record signed',
    'required-reports-acknowledged': 'Reports reviewed',
    'medication-conclusion-recorded': 'Medication plan',
    'no-pending-drafts': 'Drafts resolved',
    'disposition-complete': 'Disposition',
    'follow-up-complete': 'Follow-up',
  },
}

export function encounterCompletionItemLabel(code: EncounterCompletionItem['code'], locale: WorkspaceLocale): string {
  return checklistLabels[locale][code]
}

/** 患者横幅内的完诊进度摘要：计数加未完项数量，逐项明细见建议栈。 */
export function EncounterCompletionProgress({ completion, locale }: {
  completion: EncounterCompletionPreview
  locale: WorkspaceLocale
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const completed = completion.items.filter(item => item.status === 'complete').length
  const outstanding = completion.items.length - completed
  return (
    <span aria-label={messages.encounterCompletionSatisfied
        .replace('{complete}', String(completed))
        .replace('{total}', String(completion.items.length))}
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ListChecksIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="font-medium tabular-nums">{completed} / {completion.items.length}</span>
      {outstanding > 0 ? <span>{messages.encounterCompletionOutstanding.replace('{count}', String(outstanding))}</span> : (
        <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
    </span>
  )
}
