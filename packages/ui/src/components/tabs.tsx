import * as React from "react"
import {
  Tabs as TabsPrimitive,
  TabsIndicator as TabsIndicatorPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel as TabsPanelPrimitive,
  TabsTab as TabsTabPrimitive,
} from "@ui-sdk/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Tabs<T extends string = string>({
  className,
  orientation = "horizontal",
  activation = "manual",
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof TabsPrimitive<T>>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <TabsPrimitive
      orientation={orientation}
      activation={activation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...omitUndefined(props as Record<string, unknown>)}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof TabsListPrimitive>, "className" | "children">
> &
  RelaxOptional<VariantProps<typeof tabsListVariants>> & {
    className?: string | undefined
    children?: React.ReactNode | undefined
  }) {
  return (
    <TabsListPrimitive
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...omitUndefined(props)}
    >
      <TabsIndicator variant={variant} />
      {children}
    </TabsListPrimitive>
  )
}

const tabsIndicatorVariants = cva(
  "pointer-events-none absolute left-(--active-tab-left) transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default:
          "top-(--active-tab-top) h-(--active-tab-height) w-(--active-tab-width) rounded-md border border-border bg-card shadow-xs dark:border-input dark:bg-input/30",
        line: "top-[calc(var(--active-tab-top)+var(--active-tab-height)+3px)] h-0.5 w-(--active-tab-width) bg-primary group-data-vertical/tabs:hidden",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const TabsIndicator = React.memo(function TabsIndicator({
  variant,
}: RelaxOptional<VariantProps<typeof tabsIndicatorVariants>>) {
  return (
    <TabsIndicatorPrimitive className={tabsIndicatorVariants({ variant })} />
  )
})

function TabsTrigger({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof TabsTabPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <TabsTabPrimitive
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-selected:bg-transparent dark:group-data-[variant=line]/tabs-list:data-selected:border-transparent dark:group-data-[variant=line]/tabs-list:data-selected:bg-transparent",
        "data-selected:text-primary dark:data-selected:text-primary group-data-[variant=default]/tabs-list:not-data-selected:hover:bg-foreground/5",
        "after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:data-selected:after:opacity-100",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function TabsContent({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof TabsPanelPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <TabsPanelPrimitive
      className={cn("flex-1 text-sm outline-none", className)}
      {...omitUndefined(props)}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
