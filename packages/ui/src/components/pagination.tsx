"use client"

import * as React from "react"
import {
  Pagination as PaginationPrimitive,
  PaginationEllipsis as PaginationEllipsisPrimitive,
  PaginationItem as PaginationItemPrimitive,
  PaginationLink as PaginationLinkPrimitive,
  PaginationList as PaginationListPrimitive,
  PaginationNext as PaginationNextPrimitive,
  PaginationPrevious as PaginationPreviousPrimitive,
  paginationRange,
} from "@ui-sdk/react/pagination"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Pagination({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <PaginationPrimitive
      className={cn("flex items-center justify-center", className)}
      {...omitUndefined(props)}
    />
  )
}

function PaginationList({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationListPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <PaginationListPrimitive
      className={cn("flex items-center gap-1", className)}
      {...omitUndefined(props)}
    />
  )
}

function PaginationItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <PaginationItemPrimitive
      className={cn("list-none", className)}
      {...omitUndefined(props)}
    />
  )
}

const pageBtnBase =
  "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2 text-xs font-medium tabular-nums text-foreground transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:border-border aria-[current=page]:bg-card aria-[current=page]:shadow-2xs aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40"

function PaginationLink({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationLinkPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <PaginationLinkPrimitive
      className={cn(pageBtnBase, className)}
      {...omitUndefined(props)}
    />
  )
}

function PaginationPrevious({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationPreviousPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <PaginationPreviousPrimitive
      className={cn(pageBtnBase, "gap-1 px-2", className)}
      {...omitUndefined(props)}
    >
      {children ?? (
        <>
          <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
          <span className="sr-only">Previous</span>
        </>
      )}
    </PaginationPreviousPrimitive>
  )
}

function PaginationNext({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationNextPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <PaginationNextPrimitive
      className={cn(pageBtnBase, "gap-1 px-2", className)}
      {...omitUndefined(props)}
    >
      {children ?? (
        <>
          <span className="sr-only">Next</span>
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </>
      )}
    </PaginationNextPrimitive>
  )
}

function PaginationEllipsis({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof PaginationEllipsisPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <PaginationEllipsisPrimitive
      className={cn("inline-flex h-7 w-7 items-center justify-center text-xs text-muted-foreground", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
}
