"use client"

import * as React from "react"
import {
  Tooltip as TooltipPrimitive,
  TooltipArrow as TooltipArrowPrimitive,
  TooltipContent as TooltipContentPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/react/tooltip"

import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

const TooltipDelayContext = React.createContext<number | undefined>(undefined)

function TooltipProvider({
  delay = 0,
  children,
}: {
  delay?: number | undefined
  closeDelay?: number | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <TooltipDelayContext.Provider value={delay}>
      {children}
    </TooltipDelayContext.Provider>
  )
}

function Tooltip({
  delay,
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof TooltipPrimitive>>) {
  const providerDelay = React.useContext(TooltipDelayContext)
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  const resolvedDelay = delay ?? providerDelay
  return (
    <TooltipPrimitive
      {...(resolvedDelay !== undefined ? { delay: resolvedDelay } : {})}
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      {...omitUndefined(props)}
    />
  )
}

function TooltipTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof TooltipTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <TooltipTriggerPrimitive {...omitUndefined(props)} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  container,
  children,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof TooltipContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <TooltipContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      className={cn(
        "isolate z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md border-0 bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    >
      {children}
      <TooltipArrowPrimitive className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
    </TooltipContentPrimitive>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
