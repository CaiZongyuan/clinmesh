"use client"

import * as React from "react"
import {
  HoverCard as HoverCardPrimitive,
  HoverCardArrow as HoverCardArrowPrimitive,
  HoverCardContent as HoverCardContentPrimitive,
  HoverCardTrigger as HoverCardTriggerPrimitive,
} from "@ui-sdk/react/hover-card"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

const HoverCard = HoverCardPrimitive

function HoverCardTrigger({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof HoverCardTriggerPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <HoverCardTriggerPrimitive
      className={cn(
        "inline-flex items-center gap-1 font-medium text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function HoverCardContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof HoverCardContentPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <HoverCardContentPrimitive
      className={cn(
        "z-50 w-72 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg ring-1 ring-border/60 outline-none data-closed:pointer-events-none",
        className,
      )}
      sideOffset={sideOffset}
      {...omitUndefined(props)}
    >
      {children}
      <HoverCardArrowPrimitive className="size-2 rotate-45 border-t border-l bg-popover" />
    </HoverCardContentPrimitive>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
