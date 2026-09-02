import type { WorkspaceLocale } from './workspace-i18n.ts'

export function formatFen(amountFen: number, locale: WorkspaceLocale): string {
  return new Intl.NumberFormat(locale, { currency: 'CNY', style: 'currency' }).format(amountFen / 100)
}

export function formatLaboratoryPrice(amountFen: number, locale: WorkspaceLocale): string {
  if (amountFen === 0) return locale === 'zh-CN' ? '未计价' : 'Not priced'
  return formatFen(amountFen, locale)
}
