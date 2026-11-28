"use client"

import * as React from "react"
import {
  Dialog as DialogPrimitive,
  DialogBackdrop as DialogBackdropPrimitive,
  DialogClose as DialogClosePrimitive,
  DialogContent as DialogContentPrimitive,
  DialogDescription as DialogDescriptionPrimitive,
  DialogTitle as DialogTitlePrimitive,
  DialogTrigger as DialogTriggerPrimitive,
  type DialogFinalFocus,
  type DialogInitialFocus,
} from "@ui-sdk/react/dialog"
import { XIcon } from "lucide-react"

import { Button } from "#components/button"
import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"
import { DialogPendingContext, useDialogPending } from "../dialog-pending.tsx"

type LegacyFocusTarget<T> =
  | T
  | boolean
  | React.RefObject<HTMLElement | null>
  | undefined

function resolveFocusTarget<T extends DialogInitialFocus | DialogFinalFocus>(
  target: LegacyFocusTarget<T>
): T | undefined {
  if (target === undefined || target === true) return undefined
  if (target === false) return "none" as T
  if (typeof target === "object" && target !== null && "current" in target) {
    return (() => target.current) as T
  }
  return target
}

function Dialog({
  pending,
  onOpenChange,
  disablePointerDismissal,
  dismissible,
  closeOnOutsidePress,
  container,
  ...props
}: RelaxOptional<React.ComponentProps<typeof DialogPrimitive>> & {
  pending?: boolean | undefined
  disablePointerDismissal?: boolean | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)
  const resolvedDismissible = pending ? false : dismissible
  const resolvedCloseOnOutsidePress = pending
    ? false
    : disablePointerDismissal
      ? false
      : closeOnOutsidePress

  return (
    <DialogPendingContext.Provider value={Boolean(pending)}>
      <DialogPrimitive
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        {...(resolvedDismissible !== undefined
          ? { dismissible: resolvedDismissible }
          : {})}
        {...(resolvedCloseOnOutsidePress !== undefined
          ? { closeOnOutsidePress: resolvedCloseOnOutsidePress }
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

function DialogTrigger({
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof DialogTriggerPrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  return <DialogTriggerPrimitive {...omitUndefined(props)} />
}

function DialogClose({
  disabled,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof DialogClosePrimitive>, "children">
> & {
  children?: React.ReactNode | undefined
}) {
  const pending = useDialogPending()
  return (
    <DialogClosePrimitive
      {...omitUndefined(props)}
      disabled={Boolean(pending || disabled)}
    />
  )
}

function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function DialogOverlay({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof DialogBackdropPrimitive>, "className">
> & {
  className?: string | undefined
}) {
  return (
    <DialogBackdropPrimitive
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/15 supports-backdrop-filter:backdrop-blur-xs data-closed:pointer-events-none",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function DialogContent({
  children,
  className,
  keepMounted,
  showCloseButton = true,
  initialFocus,
  finalFocus,
  container,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof DialogContentPrimitive>,
    "className" | "children" | "initialFocus" | "finalFocus"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
  showCloseButton?: boolean | undefined
  initialFocus?: LegacyFocusTarget<DialogInitialFocus>
  finalFocus?: LegacyFocusTarget<DialogFinalFocus>
}) {
  const pending = useDialogPending()
  const portalContainer = usePortalContainer()
  const containerElement =
    resolvePortalContainer(container ?? portalContainer) ??
    (typeof document !== "undefined" ? document.body : undefined)
  const resolvedInitialFocus = resolveFocusTarget(initialFocus)
  const resolvedFinalFocus = resolveFocusTarget(finalFocus)

  return (
    <>
      <DialogOverlay />
      <DialogContentPrimitive
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        {...(keepMounted !== undefined ? { keepMounted } : {})}
        {...(resolvedInitialFocus !== undefined
          ? { initialFocus: resolvedInitialFocus }
          : {})}
        {...(resolvedFinalFocus !== undefined
          ? { finalFocus: resolvedFinalFocus }
          : {})}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none data-closed:pointer-events-none",
          className
        )}
        {...omitUndefined(props)}
        aria-busy={pending || props["aria-busy"]}
      >
        {children}
        {showCloseButton ? (
          <DialogClose
            render={
              <Button
                aria-label="Close"
                className="absolute top-3 right-3"
                size="icon-sm"
                title="Close"
                type="button"
                variant="ghost"
              />
            }
          >
            <XIcon />
          </DialogClose>
        ) : null}
      </DialogContentPrimitive>
    </>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b px-4 py-3 pr-12",
        className
      )}
      data-slot="dialog-header"
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/30 px-4 py-3 sm:flex-row sm:justify-end",
        className
      )}
      data-slot="dialog-footer"
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof DialogTitlePrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <DialogTitlePrimitive
      className={cn("text-base font-semibold", className)}
      {...omitUndefined(props)}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof DialogDescriptionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <DialogDescriptionPrimitive
      className={cn("text-sm text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
