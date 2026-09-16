export interface ClientLocalePort {
  getLocale(): { active: unknown }
  subscribe(listener: () => void): () => void
}

/** Normalize the host boundary to the two available ClinMesh catalogs. */
export function normalizeHostLocale(value: unknown): 'zh-CN' | 'en-US' {
  if (typeof value !== 'string' || value.length === 0) return 'zh-CN'
  try {
    const [locale] = Intl.getCanonicalLocales(value)
    return locale?.split('-')[0] === 'zh' ? 'zh-CN' : 'en-US'
  } catch {
    return 'zh-CN'
  }
}
