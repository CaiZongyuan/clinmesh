"use client"

import * as React from "react"
import {
  visibleWaterfallRows,
  Waterfall as WaterfallPrimitive,
  WaterfallAxis as WaterfallAxisPrimitive,
  WaterfallBar as WaterfallBarPrimitive,
  WaterfallCell as WaterfallCellPrimitive,
  WaterfallColumnHeader as WaterfallColumnHeaderPrimitive,
  WaterfallHeaderRow as WaterfallHeaderRowPrimitive,
  WaterfallIndicator as WaterfallIndicatorPrimitive,
  WaterfallMark as WaterfallMarkPrimitive,
  WaterfallRow as WaterfallRowPrimitive,
  WaterfallRowHeader as WaterfallRowHeaderPrimitive,
  type WaterfallData,
} from "@ui-sdk/react/waterfall"
import { ChevronRightIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Waterfall({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallPrimitive
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-lg border bg-card text-xs select-none",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallHeaderRow({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallHeaderRowPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallHeaderRowPrimitive
      className={cn(
        "grid grid-cols-[minmax(10rem,14rem)_4.5rem_1fr] items-center border-b bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallColumnHeader({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallColumnHeaderPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallColumnHeaderPrimitive
      className={cn("truncate", className)}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallAxis({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallAxisPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallAxisPrimitive
      className={cn("relative h-4 w-full font-mono text-[10px] text-muted-foreground tabular-nums", className)}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallRow({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallRowPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallRowPrimitive
      className={cn(
        "group/wf-row grid cursor-pointer grid-cols-[minmax(10rem,14rem)_4.5rem_1fr] items-center border-b px-3 py-1.5 outline-none last:border-b-0 hover:bg-muted/40 focus-visible:bg-accent/60 data-[selected]:bg-accent/70",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallRowHeader({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallRowHeaderPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallRowHeaderPrimitive
      className={cn("flex min-w-0 items-center gap-1.5 pr-2 font-medium text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallIndicator({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallIndicatorPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <WaterfallIndicatorPrimitive
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-transform group-data-[expanded]/wf-row:rotate-90",
        className,
      )}
      {...omitUndefined(props)}
    >
      {children ?? <ChevronRightIcon aria-hidden="true" className="size-3" />}
    </WaterfallIndicatorPrimitive>
  )
}

function WaterfallCell({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallCellPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallCellPrimitive
      className={cn("font-mono text-[11px] text-muted-foreground tabular-nums", className)}
      {...omitUndefined(props)}
    />
  )
}

function WaterfallBar({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof WaterfallBarPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <WaterfallBarPrimitive
      className={cn("relative h-4 w-full rounded-sm bg-muted/40", className)}
      {...omitUndefined(props)}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 min-w-1 rounded-xs bg-info/85 transition-opacity group-data-[selected]/wf-row:bg-info"
        style={{
          left: "calc(var(--waterfall-start, 0) * 100%)",
          width: "calc(var(--waterfall-width, 0.05) * 100%)",
        }}
      />
    </WaterfallBarPrimitive>
  )
}

const WaterfallMark = WaterfallMarkPrimitive

export {
  visibleWaterfallRows,
  Waterfall,
  WaterfallAxis,
  WaterfallBar,
  WaterfallCell,
  WaterfallColumnHeader,
  WaterfallHeaderRow,
  WaterfallIndicator,
  WaterfallMark,
  WaterfallRow,
  WaterfallRowHeader,
  type WaterfallData,
}
