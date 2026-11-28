import * as React from "react"
import { Input as InputPrimitive } from "@ui-sdk/react/input"

import { omitUndefined, toTextValue, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type InputProps = RelaxOptional<
  Omit<
    React.ComponentProps<typeof InputPrimitive>,
    "className" | "value" | "defaultValue"
  >
> & {
  className?: string | undefined
  value?: string | number | readonly string[] | undefined
  defaultValue?: string | number | readonly string[] | undefined
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, value, defaultValue, render, ...props },
  ref
) {
  const textValue = toTextValue(value)
  const textDefaultValue = toTextValue(defaultValue)
  const hasExplicitAriaLabel =
    props["aria-label"] !== undefined && props["aria-labelledby"] === undefined
  return (
    <InputPrimitive
      ref={ref}
      {...(type !== undefined ? { type } : {})}
      {...(textValue !== undefined ? { value: textValue } : {})}
      {...(textDefaultValue !== undefined
        ? { defaultValue: textDefaultValue }
        : {})}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      render={
        render ??
        ((slotProps) => {
          const {
            "aria-labelledby": ariaLabelledBy,
            "data-invalid": _dataInvalid,
            ...restSlotProps
          } = slotProps as typeof slotProps & { "data-invalid"?: string }
          return (
            <input
              {...restSlotProps}
              {...(!hasExplicitAriaLabel && ariaLabelledBy !== undefined
                ? { "aria-labelledby": ariaLabelledBy }
                : {})}
            />
          )
        })
      }
      {...omitUndefined(props)}
    />
  )
})

export { Input }
