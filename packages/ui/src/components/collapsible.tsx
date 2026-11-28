"use client"

import * as React from "react"
import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel as CollapsiblePanelPrimitive,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from "@ui-sdk/react/collapsible"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type CollapsibleProps = RelaxOptional<
  Omit<React.ComponentProps<typeof CollapsiblePrimitive>, "className">
> & {
  className?: string | undefined
}

function Collapsible({ className, ...props }: CollapsibleProps) {
  return (
    <CollapsiblePrimitive
      className={cn("w-full", className)}
      {...omitUndefined(props)}
    />
  )
}

type CollapsibleTriggerProps = RelaxOptional<
  Omit<React.ComponentProps<typeof CollapsibleTriggerPrimitive>, "className">
> & {
  className?: string | undefined
}

function CollapsibleTrigger({ className, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsibleTriggerPrimitive
      className={cn(
        "inline-flex items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

type CollapsiblePanelProps = RelaxOptional<
  Omit<React.ComponentProps<typeof CollapsiblePanelPrimitive>, "className">
> & {
  className?: string | undefined
}

function CollapsiblePanel({ className, ...props }: CollapsiblePanelProps) {
  return (
    <CollapsiblePanelPrimitive
      className={cn("overflow-hidden", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  type CollapsiblePanelProps,
  type CollapsibleProps,
  type CollapsibleTriggerProps,
}
