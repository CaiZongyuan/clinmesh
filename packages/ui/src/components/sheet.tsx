"use client"

import * as React from "react"
import {
  Dialog as SheetPrimitive,
  DialogBackdrop as SheetBackdropPrimitive,
  DialogClose as SheetClosePrimitive,
  DialogContent as SheetContentPrimitive,
  DialogDescription as SheetDescriptionPrimitive,
  DialogTitle as SheetTitlePrimitive,
  DialogTrigger as SheetTriggerPrimitive,
} from "@ui-sdk/react/dialog"
import { XIcon } from "lucide-react"

import { Button } from "#components/button"
import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Sheet({
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof SheetPrimitive>>) {
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)
  return (
    <SheetPrimitive
      {...(containerElement !== undefined
        ? { container: containerElement }
        : {})}
      {...omitUndefined(props)}
    />
  )
}

function SheetTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof SheetTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <SheetTriggerPrimitive {...omitUndefined(props)} />
}

function SheetClose({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof SheetClosePrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <SheetClosePrimitive {...omitUndefined(props)} />
}

function SheetOverlay({
  className,
  forceRender: _forceRender,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof SheetBackdropPrimitive>, "className">
> & {
  className?: string | undefined
  forceRender?: boolean | undefined
}) {
  return (
    <SheetBackdropPrimitive
      data-sheet-overlay=""
      className={cn(
        "fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function SheetContent({
  className,
  children,
  forceOverlay = false,
  side = "right",
  showCloseButton = true,
  container,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SheetContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  forceOverlay?: boolean | undefined
  side?: "top" | "right" | "bottom" | "left" | undefined
  showCloseButton?: boolean | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)

  return (
    <>
      <SheetOverlay forceRender={forceOverlay} />
      <SheetContentPrimitive
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        data-sheet=""
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg data-closed:pointer-events-none data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className
        )}
        {...omitUndefined(props)}
      >
        {children}
        {showCloseButton && (
          <SheetClosePrimitive
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetClosePrimitive>
        )}
      </SheetContentPrimitive>
    </>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SheetTitlePrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <SheetTitlePrimitive
      className={cn("text-base font-medium text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof SheetDescriptionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <SheetDescriptionPrimitive
      className={cn("text-sm text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
