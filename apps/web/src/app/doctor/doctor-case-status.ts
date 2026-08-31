import { getWorkspaceMessages } from '../workspace-i18n.ts'

export function doctorCaseStatusLabel(
  status: string,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (status === 'awaiting-doctor') return messages.status_awaitingDoctor
  if (status === 'first-visit') return messages.status_firstVisit
  if (status === 'awaiting-report') return messages.status_awaitingReport
  if (status === 'awaiting-revisit') return messages.status_awaitingRevisit
  if (status === 'revisit-draft') return messages.status_revisitDraft
  return status
}
