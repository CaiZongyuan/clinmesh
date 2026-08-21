export type PlatformKind = 'web' | 'desktop' | 'mobile'

const platformLabels: Record<PlatformKind, string> = {
  web: 'Web',
  desktop: 'Desktop',
  mobile: 'Mobile',
}

export function platformLabel(platform: PlatformKind): string {
  return platformLabels[platform]
}
