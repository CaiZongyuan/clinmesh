import { Motion } from 'ai-motion'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** One canvas per visible work area; drawing follows Agent execution only. */
export function AgentWorkspaceGlow({ active, completed, dark, style }: {
  active: boolean
  completed: boolean
  dark: boolean
  style: CSSProperties
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [retained, setRetained] = useState(false)
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'undefined'
    || matchMedia('(prefers-reduced-motion: reduce)').matches)
  const motion = useRef<Motion | undefined>(undefined)
  const running = useRef(active)
  running.current = active
  const visible = active || completed
  const mounted = visible || retained

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(preference.matches)
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    if (visible) { setRetained(true); return }
    const timer = setTimeout(() => setRetained(false), 800)
    return () => clearTimeout(timer)
  }, [visible])
  useLayoutEffect(() => {
    const container = host.current
    if (!mounted || reduced || container === null) return
    let instance: Motion | undefined
    let observer: ResizeObserver | undefined
    let size = container.getBoundingClientRect()
    const update = (): void => {
      if (running.current && !document.hidden && !container.hasAttribute('data-fallback')) instance?.start()
      else instance?.pause()
    }
    const lost = (): void => {
      instance?.pause()
      motion.current = undefined
      container.dataset.fallback = ''
    }
    try {
      instance = new Motion({
        width: size.width, height: size.height,
        mode: dark ? 'dark' : 'light', borderWidth: 1.5,
        glowWidth: dark ? 55 : 40, borderRadius: 8,
        styles: { position: 'absolute', inset: '0', pointerEvents: 'none' },
      })
      motion.current = instance
      container.append(instance.element)
      // The library's resize() skips drawing while paused. Resize the retained
      // completion frame explicitly without restarting its animation loop.
      observer = new ResizeObserver(() => {
        const next = container.getBoundingClientRect()
        if (next.width === size.width && next.height === size.height || container.hasAttribute('data-fallback')) return
        size = next
        instance?.start()
        instance?.resize(size.width, size.height)
        update()
      })
      observer.observe(container)
      instance.element.addEventListener('webglcontextlost', lost)
      document.addEventListener('visibilitychange', update)
      // start() draws synchronously. A batched fast completion still needs one
      // result frame; update() immediately pauses it unless execution continues.
      instance.start()
      update()
    } catch {
      instance?.dispose()
      motion.current = undefined
      container.dataset.fallback = ''
    }
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', update)
      instance?.element.removeEventListener('webglcontextlost', lost)
      instance?.dispose()
      motion.current = undefined
      delete container.dataset.fallback
    }
  }, [mounted, dark, reduced])
  useLayoutEffect(() => {
    if (active && !document.hidden) motion.current?.start()
    else motion.current?.pause()
  }, [active])
  return <div ref={host} className="clinmesh-agent-workspace-glow" style={style}
    data-active={active || undefined} data-visible={visible || undefined}
    data-static={reduced || undefined} aria-hidden="true" />
}
