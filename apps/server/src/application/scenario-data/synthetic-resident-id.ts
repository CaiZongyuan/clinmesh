const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const

export function withResidentIdChecksum(body: string): string {
  if (!/^\d{17}$/.test(body)) throw new Error('Synthetic resident ID body must contain 17 digits')
  const checksumIndex = body.split('').reduce((sum, digit, index) => (
    sum + Number(digit) * (weights[index] ?? 0)
  ), 0) % 11
  return `${body}${checks[checksumIndex]}`
}

export function hasValidResidentIdChecksum(value: string): boolean {
  return /^\d{17}[\dX]$/.test(value) && withResidentIdChecksum(value.slice(0, 17)) === value
}
