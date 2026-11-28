import * as React from "react"
import {
  AlertDialog as AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogBackdropPrimitive,
  AlertDialogClose as AlertDialogClosePrimitive,
  AlertDialogContent as AlertDialogContentPrimitive,
  AlertDialogDescription as AlertDialogDescriptionPrimitive,
  AlertDialogTitle as AlertDialogTitlePrimitive,
  AlertDialogTrigger as AlertDialogTriggerPrimitive,
} from "@ui-sdk/react/alert-dialog"

import { Button } from "#components/button"
import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"
import { DialogPendingContext, useDialogPending } from "../dialog-pending.tsx"

function AlertDialog({
  pending,
  onOpenChange,
  dismissible,
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof AlertDialogPrimitive>> & {
  pending?: boolean | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)
  const resolvedDismissible = pending ? false : dismissible

  return (
    <DialogPendingContext.Provider value={Boolean(pending)}>
      <AlertDialogPrimitive
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        {...(resolvedDismissible !== undefined
          ? { dismissible: resolvedDismissible }
          : {})}
        onOpenChange={(open, eventDetails) => {
          if (!open && pending && eventDetails.reason !== "imperative") {
            eventDetails.cancel()
            return
          }
          onOpenChange?.(open, eventDetails)
        }}
        {...omitUndefined(props)}
      />
    </DialogPendingContext.Provider>
  )
}

function AlertDialogTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof AlertDialogTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <AlertDialogTriggerPrimitive {...omitUndefined(props)} />
}

function AlertDialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function AlertDialogOverlay({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof AlertDialogBackdropPrimitive>, "className">
> & {
  className?: string | undefined
}) {
  return (
    <AlertDialogBackdropPrimitive
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  container,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof AlertDialogContentPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  size?: "default" | "sm" | undefined
}) {
  const pending = useDialogPending()
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)

  return (
    <>
      <AlertDialogOverlay />
      <AlertDialogContentPrimitive
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        data-size={size}
        className={cn(
          "group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm data-closed:pointer-events-none",
          className
        )}
        {...omitUndefined(props)}
        aria-busy={pending || props["aria-busy"]}
      />
    </>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof AlertDialogTitlePrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <AlertDialogTitlePrimitive
      className={cn(
        "text-base font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof AlertDialogDescriptionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <AlertDialogDescriptionPrimitive
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="alert-dialog-action"
      className={cn(className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  disabled,
  variant = "outline",
  size = "default",
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof AlertDialogClosePrimitive>,
    "className" | "children"
  >
> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size"> & {
    className?: string | undefined
    children?: React.ReactNode | undefined
  }) {
  const pending = useDialogPending()
  return (
    <AlertDialogClosePrimitive
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...omitUndefined(props)}
      disabled={Boolean(pending || disabled)}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
