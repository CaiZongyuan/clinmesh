import { Button } from '@clinmesh/ui/components/button'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect } from 'react'

import type { AssistantVariant } from './model'

const variants: readonly AssistantVariant[] = ['A', 'B', 'C']

const variantNames: Record<AssistantVariant, string> = {
  A: '常驻协作栏',
  B: '按需任务面板',
  C: '上下文内联',
}

export function AssistantPrototypeSwitcher({
  current,
  onChange,
}: {
  current: AssistantVariant
  onChange: (variant: AssistantVariant) => void
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) return

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const currentIndex = variants.indexOf(current)
      const offset = event.key === 'ArrowLeft' ? -1 : 1
      const next = variants[(currentIndex + offset + variants.length) % variants.length]
      if (next !== undefined) onChange(next)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, onChange])

  const cycle = (offset: number) => {
    const currentIndex = variants.indexOf(current)
    const next = variants[(currentIndex + offset + variants.length) % variants.length]
    if (next !== undefined) onChange(next)
  }

  return (
    <aside aria-label="DSH 助手融合原型方案" className="fixed bottom-4 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1 rounded-full border border-foreground/15 bg-foreground px-1.5 text-background shadow-lg">
      <Button aria-label="上一个助手融合方案" onClick={() => cycle(-1)} size="icon-sm" variant="ghost"><ChevronLeftIcon /></Button>
      <div className="min-w-36 whitespace-nowrap px-2 text-center text-xs font-medium tabular-nums">助手方案 {current} · {variantNames[current]}</div>
      <Button aria-label="下一个助手融合方案" onClick={() => cycle(1)} size="icon-sm" variant="ghost"><ChevronRightIcon /></Button>
    </aside>
  )
}
