"use client"

import * as React from "react"
import {
  Toggle as TogglePrimitive,
  ToggleGroup as ToggleGroupPrimitive,
} from "@ui-sdk/react/toggle"
import { type VariantProps } from "class-variance-authority"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"
import { toggleVariants } from "#components/toggle"

const ToggleGroupContext = React.createContext<
  RelaxOptional<VariantProps<typeof toggleVariants>> & {
    spacing?: number | undefined
    orientation?: "horizontal" | "vertical" | undefined
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
})

function ToggleGroup<T extends string = string>({
  className,
  variant,
  size,
  spacing = 2,
  orientation = "horizontal",
  style,
  children,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ToggleGroupPrimitive<T>>,
    "className" | "children" | "style"
  >
> &
  RelaxOptional<VariantProps<typeof toggleVariants>> & {
    className?: string | undefined
    style?: React.CSSProperties | undefined
    spacing?: number | undefined
    orientation?: "horizontal" | "vertical" | undefined
    children?: React.ReactNode | undefined
  }) {
  const contextValue = React.useMemo(
    () => ({ variant, size, spacing, orientation }),
    [variant, size, spacing, orientation]
  )
  return (
    <ToggleGroupPrimitive
      orientation={orientation}
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      style={{ "--gap": spacing, ...style } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...omitUndefined(props as Record<string, unknown>)}
    >
      <ToggleGroupContext.Provider value={contextValue}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof TogglePrimitive>, "className" | "children">
> &
  RelaxOptional<VariantProps<typeof toggleVariants>> & {
    className?: string | undefined
    children?: React.ReactNode | undefined
  }) {
  const context = React.useContext(ToggleGroupContext)
  const resolvedVariant = context.variant || variant
  const resolvedSize = context.size || size

  return (
    <TogglePrimitive
      data-toggle-group-item=""
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: resolvedVariant,
          size: resolvedSize,
        }),
        className
      )}
      {...omitUndefined(props)}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
