import type { WorkspaceLocale } from './workspace-i18n.ts'

export function formatFen(amountFen: number, locale: WorkspaceLocale): string {
  return new Intl.NumberFormat(locale, { currency: 'CNY', style: 'currency' }).format(amountFen / 100)
}
