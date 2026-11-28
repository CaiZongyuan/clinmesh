"use client"

import * as React from "react"
import {
  Menu as MenuPrimitive,
  MenuCheckboxItem as MenuCheckboxItemPrimitive,
  MenuContent as MenuContentPrimitive,
  MenuGroup as MenuGroupPrimitive,
  MenuGroupLabel as MenuGroupLabelPrimitive,
  MenuItem as MenuItemPrimitive,
  MenuItemIndicator as MenuItemIndicatorPrimitive,
  MenuRadioGroup as MenuRadioGroupPrimitive,
  MenuRadioItem as MenuRadioItemPrimitive,
  MenuSeparator as MenuSeparatorPrimitive,
  MenuSub as MenuSubPrimitive,
  MenuSubContent as MenuSubContentPrimitive,
  MenuSubTrigger as MenuSubTriggerPrimitive,
  MenuTrigger as MenuTriggerPrimitive,
} from "@ui-sdk/react/menu"
import { CheckIcon, ChevronRightIcon } from "lucide-react"

import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

const DropdownMenuGroupContext = React.createContext(false)

function DropdownMenu({
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof MenuPrimitive>>) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <MenuPrimitive
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function DropdownMenuTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof MenuTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <MenuTriggerPrimitive {...omitUndefined(props)} />
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  container,
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)
  return (
    <MenuContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      className={cn(
        "isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border-0 bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuGroup({
  children,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof MenuGroupPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return (
    <DropdownMenuGroupContext.Provider value={true}>
      <MenuGroupPrimitive {...omitUndefined(props)}>
        {children}
      </MenuGroupPrimitive>
    </DropdownMenuGroupContext.Provider>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuGroupLabelPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  inset?: boolean | undefined
}) {
  const inGroup = React.useContext(DropdownMenuGroupContext)
  const labelClassName = cn(
    "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
    className
  )
  if (!inGroup) {
    const { render: _render, style, ...divProps } = props
    const resolvedStyle = typeof style === "function" ? style({}) : style
    return (
      <div
        data-slot="dropdown-menu-label"
        data-inset={inset}
        className={labelClassName}
        {...(resolvedStyle !== undefined ? { style: resolvedStyle } : {})}
        {...omitUndefined(divProps)}
      />
    )
  }
  return (
    <MenuGroupLabelPrimitive
      data-inset={inset}
      className={labelClassName}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  closeOnClick,
  closeOnSelect,
  onClick,
  onSelect,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuItemPrimitive>,
    "className" | "children" | "onClick"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  inset?: boolean | undefined
  variant?: "default" | "destructive" | undefined
  closeOnClick?: boolean | undefined
  onClick?: ((event?: React.MouseEvent<HTMLDivElement>) => unknown) | undefined
}) {
  const resolvedCloseOnSelect = closeOnSelect ?? closeOnClick
  const resolvedOnSelect =
    onSelect ??
    (onClick
      ? () => {
          onClick()
        }
      : undefined)

  return (
    <MenuItemPrimitive
      data-inset={inset}
      data-variant={variant}
      destructive={variant === "destructive"}
      {...(resolvedCloseOnSelect !== undefined
        ? { closeOnSelect: resolvedCloseOnSelect }
        : {})}
      {...(resolvedOnSelect !== undefined
        ? { onSelect: resolvedOnSelect }
        : {})}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 dark:data-[variant=destructive]:data-highlighted:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuSub({
  ...props
}: RelaxOptional<React.ComponentProps<typeof MenuSubPrimitive>>) {
  return <MenuSubPrimitive {...omitUndefined(props)} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuSubTriggerPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  inset?: boolean | undefined
}) {
  return (
    <MenuSubTriggerPrimitive
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...omitUndefined(props)}
    >
      {children}
      <ChevronRightIcon aria-hidden="true" className="ml-auto" />
    </MenuSubTriggerPrimitive>
  )
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuSubContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <MenuSubContentPrimitive
      className={cn(
        "isolate z-50 max-h-(--available-height) w-auto min-w-[96px] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border-0 bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-closed:pointer-events-none",
        className
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  value,
  inset,
  closeOnClick,
  closeOnSelect,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuCheckboxItemPrimitive>,
    "className" | "children" | "value"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  value?: string | undefined
  inset?: boolean | undefined
  closeOnClick?: boolean | undefined
}) {
  const generatedValue = React.useId()
  const resolvedCloseOnSelect = closeOnSelect ?? closeOnClick
  return (
    <MenuCheckboxItemPrimitive
      value={value ?? generatedValue}
      data-inset={inset}
      {...(checked !== undefined ? { checked } : {})}
      {...(resolvedCloseOnSelect !== undefined
        ? { closeOnSelect: resolvedCloseOnSelect }
        : {})}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground focus:**:text-accent-foreground data-highlighted:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...omitUndefined(props)}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuItemIndicatorPrimitive>
          <CheckIcon aria-hidden="true" />
        </MenuItemIndicatorPrimitive>
      </span>
      {children}
    </MenuCheckboxItemPrimitive>
  )
}

function DropdownMenuRadioGroup<T extends string = string>({
  children,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof MenuRadioGroupPrimitive<T>>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return (
    <DropdownMenuGroupContext.Provider value={true}>
      <MenuRadioGroupPrimitive {...omitUndefined(props as Record<string, unknown>)}>
        {children}
      </MenuRadioGroupPrimitive>
    </DropdownMenuGroupContext.Provider>
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  closeOnClick,
  closeOnSelect,
  value,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof MenuRadioItemPrimitive>,
    "className" | "children" | "value"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  value: string
  inset?: boolean | undefined
  closeOnClick?: boolean | undefined
}) {
  const resolvedCloseOnSelect = closeOnSelect ?? closeOnClick
  return (
    <MenuRadioItemPrimitive
      value={value}
      data-inset={inset}
      {...(resolvedCloseOnSelect !== undefined
        ? { closeOnSelect: resolvedCloseOnSelect }
        : {})}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground focus:**:text-accent-foreground data-highlighted:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...omitUndefined(props)}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuItemIndicatorPrimitive>
          <CheckIcon aria-hidden="true" />
        </MenuItemIndicatorPrimitive>
      </span>
      {children}
    </MenuRadioItemPrimitive>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof MenuSeparatorPrimitive>, "className">
> & {
  className?: string | undefined
}) {
  return (
    <MenuSeparatorPrimitive
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...omitUndefined(props)}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
