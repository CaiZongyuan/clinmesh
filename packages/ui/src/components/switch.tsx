"use client"

import * as React from "react"
import {
  Switch as SwitchPrimitive,
  SwitchThumb as SwitchThumbPrimitive,
} from "@ui-sdk/react/switch"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type SwitchPrimitiveProps = React.ComponentProps<typeof SwitchPrimitive>
type SwitchChangeDetails = Parameters<
  NonNullable<SwitchPrimitiveProps["onCheckedChange"]>
>[1]

type SwitchProps = RelaxOptional<
  Omit<SwitchPrimitiveProps, "className" | "onCheckedChange" | "children">
> & {
  className?: string | undefined
  onCheckedChange?:
    | ((checked: boolean, details: SwitchChangeDetails) => void)
    | undefined
}

function Switch({
  className,
  onCheckedChange,
  ...props
}: SwitchProps) {
  return (
    <SwitchPrimitive
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className
      )}
      {...(onCheckedChange
        ? {
            onCheckedChange: (checked, details) =>
              onCheckedChange(checked === true, details),
          }
        : {})}
      {...omitUndefined(props)}
    >
      <SwitchThumbPrimitive
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-xs ring-0 transition-transform translate-x-0.5 data-checked:translate-x-[1.125rem] rtl:data-checked:-translate-x-[1.125rem]"
        )}
      />
    </SwitchPrimitive>
  )
}

export { Switch, type SwitchProps }
