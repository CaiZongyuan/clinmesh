"use client"

import * as React from "react"
import { Label as LabelPrimitive } from "@ui-sdk/react/label"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Label({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof LabelPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <LabelPrimitive
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-disabled:pointer-events-none group-data-disabled:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

export { Label }
