import type { WorkspaceLocale } from './workspace-i18n.ts'

export function yuanToFen(value: string): number | undefined {
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(value)
  if (match === null) return undefined
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : undefined
}

export function formatFen(amountFen: number, locale: WorkspaceLocale): string {
  return new Intl.NumberFormat(locale, { currency: 'CNY', style: 'currency' }).format(amountFen / 100)
}

export function formatLaboratoryPrice(amountFen: number, locale: WorkspaceLocale): string {
  if (amountFen === 0) return locale === 'zh-CN' ? '未计价' : 'Not priced'
  return formatFen(amountFen, locale)
}
