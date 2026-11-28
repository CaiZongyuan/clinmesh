import * as React from "react"
import {
  Progress as ProgressPrimitive,
  ProgressIndicator as ProgressIndicatorPrimitive,
  ProgressLabel as ProgressLabelPrimitive,
  ProgressTrack as ProgressTrackPrimitive,
  ProgressValue as ProgressValuePrimitive,
} from "@ui-sdk/react/progress"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Progress({
  className,
  children,
  value,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof ProgressPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ProgressPrimitive
      {...(value !== undefined ? { value } : {})}
      className={cn("flex flex-wrap gap-3", className)}
      {...omitUndefined(props)}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive>
  )
}

function ProgressTrack({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ProgressTrackPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ProgressTrackPrimitive
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function ProgressIndicator({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ProgressIndicatorPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
}) {
  return (
    <ProgressIndicatorPrimitive
      className={cn("h-full bg-primary transition-all", className)}
      {...omitUndefined(props)}
    />
  )
}

function ProgressLabel({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ProgressLabelPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ProgressLabelPrimitive
      className={cn("text-sm font-medium", className)}
      {...omitUndefined(props)}
    />
  )
}

function ProgressValue({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof ProgressValuePrimitive>, "className">
> & {
  className?: string | undefined
}) {
  return (
    <ProgressValuePrimitive
      className={cn(
        "ml-auto text-sm text-muted-foreground tabular-nums",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
