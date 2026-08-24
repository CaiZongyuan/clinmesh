export function allergyWarningLabel(warning: unknown): string {
  if (typeof warning === 'string') return warning
  if (typeof warning !== 'object' || warning === null) return String(warning)
  const value = warning as Record<string, unknown>
  if (typeof value.display === 'string') return value.display
  if (typeof value.code !== 'object' || value.code === null) return JSON.stringify(warning)
  const code = value.code as Record<string, unknown>
  if (typeof code.text === 'string') return code.text
  const coding = Array.isArray(code.coding) ? code.coding : []
  for (const candidate of coding) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const entry = candidate as Record<string, unknown>
    if (typeof entry.display === 'string') return entry.display
    if (typeof entry.code === 'string') return entry.code
  }
  return JSON.stringify(warning)
}
