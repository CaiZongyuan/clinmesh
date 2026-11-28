export type RelaxOptional<T> = {
  [K in keyof T]: {} extends Pick<T, K> ? T[K] | undefined : T[K]
}

export type StripUndefined<T> = {
  [K in keyof T]: Exclude<T[K], undefined>
}

export function omitUndefined<T extends Record<string, unknown>>(
  props: T
): StripUndefined<T> {
  const result: Record<string, unknown> = {}
  for (const key in props) {
    if (props[key] !== undefined) {
      result[key] = props[key]
    }
  }
  return result as StripUndefined<T>
}

export function toTextValue(
  value: string | number | readonly string[] | undefined
): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(",") : String(value)
}
