export function parseTenderAmounts(amounts: Partial<Record<'cash' | 'bank-card' | 'mobile', string | undefined>>, errorMessage: string) {
  const tenders = (['cash', 'bank-card', 'mobile'] as const).flatMap(method => {
    const value = amounts[method]?.trim() ?? ''
    if (value === '') return []
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error(errorMessage)
    const [yuan, fraction = ''] = value.split('.')
    const amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 1_000_000_000) throw new Error(errorMessage)
    return [{ method, amountFen }]
  })
  return tenders.length === 0 ? undefined : tenders
}
