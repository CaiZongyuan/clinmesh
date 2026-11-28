"use client"

import * as React from "react"
import { Button } from "#components/button"
import { cn } from "#lib/utils"

interface HoldButtonProps {
  label: string
  holdingLabel?: string
  durationMs?: number
  disabled?: boolean
  icon?: React.ReactNode
  variant?: "outline" | "ghost" | "destructive" | "default"
  size?: "xs" | "sm" | "default"
  className?: string
  title?: string
  onConfirmed: () => void
}

function HoldButton({
  label,
  holdingLabel,
  durationMs = 650,
  disabled = false,
  icon,
  variant = "outline",
  size = "sm",
  className,
  title,
  onConfirmed,
}: HoldButtonProps) {
  const [holding, setHolding] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)
  const confirmedRef = React.useRef(onConfirmed)
  confirmedRef.current = onConfirmed

  const cancel = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setHolding(false)
  }, [])

  React.useEffect(() => cancel, [cancel])

  const start = React.useCallback(() => {
    if (disabled) return
    cancel()
    setHolding(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setHolding(false)
      confirmedRef.current()
    }, durationMs)
  }, [cancel, disabled, durationMs])

  return (
    <Button
      className={cn("relative overflow-hidden select-none", className)}
      disabled={disabled}
      onBlur={cancel}
      onKeyDown={event => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault()
          start()
        }
      }}
      onKeyUp={cancel}
      onPointerCancel={cancel}
      onPointerDown={start}
      onPointerLeave={cancel}
      onPointerUp={cancel}
      size={size}
      title={title}
      type="button"
      variant={variant}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 bg-destructive/15"
        style={{
          width: holding ? "100%" : "0%",
          transition: holding ? `width ${durationMs}ms linear` : "none",
        }}
      />
      <span className="relative z-1 inline-flex items-center gap-1.5">
        {icon}
        <span>{holding && holdingLabel ? holdingLabel : label}</span>
      </span>
    </Button>
  )
}

export { HoldButton, type HoldButtonProps }
