import * as React from "react"
import {
  createToaster,
  Toast as ToastPrimitive,
  ToastAction as ToastActionPrimitive,
  ToastClose as ToastClosePrimitive,
  ToastDescription as ToastDescriptionPrimitive,
  ToastRegion as ToastRegionPrimitive,
  ToastTitle as ToastTitlePrimitive,
  type ToastData,
  type Toaster as UiSdkToaster,
  type ToastOptions,
  type ToastType,
} from "@ui-sdk/react/toast"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { Button } from "#components/button"
import {
  resolvePortalContainer,
  usePortalContainer,
} from "#components/portal-context"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

type LegacyToastActionProps = {
  children?: React.ReactNode | undefined
  onClick?: (() => unknown) | undefined
}

type ToastAddOptions = Omit<ToastOptions<React.ReactNode>, "type"> & {
  type?: ToastType | (string & {}) | undefined
  timeout?: number | undefined
  actionProps?: LegacyToastActionProps | undefined
}

type ToastManager = UiSdkToaster<React.ReactNode> & {
  add: (options: ToastAddOptions) => string
  close: (id: string) => void
}

function normalizeToastType(type: string | undefined): ToastType | undefined {
  if (
    type === "default" ||
    type === "success" ||
    type === "error" ||
    type === "info" ||
    type === "warning" ||
    type === "loading"
  ) {
    return type
  }
  return undefined
}

function createToastManager(options?: { duration?: number }): ToastManager {
  const toaster = createToaster<React.ReactNode>({
    duration: options?.duration ?? 3500,
  })
  const manager = toaster as ToastManager
  manager.add = ({ timeout, type, actionProps, action, ...rest }: ToastAddOptions) => {
    const normalizedType = normalizeToastType(type)
    const duration = rest.duration ?? timeout
    const resolvedAction =
      action ??
      (actionProps && actionProps.children !== undefined
        ? {
            label: actionProps.children,
            ...(actionProps.onClick
              ? {
                  onAction: () => {
                    actionProps.onClick?.()
                  },
                }
              : {}),
          }
        : undefined)
    return toaster({
      ...omitUndefined(rest as Record<string, unknown>),
      ...(normalizedType !== undefined ? { type: normalizedType } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(resolvedAction !== undefined ? { action: resolvedAction } : {}),
    })
  }
  manager.close = (id: string) => {
    toaster.dismiss(id)
  }
  return manager
}

const toast = createToastManager({ duration: 3500 })

const ToastManagerContext = React.createContext<ToastManager>(toast)

function useToastManager() {
  const manager = React.useContext(ToastManagerContext)
  const toasts = React.useSyncExternalStore(
    manager.subscribe,
    manager.toasts,
    manager.toasts
  )
  return {
    toasts,
    add: manager.add,
    close: manager.close,
    update: manager.update,
    dismiss: manager.dismiss,
  }
}

function ToastProvider({
  toastManager = toast,
  children,
}: {
  toastManager?: ToastManager | undefined
  limit?: number | undefined
  timeout?: number | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ToastManagerContext.Provider value={toastManager}>
      {children}
    </ToastManagerContext.Provider>
  )
}

function ToastPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full",
        className
      )}
      {...props}
    />
  )
}

function Toast({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof ToastPrimitive>, "className">
> & {
  className?: string | undefined
}) {
  return (
    <ToastPrimitive
      className={cn(
        "group/toast pointer-events-none absolute right-0 bottom-0 z-[calc(1000-var(--toast-index,0))] w-full origin-bottom rounded-2xl border bg-popover text-popover-foreground shadow-lg will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "[--gap:0.75rem] [--height:var(--toast-front-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset,0px)*-1+calc(var(--toast-index,0)*var(--gap)*-1)+var(--toast-swipe-y,0px))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index,0)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transform:translateX(var(--toast-swipe-x,0px))_translateY(calc(var(--toast-swipe-y,0px)-(var(--toast-index,0)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-x,0px))_translateY(var(--offset-y))]",
        "data-starting-style:[transform:translateY(150%)]",
        "[&[data-ending-style]:not([data-swipe-direction])]:[transform:translateY(150%)]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-y,0px)+150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-x,0px)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-x,0px)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-y,0px)-150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-y,0px)+150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-x,0px)-150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-x,0px)+150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-y,0px)-150%))]",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function ToastContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="toast-content"
      className={cn(
        "flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100",
        "[&[data-behind]:not([data-expanded])_[data-slot=toast-action]]:pointer-events-none [&[data-behind]:not([data-expanded])_[data-slot=toast-close]]:pointer-events-none",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({
  className,
  ...props
}: RelaxOptional<
  Omit<React.ComponentProps<typeof ToastTitlePrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ToastTitlePrimitive
      className={cn("text-sm font-medium", className)}
      {...omitUndefined(props)}
    />
  )
}

function ToastDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ToastDescriptionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ToastDescriptionPrimitive
      className={cn("text-sm text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ToastActionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ToastActionPrimitive
      render={render}
      className={cn("pointer-events-auto shrink-0", className)}
      {...omitUndefined(props)}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: RelaxOptional<
  Omit<
    React.ComponentProps<typeof ToastClosePrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <ToastClosePrimitive
      aria-label="Close toast"
      render={render}
      className={cn(
        "pointer-events-auto relative shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground",
        className
      )}
      {...omitUndefined(props)}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastClosePrimitive>
  )
}

function ToastIcon({ type }: { type: string | undefined }) {
  let icon: React.ReactNode = null

  if (type === "success") {
    icon = <CircleCheckIcon aria-hidden="true" />
  } else if (type === "info") {
    icon = <InfoIcon aria-hidden="true" />
  } else if (type === "warning") {
    icon = <TriangleAlertIcon aria-hidden="true" />
  } else if (type === "error") {
    icon = <OctagonXIcon className="text-destructive" aria-hidden="true" />
  } else if (type === "loading") {
    icon = <Loader2Icon className="animate-spin" aria-hidden="true" />
  }

  if (!icon) return null

  return (
    <span
      data-slot="toast-icon"
      className="shrink-0 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
    >
      {icon}
    </span>
  )
}

function renderToastItem(toastItem: ToastData<React.ReactNode>) {
  return (
    <Toast key={toastItem.id}>
      {(state) => (
        <ToastContent
          data-behind={state.front ? undefined : ""}
          data-expanded={state.expanded ? "" : undefined}
        >
          <ToastIcon type={toastItem.type} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastAction />
          <ToastClose />
        </ToastContent>
      )}
    </Toast>
  )
}

function Toaster({
  children,
  limit = 2,
  timeout: _timeout = 3500,
  toastManager = toast,
  container,
}: {
  children?: React.ReactNode | undefined
  limit?: number | undefined
  timeout?: number | undefined
  toastManager?: ToastManager | undefined
  container?: Element | DocumentFragment | null | undefined
}) {
  const portalContainer = usePortalContainer()
  const containerElement = resolvePortalContainer(container ?? portalContainer)

  return (
    <ToastProvider toastManager={toastManager}>
      {children}
      <ToastRegionPrimitive
        toaster={toastManager}
        side="bottom"
        align="end"
        maxVisible={limit}
        {...(containerElement !== undefined
          ? { container: containerElement }
          : {})}
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full"
      >
        {renderToastItem}
      </ToastRegionPrimitive>
    </ToastProvider>
  )
}

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
}
