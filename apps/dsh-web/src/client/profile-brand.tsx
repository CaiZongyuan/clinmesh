import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  SidebarBrandMarkOwnerProps,
  SidebarBrandNameOwnerProps,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import clinmeshMarkUrl from '../../../web/src/assets/clinmesh-mark.webp'

// Profile identity takes precedence over the runtime's active-Surface identity (-100).
const PROFILE_BRAND_PRIORITY = -200

function ClinMeshBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <img
      alt="ClinMesh"
      src={clinmeshMarkUrl}
      width={size}
      height={size}
      style={{ display: 'block', flex: '0 0 auto', objectFit: 'contain', borderRadius: 4 }}
    />
  )
}

function ClinMeshBrandName(_props: SidebarBrandNameOwnerProps) {
  return (
    <span
      style={{
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 16,
        fontWeight: 650,
        whiteSpace: 'nowrap',
      }}
    >
      ClinMesh
    </span>
  )
}

/** Profile identity survives Surface navigation; unloading this plugin releases both slots. */
export function registerProfileBrand(ctx: ClientContext): () => void {
  const disposeMark = ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register(
      {
        name: 'sidebar.brand.mark',
        priority: PROFILE_BRAND_PRIORITY,
        registrant: 'clinmesh-profile-brand',
      },
      ClinMeshBrandMark,
    ),
  )
  const disposeName = ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register(
      {
        name: 'sidebar.brand.name',
        priority: PROFILE_BRAND_PRIORITY,
        registrant: 'clinmesh-profile-brand',
      },
      ClinMeshBrandName,
    ),
  )
  return () => {
    disposeName()
    disposeMark()
  }
}
