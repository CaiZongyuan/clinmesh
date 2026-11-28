"use client"

import * as React from "react"
import { contrastRatio, formatColor, parseColor } from "@ui-sdk/core/color"
import {
  ColorPicker as ColorPickerPrimitive,
  ColorPickerArea as ColorPickerAreaPrimitive,
  ColorPickerAreaThumb as ColorPickerAreaThumbPrimitive,
  ColorPickerInput as ColorPickerInputPrimitive,
  ColorPickerSlider as ColorPickerSliderPrimitive,
  ColorPickerSliderThumb as ColorPickerSliderThumbPrimitive,
  ColorPickerSwatch as ColorPickerSwatchPrimitive,
  ColorPickerSwatchItem as ColorPickerSwatchItemPrimitive,
  ColorPickerSwatches as ColorPickerSwatchesPrimitive,
} from "@ui-sdk/react/color-picker"

import { Badge } from "#components/badge"
import { cn } from "#lib/utils"

interface ClinicalColorPickerProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  swatches?: readonly string[]
  compareBackground?: string
  className?: string
}

const DEFAULT_SWATCHES = ["#1764c0", "#0e7490", "#166534", "#4338ca", "#b45309", "#1c1b18"] as const

function ClinicalColorPicker({
  value,
  defaultValue = "#1764c0",
  onValueChange,
  swatches = DEFAULT_SWATCHES,
  compareBackground = "#ffffff",
  className,
}: ClinicalColorPickerProps) {
  const [internal, setInternal] = React.useState(defaultValue)
  const currentHex = value ?? internal

  const ratio = React.useMemo(() => {
    const fg = parseColor(currentHex)
    const bg = parseColor(compareBackground)
    if (!fg || !bg) return null
    return Number(contrastRatio(fg, bg).toFixed(2))
  }, [compareBackground, currentHex])

  const oklchLabel = React.useMemo(() => {
    const parsed = parseColor(currentHex)
    return parsed ? formatColor(parsed, "oklch") : currentHex
  }, [currentHex])

  return (
    <ColorPickerPrimitive
      className={cn("flex w-full max-w-xs flex-col gap-3 rounded-lg border bg-card p-3", className)}
      {...(value !== undefined ? { value } : { defaultValue })}
      format="hex"
      onValueChange={next => {
        if (value === undefined) setInternal(next)
        onValueChange?.(next)
      }}
    >
      <ColorPickerAreaPrimitive
        className="relative h-28 w-full cursor-crosshair overflow-hidden rounded-md border"
        style={{ background: "var(--color-area-background)" }}
        x="saturation"
        y="lightness"
      >
        <ColorPickerAreaThumbPrimitive className="pointer-events-none absolute top-(--color-area-y) left-(--color-area-x) size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow-md ring-1 ring-foreground/40" />
      </ColorPickerAreaPrimitive>

      <ColorPickerSliderPrimitive
        channel="hue"
        className="relative h-3 w-full cursor-pointer rounded-full border"
        style={{ background: "var(--color-slider-background)" }}
      >
        <ColorPickerSliderThumbPrimitive className="pointer-events-none absolute top-1/2 left-(--color-slider-position) size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground shadow-sm" />
      </ColorPickerSliderPrimitive>

      <div className="flex items-center gap-2">
        <ColorPickerSwatchPrimitive
          className="size-7 shrink-0 rounded-md border shadow-2xs"
          style={{ backgroundColor: "var(--color-swatch)" }}
        />
        <ColorPickerInputPrimitive
          aria-label="十六进制色值"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:border-ring"
        />
        {ratio !== null ? (
          <Badge variant={ratio >= 4.5 ? "secondary" : "warning"}>
            {ratio >= 4.5 ? `AA ${ratio}:1` : `${ratio}:1`}
          </Badge>
        ) : null}
      </div>

      <div className="truncate font-mono text-[10px] text-muted-foreground">{oklchLabel}</div>

      <ColorPickerSwatchesPrimitive className="flex flex-wrap items-center gap-1.5">
        {swatches.map(hex => (
          <ColorPickerSwatchItemPrimitive
            aria-label={`选择色板 ${hex}`}
            className="size-5 cursor-pointer rounded-full border border-border transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
            key={hex}
            style={{ backgroundColor: hex }}
            value={hex}
          />
        ))}
      </ColorPickerSwatchesPrimitive>
    </ColorPickerPrimitive>
  )
}

export { ClinicalColorPicker, type ClinicalColorPickerProps }
