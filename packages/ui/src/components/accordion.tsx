"use client"

import * as React from "react"
import {
  Accordion as AccordionPrimitive,
  AccordionHeader as AccordionHeaderPrimitive,
  AccordionItem as AccordionItemPrimitive,
  AccordionPanel as AccordionPanelPrimitive,
  AccordionTrigger as AccordionTriggerPrimitive,
} from "@ui-sdk/react/accordion"
import { ChevronDownIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Accordion({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof AccordionPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <AccordionPrimitive
      className={cn("divide-y rounded-lg border bg-card", className)}
      {...omitUndefined(props)}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof AccordionItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <AccordionItemPrimitive
      className={cn("group/acc-item", className)}
      {...omitUndefined(props)}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof AccordionTriggerPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <AccordionHeaderPrimitive className="flex">
      <AccordionTriggerPrimitive
        className={cn(
          "flex flex-1 cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-medium text-foreground transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          className,
        )}
        {...omitUndefined(props)}
      >
        <span>{children}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[open]/acc-item:rotate-180"
        />
      </AccordionTriggerPrimitive>
    </AccordionHeaderPrimitive>
  )
}

function AccordionPanel({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof AccordionPanelPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <AccordionPanelPrimitive
      className={cn("px-4 pb-3 text-xs leading-relaxed text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export { Accordion, AccordionItem, AccordionPanel, AccordionTrigger }
