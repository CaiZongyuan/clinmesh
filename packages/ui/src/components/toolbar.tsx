"use client"

import * as React from "react"
import {
  Toolbar as ToolbarPrimitive,
  ToolbarButton as ToolbarButtonPrimitive,
  ToolbarSeparator as ToolbarSeparatorPrimitive,
} from "@ui-sdk/react/toolbar"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Toolbar({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ToolbarPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ToolbarPrimitive
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border bg-card p-1 shadow-2xs",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ToolbarButton({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ToolbarButtonPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ToolbarButtonPrimitive
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ToolbarSeparator({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ToolbarSeparatorPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ToolbarSeparatorPrimitive
      className={cn("mx-0.5 h-4 w-px bg-border", className)}
      {...omitUndefined(props)}
    />
  )
}

export { Toolbar, ToolbarButton, ToolbarSeparator }
