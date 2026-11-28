"use client"

import * as React from "react"
import {
  ScrollArea as ScrollAreaPrimitive,
  ScrollAreaContent as ScrollAreaContentPrimitive,
  ScrollAreaScrollbar as ScrollAreaScrollbarPrimitive,
  ScrollAreaThumb as ScrollAreaThumbPrimitive,
  ScrollAreaViewport as ScrollAreaViewportPrimitive,
} from "@ui-sdk/react/scroll-area"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ScrollAreaPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ScrollAreaPrimitive
      className={cn("relative overflow-hidden", className)}
      {...omitUndefined(props)}
    >
      <ScrollAreaViewportPrimitive className="h-full w-full overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ScrollAreaContentPrimitive>{children}</ScrollAreaContentPrimitive>
      </ScrollAreaViewportPrimitive>
      <ScrollAreaScrollbarPrimitive
        className="pointer-events-none absolute top-0.5 right-0.5 bottom-0.5 flex w-1.5 touch-none p-px transition-opacity select-none"
        orientation="vertical"
      >
        <ScrollAreaThumbPrimitive className="relative flex-1 rounded-full bg-border hover:bg-muted-foreground/40" />
      </ScrollAreaScrollbarPrimitive>
    </ScrollAreaPrimitive>
  )
}

export { ScrollArea }
