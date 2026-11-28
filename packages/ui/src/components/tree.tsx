"use client"

import * as React from "react"
import {
  Tree as TreePrimitive,
  TreeGroup as TreeGroupPrimitive,
  TreeItem as TreeItemPrimitive,
  TreeItemIndicator as TreeItemIndicatorPrimitive,
  TreeItemLabel as TreeItemLabelPrimitive,
  type TreeItemData,
} from "@ui-sdk/react/tree"
import {
  createTreeCollection,
  toggleTreeChecked,
  treeCheckedStates,
  treeFromPaths,
  visibleTreeRows,
} from "@ui-sdk/core"
import { ChevronRightIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

function Tree({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TreePrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TreePrimitive
      className={cn("flex w-full flex-col gap-0.5 text-sm outline-none select-none", className)}
      {...omitUndefined(props)}
    />
  )
}

function TreeGroup({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TreeGroupPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TreeGroupPrimitive
      className={cn("ml-4 border-l border-border/70 pl-2", className)}
      {...omitUndefined(props)}
    />
  )
}

function TreeItem({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TreeItemPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TreeItemPrimitive
      className={cn(
        "group/tree-item flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-accent data-[selected]:text-accent-foreground",
        className,
      )}
      {...omitUndefined(props)}
    />
  )
}

function TreeItemIndicator({
  className,
  children,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TreeItemIndicatorPrimitive>, "className" | "children">> & {
  className?: string | undefined
  children?: React.ReactNode | undefined
}) {
  return (
    <TreeItemIndicatorPrimitive
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-transform group-data-[expanded]/tree-item:rotate-90",
        className,
      )}
      {...omitUndefined(props)}
    >
      {children ?? <ChevronRightIcon aria-hidden="true" className="size-3.5" />}
    </TreeItemIndicatorPrimitive>
  )
}

function TreeItemLabel({
  className,
  ...props
}: RelaxOptional<Omit<React.ComponentProps<typeof TreeItemLabelPrimitive>, "className">> & {
  className?: string | undefined
}) {
  return (
    <TreeItemLabelPrimitive
      className={cn("truncate", className)}
      {...omitUndefined(props)}
    />
  )
}

export {
  createTreeCollection,
  toggleTreeChecked,
  Tree,
  treeCheckedStates,
  treeFromPaths,
  TreeGroup,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
  visibleTreeRows,
  type TreeItemData,
}
