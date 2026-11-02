import type { EncounterCompletionPreview, EncounterCompletionTarget } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useRef } from 'react'
import { WorkspaceActionBar } from '../workspace-card-layout.tsx'
import { getWorkspaceErrorMessage } from '../workspace-error.ts'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { encounterCompletionItemLabel, encounterCompletionTargetSectionLabel } from './completion-checklist.tsx'
import type { EncounterCompletionAction } from './doctor-case-support.tsx'

export function DoctorCompletionActionBar({ action, basisCurrent, locale, messages, onBack, onNavigate, preview }: {
  action: Pick<EncounterCompletionAction, 'error' | 'onSubmit' | 'pending'>
  basisCurrent: boolean
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  onBack(): void
  onNavigate(target: EncounterCompletionTarget): void
  preview: EncounterCompletionPreview
}) {
  const confirm = useRef<HTMLButtonElement>(null)
  const zh = locale === 'zh-CN'
  const incomplete = preview.items.filter(item => item.status === 'incomplete')
  const first = incomplete[0]
  const canComplete = basisCurrent && preview.canComplete
  useEffect(() => { if (canComplete) confirm.current?.focus() }, [canComplete])
  return <section aria-label={zh ? '完诊操作' : 'Encounter completion action'}>
    <WorkspaceActionBar tone={canComplete ? 'confirm' : 'blocked'}
      summary={`${zh ? '完诊' : 'Complete'} ${preview.items.length - incomplete.length}/${preview.items.length}`}
      reason={action.error !== null ? getWorkspaceErrorMessage(action.error, messages)
        : !basisCurrent ? (zh ? '完诊条件已变化，请重新核对。' : 'Completion requirements changed. Review them again.')
            : canComplete ? messages.confirmEncounterCompletionDescription
              : incomplete.length === 0 ? (zh ? '暂不能完诊，请重新核对当前病例。' : 'This encounter cannot be completed yet. Review the current case.')
              : `${zh ? '还差：' : 'Required: '}${incomplete.map(item => encounterCompletionItemLabel(item.code, locale)).join(zh ? '、' : ', ')}`}
      action={canComplete ? <>
        <Button disabled={action.pending} onClick={onBack} type="button" variant="outline">{zh ? '返回' : 'Back'}</Button>
        <Button ref={confirm} disabled={action.pending} onClick={action.onSubmit} type="button">
          {action.pending ? messages.completingEncounter : messages.confirmEncounterCompletion}
        </Button>
      </> : first === undefined ? <Button onClick={onBack} type="button" variant="outline">{zh ? '返回核对' : 'Review again'}</Button> : <Button onClick={() => onNavigate(first.target)} type="button">
        {zh ? `前往${encounterCompletionTargetSectionLabel(first.target, messages)}`
          : `Go to ${encounterCompletionTargetSectionLabel(first.target, messages)}`}
      </Button>} />
  </section>
}
