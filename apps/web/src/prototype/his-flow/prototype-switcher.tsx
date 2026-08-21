import { Button } from '@clinmesh/ui/components/button'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect } from 'react'

import type { PrototypeVariant } from './model'

const variants: readonly PrototypeVariant[] = ['A', 'B', 'C']

const variantNames: Record<PrototypeVariant, string> = {
  A: '队列优先',
  B: '患者病历优先',
  C: '流程阶段优先',
}

interface PrototypeSwitcherProps {
  current: PrototypeVariant
  onChange: (variant: PrototypeVariant) => void
}

export function PrototypeSwitcher({ current, onChange }: PrototypeSwitcherProps): React.JSX.Element {
  const currentIndex = variants.indexOf(current)

  const cycle = (offset: number) => {
    const nextIndex = (currentIndex + offset + variants.length) % variants.length
    const next = variants[nextIndex]
    if (next !== undefined) onChange(next)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }

      if (event.key === 'ArrowLeft') cycle(-1)
      if (event.key === 'ArrowRight') cycle(1)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <aside
      aria-label="医生工作台原型方案"
      className="fixed bottom-4 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1 rounded-full border border-foreground/15 bg-foreground px-1.5 text-background shadow-lg"
    >
      <Button
        aria-label="上一个医生工作台方案"
        onClick={() => cycle(-1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronLeftIcon />
      </Button>
      <div className="min-w-32 px-2 text-center text-xs font-medium tabular-nums">
        医生方案 {current} · {variantNames[current]}
      </div>
      <Button
        aria-label="下一个医生工作台方案"
        onClick={() => cycle(1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronRightIcon />
      </Button>
    </aside>
  )
}
