"use client"

import * as React from "react"
import {
  Slider as SliderPrimitive,
  SliderControl as SliderControlPrimitive,
  SliderIndicator as SliderIndicatorPrimitive,
  SliderThumb as SliderThumbPrimitive,
  SliderTrack as SliderTrackPrimitive,
} from "@ui-sdk/react/slider"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type SliderProps = RelaxOptional<
  Omit<React.ComponentProps<typeof SliderPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  thumbLabel?: string | undefined
}

function Slider({
  className,
  thumbLabel,
  ...props
}: SliderProps) {
  return (
    <SliderPrimitive
      className={cn("relative flex w-full touch-none items-center select-none", className)}
      {...omitUndefined(props)}
    >
      <SliderControlPrimitive className="flex w-full cursor-pointer items-center py-2">
        <SliderTrackPrimitive className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
          <SliderIndicatorPrimitive className="absolute inset-y-0 left-0 bg-info" />
        </SliderTrackPrimitive>
        <SliderThumbPrimitive
          {...(thumbLabel ? { "aria-label": thumbLabel } : {})}
          className="block size-3.5 rounded-full border-2 border-foreground bg-card shadow-xs transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-dragging:scale-110"
        />
      </SliderControlPrimitive>
    </SliderPrimitive>
  )
}

export { Slider, type SliderProps }
