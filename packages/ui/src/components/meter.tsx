"use client"

import * as React from "react"
import {
  Meter as MeterPrimitive,
  MeterIndicator as MeterIndicatorPrimitive,
  MeterLabel as MeterLabelPrimitive,
  MeterTrack as MeterTrackPrimitive,
  MeterValue as MeterValuePrimitive,
} from "@ui-sdk/react/meter"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

interface ClinicalMeterProps
  extends RelaxOptional<Omit<React.ComponentProps<typeof MeterPrimitive>, "className" | "children">> {
  className?: string | undefined
  label?: string | undefined
  unitText?: string | undefined
  tone?: "info" | "success" | "warning" | "destructive" | undefined
}

const METER_TONE_CLASS: Record<NonNullable<ClinicalMeterProps["tone"]>, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
}

function ClinicalMeter({
  className,
  label,
  unitText,
  tone = "info",
  ...props
}: ClinicalMeterProps) {
  return (
    <MeterPrimitive
      className={cn("flex w-full flex-col gap-1.5 text-xs", className)}
      {...omitUndefined(props)}
    >
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <MeterLabelPrimitive className="font-medium text-foreground">{label}</MeterLabelPrimitive>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            <MeterValuePrimitive />
            {unitText ? ` ${unitText}` : ""}
          </span>
        </div>
      ) : null}
      <MeterTrackPrimitive className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <MeterIndicatorPrimitive
          className={cn("h-full rounded-full transition-[width] duration-200", METER_TONE_CLASS[tone])}
        />
      </MeterTrackPrimitive>
    </MeterPrimitive>
  )
}

export { ClinicalMeter as Meter, type ClinicalMeterProps as MeterProps }
