import * as React from "react"
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea"

import { omitUndefined, toTextValue, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type TextareaProps = RelaxOptional<
  Omit<
    React.ComponentProps<typeof TextareaPrimitive>,
    "className" | "value" | "defaultValue"
  >
> & {
  className?: string | undefined
  value?: string | number | readonly string[] | undefined
  defaultValue?: string | number | readonly string[] | undefined
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, value, defaultValue, render, ...props }, ref) {
    const textValue = toTextValue(value)
    const textDefaultValue = toTextValue(defaultValue)
    const hasExplicitAriaLabel =
      props["aria-label"] !== undefined &&
      props["aria-labelledby"] === undefined
    return (
      <TextareaPrimitive
        ref={ref}
        {...(textValue !== undefined ? { value: textValue } : {})}
        {...(textDefaultValue !== undefined
          ? { defaultValue: textDefaultValue }
          : {})}
        className={cn(
          "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
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
              <textarea
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
  }
)

export { Textarea }
