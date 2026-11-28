import * as React from "react"
import {
  Select as SelectPrimitive,
  SelectContent as SelectContentPrimitive,
  SelectGroup as SelectGroupPrimitive,
  SelectGroupLabel as SelectGroupLabelPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemIndicator as SelectItemIndicatorPrimitive,
  SelectItemText as SelectItemTextPrimitive,
  SelectSeparator as SelectSeparatorPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
  type ListData,
} from "@ui-sdk/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"
import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"

type SelectOptionItem<T = string> = {
  value: T
  label?: React.ReactNode | undefined
  disabled?: boolean | undefined
}

function extractNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractNodeText).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractNodeText(node.props.children)
  }
  return ""
}

type SelectChangeDetails = Parameters<
  NonNullable<
    React.ComponentProps<typeof SelectPrimitive<string, false>>["onValueChange"]
  >
>[1]

type SelectWrapperProps<
  T = string,
  Multiple extends boolean | undefined = false,
> = RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectPrimitive<T, Multiple>>,
    | "items"
    | "children"
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "multiple"
  >
> &
  (Multiple extends true
    ? {
        multiple: true
        value?: T[] | undefined
        defaultValue?: T[] | undefined
        onValueChange?:
          | ((value: T[], details: SelectChangeDetails) => void)
          | undefined
      }
    : {
        multiple?: false | undefined
        value?: T | null | undefined
        defaultValue?: T | null | undefined
        onValueChange?:
          | ((value: T | null, details: SelectChangeDetails) => void)
          | undefined
      }) & {
    items?: readonly SelectOptionItem<T>[] | ListData<T> | undefined
    children?: React.ReactNode | undefined
  }

function Select<T = string, Multiple extends boolean | undefined = false>({
  items,
  itemToLabel,
  children,
  ...props
}: SelectWrapperProps<T, Multiple>) {
  const labelMap = React.useMemo(() => {
    if (!items) return undefined
    const map = new Map<unknown, string>()
    for (const entry of items) {
      if (entry && typeof entry === "object" && "value" in entry) {
        const text =
          entry.label !== undefined
            ? extractNodeText(entry.label).replace(/\s+/g, " ").trim()
            : String(entry.value)
        map.set(entry.value, text)
      }
    }
    return map
  }, [items])

  const resolvedItemToLabel = React.useMemo(() => {
    if (itemToLabel) return itemToLabel
    if (!labelMap || labelMap.size === 0) return undefined
    return (value: T) => labelMap.get(value) ?? String(value)
  }, [itemToLabel, labelMap])

  const dataItems = React.useMemo(() => {
    if (!items) return undefined
    return items.map((entry) => {
      if (entry && typeof entry === "object" && "value" in entry) {
        return {
          value: entry.value,
          label:
            entry.label !== undefined
              ? extractNodeText(entry.label).replace(/\s+/g, " ").trim()
              : String(entry.value),
          ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
        }
      }
      return entry
    }) as ListData<T>
  }, [children, items])

  return (
    <SelectPrimitive
      {...(dataItems !== undefined ? { items: dataItems } : {})}
      {...(resolvedItemToLabel !== undefined
        ? { itemToLabel: resolvedItemToLabel }
        : {})}
      {...omitUndefined(props as Record<string, unknown>)}
    >
      {children}
    </SelectPrimitive>
  )
}

function SelectGroup({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectGroupPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <SelectGroupPrimitive
      className={cn("scroll-my-1 p-1", className)}
      {...omitUndefined(props)}
    />
  )
}

function SelectValue({
  className,
  placeholder,
  children,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectValuePrimitive>,
    "className" | "placeholder" | "children"
  >
> & {
  className?: string | undefined
  placeholder?: React.ReactNode | undefined
  children?: React.ReactNode | undefined
}) {
  const stringPlaceholder =
    typeof placeholder === "string" ? placeholder : undefined
  const nodePlaceholder =
    placeholder !== undefined && typeof placeholder !== "string"
      ? placeholder
      : undefined
  return (
    <SelectValuePrimitive
      {...(stringPlaceholder !== undefined
        ? { placeholder: stringPlaceholder }
        : {})}
      className={cn("flex flex-1 text-left", className)}
      {...omitUndefined(props)}
    >
      {children !== undefined
        ? children
        : nodePlaceholder !== undefined
          ? (state) => (state.placeholder ? nodePlaceholder : state.label)
          : undefined}
    </SelectValuePrimitive>
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  render,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectTriggerPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  size?: "sm" | "default" | undefined
}) {
  const hasExplicitAriaLabel =
    props["aria-label"] !== undefined && props["aria-labelledby"] === undefined
  return (
    <SelectTriggerPrimitive
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...(render !== undefined
        ? { render }
        : hasExplicitAriaLabel
          ? {
              render: (slotProps) => {
                const { "aria-labelledby": _ignored, ...restSlotProps } =
                  slotProps
                return <button {...restSlotProps} />
              },
            }
          : {})}
      {...omitUndefined(props)}
    >
      {children}
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none size-4 text-muted-foreground"
      />
    </SelectTriggerPrimitive>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  container,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <SelectContentPrimitive
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      alignItemWithTrigger={alignItemWithTrigger}
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      data-align-trigger={alignItemWithTrigger}
      className={cn(
        "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border-0 bg-popover p-0 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    >
      {children}
    </SelectContentPrimitive>
  )
}

function SelectLabel({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectGroupLabelPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <SelectGroupLabelPrimitive
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function SelectItem<T = string>({
  className,
  children,
  label,
  value,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectItemPrimitive<T>>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  const resolvedLabel =
    label ??
    (typeof children === "string"
      ? undefined
      : extractNodeText(children).replace(/\s+/g, " ").trim() || undefined)
  return (
    <SelectItemPrimitive
      value={value}
      {...(resolvedLabel !== undefined ? { label: resolvedLabel } : {})}
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...omitUndefined(props as Record<string, unknown>)}
    >
      {typeof children === "string" ? (
        <SelectItemTextPrimitive className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
          {children}
        </SelectItemTextPrimitive>
      ) : (
        <span className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
          {children}
        </span>
      )}
      <SelectItemIndicatorPrimitive className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <CheckIcon aria-hidden="true" className="pointer-events-none" />
      </SelectItemIndicatorPrimitive>
    </SelectItemPrimitive>
  )
}

function SelectSeparator({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SelectSeparatorPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
}) {
  return (
    <SelectSeparatorPrimitive
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...omitUndefined(props)}
    />
  )
}

function SelectScrollUpButton() {
  return null
}

function SelectScrollDownButton() {
  return null
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
