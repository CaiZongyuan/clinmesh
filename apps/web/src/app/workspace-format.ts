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

/** 上海时间精确到分钟（YYYY-MM-DD HH:mm），住院记录与办理事件不显示秒。 */
export function formatShanghaiMinute(value: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
