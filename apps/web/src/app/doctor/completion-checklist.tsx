import type { EncounterCompletionItem, EncounterCompletionPreview, EncounterCompletionTarget } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { ArrowRightIcon, CheckCircleIcon, ListChecksIcon } from 'lucide-react'
import { getWorkspaceMessages, type WorkspaceLocale, type WorkspaceMessages } from '../workspace-i18n.ts'

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

/** 完诊检查项去向所在的病例区页签名；放射、病理与检验共用“检验检查”分区。 */
export function encounterCompletionTargetSectionLabel(target: EncounterCompletionTarget, messages: WorkspaceMessages): string {
  if (target === 'diagnosis') return messages.diagnosis
  if (target === 'clinical-document') return messages.medicalRecord
  if (target === 'medication-conclusion') return messages.prescription
  return messages.laboratoryAndExamination
}

function completionGoToLabels(item: EncounterCompletionItem, locale: WorkspaceLocale, messages: WorkspaceMessages): { visible: string; aria: string } {
  const section = encounterCompletionTargetSectionLabel(item.target, messages)
  return {
    visible: messages.encounterCompletionGoTo.replace('{section}', section),
    aria: messages.encounterCompletionGoToAria
      .replace('{section}', section)
      .replace('{item}', encounterCompletionItemLabel(item.code, locale)),
  }
}

export function completionGoToLabel(item: EncounterCompletionItem, locale: WorkspaceLocale, messages: WorkspaceMessages): string {
  return completionGoToLabels(item, locale, messages).aria
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

/**
 * 完诊检查单：呈现全部七项的分层清单。
 * 未完项带项名、服务端状态与“前往对应页签”动作；已完成项折叠为完成清点，不重复展开导航。
 */
export function EncounterCompletionChecklist({ completion, locale, messages, onNavigate }: {
  completion: EncounterCompletionPreview
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  onNavigate?: (target: EncounterCompletionTarget) => void
}): React.JSX.Element {
  const outstanding = completion.items.filter(item => item.status === 'incomplete')
  const completed = completion.items.filter(item => item.status === 'complete')
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {outstanding.length === 0 ? null : (
        <ul className="grid gap-2">
          {outstanding.map(item => {
            const goTo = completionGoToLabels(item, locale, messages)
            return <li className="flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2" key={item.code}>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{encounterCompletionItemLabel(item.code, locale)}</span>
                <span className="truncate text-xs text-muted-foreground">{item.statusText}</span>
              </span>
              {onNavigate === undefined ? null : (
                <Button aria-label={goTo.aria} className="shrink-0"
                  onClick={() => { onNavigate(item.target) }} size="sm" type="button" variant="outline">
                  {goTo.visible}
                  <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                </Button>
              )}
            </li>
          })}
        </ul>
      )}
      {completed.length === 0 ? null : (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="shrink-0">{messages.encounterCompletionCompletedItems
            .replace('{count}', String(completed.length))
            .replace('{total}', String(completion.items.length))}</span>
          <span className="flex min-w-0 flex-wrap gap-x-1.5">
            {completed.map(item => (
              <span key={item.code}>{encounterCompletionItemLabel(item.code, locale)}</span>
            ))}
          </span>
        </p>
      )}
    </div>
  )
}
