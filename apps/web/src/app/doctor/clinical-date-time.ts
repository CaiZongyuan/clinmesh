import type { WorkspaceLocale } from '../workspace-i18n.ts'

const dateTimeFormatters = new Map<WorkspaceLocale, Intl.DateTimeFormat>()
const timeFormatters = new Map<WorkspaceLocale, Intl.DateTimeFormat>()

export function formatClinicalDateTime(value: string, locale: WorkspaceLocale): string {
  let formatter = dateTimeFormatters.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    dateTimeFormatters.set(locale, formatter)
  }
  return formatter.format(new Date(value))
}

export function formatClinicalTime(value: string, locale: WorkspaceLocale): string {
  let formatter = timeFormatters.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    })
    timeFormatters.set(locale, formatter)
  }
  return formatter.format(new Date(value))
}
