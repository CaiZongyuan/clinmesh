"use client"

import * as React from "react"
import {
  SegmentedControl as SegmentedControlPrimitive,
  SegmentedControlIndicator as SegmentedControlIndicatorPrimitive,
  SegmentedControlItem as SegmentedControlItemPrimitive,
} from "@ui-sdk/react/segmented-control"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function SegmentedControl<T extends string = string>({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof SegmentedControlPrimitive<T>>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <SegmentedControlPrimitive
      className={cn(
        "relative inline-flex items-center rounded-lg border bg-muted p-0.5 text-xs select-none",
        className,
      )}
      {...omitUndefined(props as Record<string, unknown>)}
    >
      <SegmentedControlIndicatorPrimitive
        aria-hidden="true"
        className="pointer-events-none absolute top-(--segmented-control-indicator-top) left-(--segmented-control-indicator-left) h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) rounded-md bg-card shadow-2xs ring-1 ring-border/70 transition-[left,top,width,height] duration-150 ease-out"
      />
      {children}
    </SegmentedControlPrimitive>
  )
}

function SegmentedControlItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof SegmentedControlItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <SegmentedControlItemPrimitive
      className={cn(
        "relative z-1 inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[checked]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

export { SegmentedControl, SegmentedControlItem }
