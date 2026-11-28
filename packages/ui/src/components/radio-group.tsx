"use client"

import * as React from "react"
import {
  Radio as RadioPrimitive,
  RadioGroup as RadioGroupPrimitive,
  RadioIndicator as RadioIndicatorPrimitive,
} from "@ui-sdk/react/radio"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function RadioGroup<T extends string = string>({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof RadioGroupPrimitive<T>>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <RadioGroupPrimitive
      className={cn("grid gap-2", className)}
      {...omitUndefined(props)}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof RadioPrimitive>, "className" | "children">
> & {
  className?: string | undefined
}) {
  return (
    <RadioPrimitive
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-transparent transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary dark:bg-input/30 dark:data-checked:border-primary",
        className
      )}
      {...omitUndefined(props)}
    >
      <RadioIndicatorPrimitive className="flex items-center justify-center">
        <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
      </RadioIndicatorPrimitive>
    </RadioPrimitive>
  )
}

export { RadioGroup, RadioGroupItem }
