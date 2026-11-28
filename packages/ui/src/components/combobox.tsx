"use client"

import * as React from "react"
import {
  Combobox as ComboboxPrimitive,
  ComboboxChip as ComboboxChipPrimitive,
  ComboboxChipRemove as ComboboxChipRemovePrimitive,
  ComboboxChips as ComboboxChipsPrimitive,
  ComboboxContent as ComboboxContentPrimitive,
  ComboboxEmpty as ComboboxEmptyPrimitive,
  ComboboxInput as ComboboxInputPrimitive,
  ComboboxItem as ComboboxItemPrimitive,
  ComboboxItemIndicator as ComboboxItemIndicatorPrimitive,
  ComboboxLabel as ComboboxLabelPrimitive,
  ComboboxList as ComboboxListPrimitive,
  ComboboxValue as ComboboxValuePrimitive,
} from "@ui-sdk/react/combobox"
import { CheckIcon, XIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

const Combobox = ComboboxPrimitive
const ComboboxValue = ComboboxValuePrimitive

function ComboboxLabel({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxLabelPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxLabelPrimitive
      className={cn("text-xs font-medium text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxChips({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxChipsPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxChipsPrimitive
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-2 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxChip({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxChipPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxChipPrimitive
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxChipRemove({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxChipRemovePrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ComboboxChipRemovePrimitive
      className={cn(
        "inline-flex size-3.5 cursor-pointer items-center justify-center rounded-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...omitUndefined(props)}
    >
      {children ?? <XIcon aria-hidden="true" className="size-3" />}
    </ComboboxChipRemovePrimitive>
  )
}

function ComboboxInput({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxInputPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxInputPrimitive
      className={cn(
        "h-7 min-w-24 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxContent({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxContentPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxContentPrimitive
      className={cn(
        "z-50 min-w-52 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-border/60",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxList({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxListPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxListPrimitive
      className={cn("max-h-56 overflow-y-auto", className)}
      {...omitUndefined(props)}
    />
  )
}

function ComboboxItem({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxItemPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ComboboxItemPrimitive
      className={cn(
        "relative flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...omitUndefined(props)}
    >
      <span>{children}</span>
      <ComboboxItemIndicatorPrimitive className="inline-flex size-4 shrink-0 items-center justify-center text-info">
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </ComboboxItemIndicatorPrimitive>
    </ComboboxItemPrimitive>
  )
}

function ComboboxEmpty({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ComboboxEmptyPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ComboboxEmptyPrimitive
      className={cn("py-4 text-center text-xs text-muted-foreground empty:hidden", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
}
