import type { EncounterCompletionItem, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
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

export function EncounterCompletionChecklist({ completion, locale }: {
  completion: EncounterCompletionPreview
  locale: WorkspaceLocale
}): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const completed = completion.items.filter(item => item.status === 'complete').length
  const headingId = `completion-heading-${completion.encounterId}`
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/15 px-4 py-0 @min-[400px]/case-content:py-2">
      <div className="flex shrink-0 items-center gap-3">
        <h3 className="sr-only text-sm font-semibold @min-[400px]/case-content:not-sr-only" id={headingId}>{messages.encounterCompletionChecklist}</h3>
        <span className="text-xs text-muted-foreground" aria-label={messages.encounterCompletionSatisfied
            .replace('{complete}', String(completed))
            .replace('{total}', String(completion.items.length))}>
          {completed} / {completion.items.length}
        </span>
      </div>
      <ul className="flex min-w-0 flex-1 flex-wrap gap-x-1 gap-y-0.5 @min-[400px]/case-content:gap-2">
        {completion.items.map(item => (
          <li className="flex w-28" key={item.code}>
            <Badge
              className="h-auto min-h-5 w-full whitespace-normal text-center @min-[400px]/case-content:min-h-6"
              aria-label={`${checklistLabels[locale][item.code]}：${item.statusText}`}
              title={item.statusText}
              variant={item.status === 'complete' ? 'success' : 'secondary'}
            >
              {checklistLabels[locale][item.code]}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}
