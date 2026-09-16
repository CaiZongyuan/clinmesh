import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  SidebarBrandMarkOwnerProps,
  SidebarBrandNameOwnerProps,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import clinmeshMarkUrl from '../../../web/src/assets/clinmesh-mark.webp'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'

// Profile identity takes precedence over the runtime's active-Surface identity (-100).
const PROFILE_BRAND_PRIORITY = -200

function createHeroBrand(locale: ClientLocalePort) {
  const subscribe = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  return function ClinMeshHeroBrand({ size, className }: HeroBrandMarkOwnerProps) {
    const mark = useRef<HTMLSpanElement>(null)
    const language = useSyncExternalStore(subscribe, getLocale, getLocale)
    const headline = getWorkspaceMessages(language).productTagline
    useLayoutEffect(() => {
      // DSH RC exposes a mark slot, but its adjacent headline has no replacement API.
      const slot = mark.current?.closest('[data-slot="conversation.hero.brand.mark"]')
      const nativeHeadline = slot?.parentElement?.nextElementSibling?.firstElementChild
      if (
        !(nativeHeadline instanceof HTMLElement) ||
        nativeHeadline.childNodes.length !== 1 ||
        nativeHeadline.firstChild?.nodeType !== Node.TEXT_NODE
      )
        return
      let original = nativeHeadline.textContent ?? ''
      nativeHeadline.textContent = headline
      const observer = new MutationObserver(() => {
        if (
          nativeHeadline.childNodes.length !== 1 ||
          nativeHeadline.firstChild?.nodeType !== Node.TEXT_NODE
        )
          return
        if (nativeHeadline.textContent === headline) return
        original = nativeHeadline.textContent ?? ''
        nativeHeadline.textContent = headline
      })
      observer.observe(nativeHeadline, { childList: true, characterData: true, subtree: true })
      return () => {
        observer.disconnect()
        if (nativeHeadline.textContent === headline) nativeHeadline.textContent = original
      }
    }, [headline])
    return (
      <span ref={mark} className={className} data-clinmesh-hero-brand="">
        <ClinMeshBrandMark size={size} />
      </span>
    )
  }
}

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

function createBrandName(locale: ClientLocalePort) {
  const subscribe = (listener: () => void) => locale.subscribe(listener)
  const getLocale = () => normalizeHostLocale(locale.getLocale().active)
  return function ClinMeshBrandName(_props: SidebarBrandNameOwnerProps) {
    const language = useSyncExternalStore(subscribe, getLocale, getLocale)
    return (
      <span
        style={{
          color: 'var(--dsw-alias-label-primary)',
          fontSize: 16,
          fontWeight: 650,
          whiteSpace: 'nowrap',
        }}
      >
        {language === 'zh-CN' ? '科灵脉智' : 'ClinMesh'}
      </span>
    )
  }
}

/** Profile identity survives Surface navigation; unloading this plugin releases both slots. */
export function registerProfileBrand(ctx: ClientContext): () => void {
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const HeroBrand = createHeroBrand(locale)
  const BrandName = createBrandName(locale)
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
      BrandName,
    ),
  )
  const disposeHero = ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.brand.mark',
        priority: PROFILE_BRAND_PRIORITY,
        registrant: 'clinmesh-profile-brand',
      },
      HeroBrand,
    ),
  )
  return () => {
    disposeHero()
    disposeName()
    disposeMark()
  }
}
