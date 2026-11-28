"use client"

import * as React from "react"
import {
  createTimelineController,
  Timeline as TimelinePrimitive,
  TimelineConnector as TimelineConnectorPrimitive,
  TimelineDescription as TimelineDescriptionPrimitive,
  TimelineItem as TimelineItemPrimitive,
  TimelineMarker as TimelineMarkerPrimitive,
  TimelineTime as TimelineTimePrimitive,
  TimelineTitle as TimelineTitlePrimitive,
  type TimelineStatus,
} from "@ui-sdk/react/timeline"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Timeline({
  className,
  orientation = "horizontal",
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelinePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelinePrimitive
      className={cn(
        orientation === "horizontal"
          ? "group/timeline flex w-full items-start overflow-x-auto pb-1 select-none"
          : "group/timeline flex w-full flex-col gap-0",
        className,
      )}
      orientation={orientation}
      {...omitUndefined(props)}
    />
  )
}

function TimelineItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineItemPrimitive
      className={cn(
        "group/tl-item relative flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-md px-2 py-2 text-center outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-accent/70",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function TimelineMarker({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineMarkerPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineMarkerPrimitive
      className={cn(
        "relative z-1 size-3 rounded-full border-2 border-muted-foreground/50 bg-card transition-transform group-data-[status=complete]/tl-item:border-success group-data-[status=complete]/tl-item:bg-success group-data-[status=current]/tl-item:scale-115 group-data-[status=current]/tl-item:border-info group-data-[status=current]/tl-item:bg-info group-data-[selected]/tl-item:ring-4 group-data-[selected]/tl-item:ring-info/25",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function TimelineConnector({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineConnectorPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineConnectorPrimitive
      className={cn(
        "pointer-events-none absolute top-[13px] left-[calc(50%+6px)] h-0.5 w-[calc(100%-12px)] bg-border group-last/tl-item:hidden group-data-[status=complete]/tl-item:bg-success/55",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function TimelineTitle({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineTitlePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineTitlePrimitive
      className={cn("text-xs font-medium text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function TimelineTime({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineTimePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineTimePrimitive
      className={cn("font-mono text-[11px] text-muted-foreground tabular-nums", className)}
      {...omitUndefined(props)}
    />
  )
}

function TimelineDescription({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TimelineDescriptionPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TimelineDescriptionPrimitive
      className={cn("text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  createTimelineController,
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
  type TimelineStatus,
}
