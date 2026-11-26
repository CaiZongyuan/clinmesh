import type { z } from 'zod';

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
