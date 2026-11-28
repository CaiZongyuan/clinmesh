"use client"

import * as React from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "#components/tooltip"
import { cn } from "#lib/utils"

interface TruncatedTooltipProps {
  text: string
  className?: string
  side?: "top" | "right" | "bottom" | "left"
}

/**
 * Renders single-line truncated text and only activates a Tooltip when the text
 * genuinely overflows its container (`scrollWidth > clientWidth`).
 */
function TruncatedTooltip({ text, className, side = "top" }: TruncatedTooltipProps) {
  const ref = React.useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = React.useState(false)

  const check = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    setTruncated(el.scrollWidth > el.clientWidth + 1)
  }, [])

  return (
    <Tooltip open={truncated ? undefined : false}>
      <TooltipTrigger
        render={(
          <span
            className={cn("block min-w-0 truncate", className)}
            onFocus={check}
            onMouseEnter={check}
            ref={ref}
          />
        )}
      >
        {text}
      </TooltipTrigger>
      {truncated ? <TooltipContent side={side}>{text}</TooltipContent> : null}
    </Tooltip>
  )
}

export { TruncatedTooltip, type TruncatedTooltipProps }
