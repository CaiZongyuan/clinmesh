import * as React from "react"
import { cn } from "#lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-card px-1.5 font-mono text-[11px] font-medium text-muted-foreground shadow-2xs",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
