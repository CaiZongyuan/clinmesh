import { useLayoutEffect, useRef, useState } from 'react'

/** Observe only breakpoint crossings, not every pixel during a panel drag. */
export function useContainerCompact(breakpoint: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const width = element.getBoundingClientRect().width
      if (width > 0) setCompact(width < breakpoint)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [breakpoint])
  return { ref, compact }
}
