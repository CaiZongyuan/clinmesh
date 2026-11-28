"use client"

import * as React from "react"
import {
  NumberInput as NumberInputPrimitive,
  NumberInputControl as NumberInputControlPrimitive,
  NumberInputDecrement as NumberInputDecrementPrimitive,
  NumberInputGroup as NumberInputGroupPrimitive,
  NumberInputIncrement as NumberInputIncrementPrimitive,
} from "@ui-sdk/react/number-input"
import { MinusIcon, PlusIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

interface NumberInputProps
  extends RelaxOptional<
    Omit<React.ComponentProps<typeof NumberInputPrimitive>, "className" | "children">
  > {
  className?: string | undefined
  inputAriaLabel?: string | undefined
  decrementLabel?: string | undefined
  incrementLabel?: string | undefined
  unit?: string | undefined
}

function NumberInput({
  className,
  inputAriaLabel,
  decrementLabel = "减少",
  incrementLabel = "增加",
  unit,
  ...props
}: NumberInputProps) {
  return (
    <NumberInputPrimitive
      className={cn("inline-flex items-center", className)}
      {...omitUndefined(props)}
    >
      <NumberInputGroupPrimitive className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <NumberInputDecrementPrimitive
          aria-label={decrementLabel}
          className="inline-flex h-full w-7 cursor-pointer items-center justify-center border-r text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <MinusIcon aria-hidden="true" className="size-3.5" />
        </NumberInputDecrementPrimitive>
        <NumberInputControlPrimitive
          aria-label={inputAriaLabel}
          className="h-full w-16 bg-transparent px-2 text-center font-mono text-xs text-foreground outline-none tabular-nums"
        />
        {unit ? (
          <span className="pr-2 text-[11px] text-muted-foreground select-none">{unit}</span>
        ) : null}
        <NumberInputIncrementPrimitive
          aria-label={incrementLabel}
          className="inline-flex h-full w-7 cursor-pointer items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
        </NumberInputIncrementPrimitive>
      </NumberInputGroupPrimitive>
    </NumberInputPrimitive>
  )
}

export { NumberInput, type NumberInputProps }
