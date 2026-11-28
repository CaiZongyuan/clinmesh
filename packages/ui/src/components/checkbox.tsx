"use client"

import * as React from "react"
import {
  Checkbox as CheckboxPrimitive,
  CheckboxIndicator as CheckboxIndicatorPrimitive,
} from "@ui-sdk/react/checkbox"
import { CheckIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type CheckboxPrimitiveProps = React.ComponentProps<typeof CheckboxPrimitive>
type CheckboxChangeDetails = Parameters<
  NonNullable<CheckboxPrimitiveProps["onCheckedChange"]>
>[1]

type CheckboxProps = RelaxOptional<
  Omit<CheckboxPrimitiveProps, "className" | "onCheckedChange" | "children">
> & {
  className?: string | undefined
  onCheckedChange?:
    | ((checked: boolean, details: CheckboxChangeDetails) => void)
    | undefined
}

function Checkbox({
  className,
  onCheckedChange,
  render,
  ...props
}: CheckboxProps) {
  const hasExplicitAriaLabel =
    props["aria-label"] !== undefined && props["aria-labelledby"] === undefined

  return (
    <CheckboxPrimitive
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        className
      )}
      {...(onCheckedChange
        ? {
            onCheckedChange: (checked, details) =>
              onCheckedChange(checked === true, details),
          }
        : {})}
      render={
        render ??
        ((slotProps) => {
          const {
            "aria-labelledby": ariaLabelledBy,
            "aria-disabled": ariaDisabled,
            ...restSlotProps
          } = slotProps
          const resolvedAriaDisabled =
            ariaDisabled ?? (slotProps.disabled ? "true" : undefined)
          return (
            <button
              {...restSlotProps}
              {...(!hasExplicitAriaLabel && ariaLabelledBy !== undefined
                ? { "aria-labelledby": ariaLabelledBy }
                : {})}
              {...(resolvedAriaDisabled !== undefined
                ? { "aria-disabled": resolvedAriaDisabled }
                : {})}
            />
          )
        })
      }
      {...omitUndefined(props)}
    >
      <CheckboxIndicatorPrimitive className="grid place-content-center text-current transition-none [&>svg]:size-3.5">
        <CheckIcon aria-hidden="true" />
      </CheckboxIndicatorPrimitive>
    </CheckboxPrimitive>
  )
}

export { Checkbox }
