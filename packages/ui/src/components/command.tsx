"use client"

import * as React from "react"
import {
  Command as CommandPrimitive,
  CommandEmpty as CommandEmptyPrimitive,
  CommandGroup as CommandGroupPrimitive,
  CommandGroupLabel as CommandGroupLabelPrimitive,
  CommandInput as CommandInputPrimitive,
  CommandItem as CommandItemPrimitive,
  CommandItemText as CommandItemTextPrimitive,
  CommandList as CommandListPrimitive,
  CommandPage as CommandPagePrimitive,
  CommandSeparator as CommandSeparatorPrimitive,
  CommandShortcut as CommandShortcutPrimitive,
} from "@ui-sdk/react/command"
import { SearchIcon } from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "#components/dialog"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Command({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandPrimitive
      className={cn("flex h-full w-full flex-col overflow-hidden bg-popover p-0 text-popover-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandInput({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandInputPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2.5" data-slot="command-input-wrapper">
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <CommandInputPrimitive
        className={cn(
          "flex h-6 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...omitUndefined(props)}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandListPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandListPrimitive
      className={cn("max-h-80 overflow-y-auto p-1.5", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandEmptyPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandEmptyPrimitive
      className={cn("py-8 text-center text-xs text-muted-foreground empty:hidden", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandGroupPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandGroupPrimitive
      className={cn("overflow-hidden py-1", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandGroupLabel({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandGroupLabelPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandGroupLabelPrimitive
      className={cn("px-2 py-1 text-[11px] font-medium text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandSeparatorPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandSeparatorPrimitive
      className={cn("my-1 -mx-1.5 h-px bg-border", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandItemPrimitive
      className={cn(
        "relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function CommandItemText({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandItemTextPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return <CommandItemTextPrimitive className={cn("truncate", className)} {...omitUndefined(props)} />
}

function CommandShortcut({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof CommandShortcutPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <CommandShortcutPrimitive
      className={cn("ml-auto text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

function CommandDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[14%] max-w-xl translate-y-0 overflow-hidden p-0"
        data-cm="command-palette"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemText,
  CommandList,
  CommandPagePrimitive as CommandPage,
  CommandSeparator,
  CommandShortcut,
}
