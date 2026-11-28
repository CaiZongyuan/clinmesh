"use client"

import * as React from "react"
import {
  createResizableController,
  Resizable as ResizablePrimitive,
  ResizableHandle as ResizableHandlePrimitive,
  ResizablePanel as ResizablePanelPrimitive,
  resizableStorageKey,
} from "@ui-sdk/react/resizable"
import { GripVerticalIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Resizable({
  className,
  orientation = "horizontal",
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ResizablePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <ResizablePrimitive
      className={cn(
        orientation === "horizontal" ? "flex w-full flex-row overflow-hidden" : "flex h-full flex-col overflow-hidden",
        className,
      )}
      orientation={orientation}
      {...omitUndefined(props)}
    />
  )
}

function ResizablePanel({
  className,
  style,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ResizablePanelPrimitive>, "className" | "style">> & {
  className?: string | undefined
  style?: React.CSSProperties | undefined
}) {
  return (
    <ResizablePanelPrimitive
      className={cn("min-h-0 min-w-0 overflow-hidden", className)}
      style={{ flexBasis: "var(--resizable-panel-size)", flexGrow: 0, flexShrink: 0, ...style }}
      {...omitUndefined(props)}
    />
  )
}

function ResizableHandle({
  className,
  withGrip = true,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof ResizableHandlePrimitive>, "className">> & {
  className?: string | undefined
  withGrip?: boolean | undefined
}) {
  return (
    <ResizableHandlePrimitive
      className={cn(
        "group/resize-handle relative flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-transparent transition-colors outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border hover:before:w-0.5 hover:before:bg-info focus-visible:before:w-0.5 focus-visible:before:bg-info data-[dragging]:before:w-0.5 data-[dragging]:before:bg-info",
        className,
      )}
      {...omitUndefined(props)}
    >
      {withGrip ? (
        <span
          aria-hidden="true"
          className="relative z-1 flex h-6 w-3 items-center justify-center rounded-sm border bg-card text-muted-foreground shadow-2xs group-hover/resize-handle:text-foreground"
        >
          <GripVerticalIcon className="size-3" />
        </span>
      ) : null}
    </ResizableHandlePrimitive>
  )
}

export {
  createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  resizableStorageKey,
}
