"use client"

import * as React from "react"
import {
  Drawer as DrawerPrimitive,
  DrawerBackdrop as DrawerBackdropPrimitive,
  DrawerClose as DrawerClosePrimitive,
  DrawerContent as DrawerContentPrimitive,
  DrawerDescription as DrawerDescriptionPrimitive,
  DrawerTitle as DrawerTitlePrimitive,
  DrawerTrigger as DrawerTriggerPrimitive,
} from "@ui-sdk/react/drawer"
import { XIcon } from "lucide-react"

import { Button } from "#components/button"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

const Drawer = DrawerPrimitive
const DrawerTrigger = DrawerTriggerPrimitive
const DrawerClose = DrawerClosePrimitive

function DrawerContent({
  className,
  side = "right",
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof DrawerContentPrimitive>, "className" | "children">> & {
  className?: string | undefined
  side?: "right" | "left" | "bottom" | undefined
  children?: React.ReactNode | undefined
}) {
  const sideClasses =
    side === "left"
      ? "inset-y-0 left-0 h-svh w-80 max-w-[90vw] border-r"
      : side === "bottom"
        ? "inset-x-0 bottom-0 max-h-[85svh] w-full rounded-t-xl border-t"
        : "inset-y-0 right-0 h-svh w-96 max-w-[92vw] border-l"

  return (
    <>
      <DrawerBackdropPrimitive className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] data-closed:pointer-events-none" />
      <DrawerContentPrimitive
        className={cn(
          "fixed z-50 flex flex-col bg-card text-foreground shadow-xl outline-none data-closed:pointer-events-none",
          sideClasses,
          className,
        )}
        {...omitUndefined(props)}
      >
        {children}
      </DrawerContentPrimitive>
    </>
  )
}

function DrawerHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start justify-between gap-2 border-b px-4 py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      <DrawerClosePrimitive
        aria-label="关闭抽屉"
        render={<Button size="icon-xs" type="button" variant="ghost" />}
      >
        <XIcon aria-hidden="true" className="size-4" />
      </DrawerClosePrimitive>
    </div>
  )
}

function DrawerTitle({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof DrawerTitlePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <DrawerTitlePrimitive
      className={cn("text-sm font-semibold text-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof DrawerDescriptionPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <DrawerDescriptionPrimitive
      className={cn("text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
}
