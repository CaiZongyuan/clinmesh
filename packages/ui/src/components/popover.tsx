"use client"

import * as React from "react"
import {
  Popover as PopoverPrimitive,
  PopoverClose as PopoverClosePrimitive,
  PopoverContent as PopoverContentPrimitive,
  PopoverDescription as PopoverDescriptionPrimitive,
  PopoverTitle as PopoverTitlePrimitive,
  PopoverTrigger as PopoverTriggerPrimitive,
} from "@ui-sdk/react/popover"

import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Popover({
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof PopoverPrimitive>>) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <PopoverPrimitive
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      {...omitUndefined(props)}
    />
  )
}

function PopoverTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof PopoverTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <PopoverTriggerPrimitive {...omitUndefined(props)} />
}

function PopoverContent({
  align = "end",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  container,
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof PopoverContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <PopoverContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      className={cn(
        "isolate z-50 w-80 max-w-[calc(100vw-1rem)] origin-(--transform-origin) rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function PopoverTitle({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof PopoverTitlePrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <PopoverTitlePrimitive
      className={cn("text-sm font-semibold text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof PopoverDescriptionPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <PopoverDescriptionPrimitive
      className={cn("text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function PopoverClose({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof PopoverClosePrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <PopoverClosePrimitive {...omitUndefined(props)} />
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
}
