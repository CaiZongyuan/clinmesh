import * as React from "react"
import { Separator as SeparatorPrimitive } from "@ui-sdk/react/separator"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SeparatorPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
}) {
  return (
    <SeparatorPrimitive
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

export { Separator }
