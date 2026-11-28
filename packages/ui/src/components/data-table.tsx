"use client"

import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react"

import { Button } from "#components/button"
import { Checkbox } from "#components/checkbox"
import {
  Pagination,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
} from "#components/pagination"
import { Popover, PopoverContent, PopoverTrigger } from "#components/popover"
import { Switch } from "#components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/table"
import { cn } from "#lib/utils"

export type DataTableSortDirection = "asc" | "desc"

export interface DataTableColumn<T> {
  id: string
  header: string
  /** Optional sort value extractor; enables clicking header to sort. */
  sortValue?: (row: T) => string | number
  /** Allow toggling visibility in Display popover (default true). */
  hideable?: boolean
  /** Initial visibility (default true). */
  defaultVisible?: boolean
  align?: "left" | "right" | "center"
  cellClassName?: string
  cell: (row: T) => React.ReactNode
}

export interface DataTableProps<T> {
  ariaLabel: string
  columns: readonly DataTableColumn<T>[]
  rows: readonly T[]
  getRowId: (row: T) => string
  /** Enable row checkboxes and floating batch toolbar. */
  selectable?: boolean
  selectedIds?: ReadonlySet<string>
  onSelectedIdsChange?: (next: ReadonlySet<string>) => void
  /** Render actions inside the floating bottom batch bar when selectedCount > 0. */
  renderBatchActions?: (selectedRows: readonly T[], clearSelection: () => void) => React.ReactNode
  /** Optional toolbar slot on the left (search input, filters, etc.). */
  toolbarLeading?: React.ReactNode
  /** Optional toolbar slot on the right (before Display button). */
  toolbarTrailing?: React.ReactNode
  /** Optional click handler on row activation. */
  onRowClick?: (row: T) => void
  /** Page size for client-side pagination (omit or 0 to disable pagination). */
  pageSize?: number
  emptyState?: React.ReactNode
  loading?: boolean
  loadingText?: string
  displayLabel?: string
  columnsHeading?: string
  selectedLabel?: (count: number) => string
  clearSelectionLabel?: string
  className?: string
}

function DataTable<T>({
  ariaLabel,
  columns,
  rows,
  getRowId,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
  renderBatchActions,
  toolbarLeading,
  toolbarTrailing,
  onRowClick,
  pageSize = 0,
  emptyState,
  loading = false,
  loadingText = "正在加载…",
  displayLabel = "显示列",
  columnsHeading = "列显示开关",
  selectedLabel = count => `已选 ${count} 项`,
  clearSelectionLabel = "清除选择",
  className,
}: DataTableProps<T>) {
  const [sortField, setSortField] = React.useState<string | null>(null)
  const [sortDir, setSortDir] = React.useState<DataTableSortDirection>("asc")
  const [hiddenCols, setHiddenCols] = React.useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>()
    for (const col of columns) {
      if (col.defaultVisible === false) initial.add(col.id)
    }
    return initial
  })
  const [internalSelected, setInternalSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [page, setPage] = React.useState(1)

  const selectedIds = controlledSelectedIds ?? internalSelected
  const setSelectedIds = React.useCallback(
    (next: ReadonlySet<string>) => {
      if (onSelectedIdsChange) onSelectedIdsChange(next)
      else setInternalSelected(next)
    },
    [onSelectedIdsChange],
  )

  const visibleColumns = React.useMemo(
    () => columns.filter(col => !hiddenCols.has(col.id)),
    [columns, hiddenCols],
  )

  const sortedRows = React.useMemo(() => {
    if (!sortField) return rows
    const col = columns.find(c => c.id === sortField)
    if (!col?.sortValue) return rows
    const getter = col.sortValue
    return [...rows].sort((a, b) => {
      const av = getter(a)
      const bv = getter(b)
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "zh-CN", { numeric: true })
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [columns, rows, sortDir, sortField])

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1
  const safePage = Math.min(page, totalPages)
  const displayedRows = React.useMemo(() => {
    if (pageSize <= 0) return sortedRows
    const start = (safePage - 1) * pageSize
    return sortedRows.slice(start, start + pageSize)
  }, [pageSize, safePage, sortedRows])

  React.useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const displayedIds = React.useMemo(() => displayedRows.map(getRowId), [displayedRows, getRowId])
  const allDisplayedSelected =
    displayedIds.length > 0 && displayedIds.every(id => selectedIds.has(id))
  const someDisplayedSelected =
    displayedIds.some(id => selectedIds.has(id)) && !allDisplayedSelected

  const selectedRows = React.useMemo(
    () => rows.filter(r => selectedIds.has(getRowId(r))),
    [getRowId, rows, selectedIds],
  )

  const handleToggleSort = (colId: string) => {
    if (sortField !== colId) {
      setSortField(colId)
      setSortDir("asc")
    } else if (sortDir === "asc") {
      setSortDir("desc")
    } else {
      setSortField(null)
    }
  }

  const handleToggleColumn = (colId: string, visible: boolean) => {
    setHiddenCols(prev => {
      const next = new Set(prev)
      if (visible) next.delete(colId)
      else next.add(colId)
      return next
    })
  }

  const handleToggleAll = (checked: boolean) => {
    const next = new Set(selectedIds)
    for (const id of displayedIds) {
      if (checked) next.add(id)
      else next.delete(id)
    }
    setSelectedIds(next)
  }

  const handleToggleRow = (id: string, checked: boolean) => {
    const next = new Set(selectedIds)
    if (checked) next.add(id)
    else next.delete(id)
    setSelectedIds(next)
  }

  const clearSelection = React.useCallback(() => setSelectedIds(new Set()), [setSelectedIds])

  const hideableCols = React.useMemo(
    () => columns.filter(col => col.hideable !== false),
    [columns],
  )

  const showToolbar = Boolean(toolbarLeading || toolbarTrailing || hideableCols.length > 0)

  return (
    <div className={cn("relative flex flex-col gap-3", className)} data-cm="data-table">
      {showToolbar ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{toolbarLeading}</div>
          <div className="flex flex-wrap items-center gap-2">
            {toolbarTrailing}
            {hideableCols.length > 0 ? (
              <Popover>
                <PopoverTrigger
                  render={(
                    <Button size="sm" type="button" variant="outline">
                      <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
                      <span>{displayLabel}</span>
                    </Button>
                  )}
                />
                <PopoverContent align="end" className="w-56 p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    {columnsHeading}
                  </div>
                  <div className="flex flex-col gap-2">
                    {hideableCols.map(col => {
                      const visible = !hiddenCols.has(col.id)
                      const isOnlyVisible = visible && visibleColumns.length <= 1
                      return (
                        <div className="flex items-center justify-between gap-2 text-xs" key={col.id}>
                          <span className="truncate text-foreground">{col.header}</span>
                          <Switch
                            aria-label={col.header}
                            checked={visible}
                            disabled={isOnlyVisible}
                            onCheckedChange={checked => handleToggleColumn(col.id, checked)}
                          />
                        </div>
                      )
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table aria-label={ariaLabel}>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-10 px-3">
                  <Checkbox
                    aria-label="全选当前页"
                    checked={allDisplayedSelected ? true : someDisplayedSelected ? "indeterminate" : false}
                    onCheckedChange={checked => handleToggleAll(checked === true)}
                  />
                </TableHead>
              ) : null}
              {visibleColumns.map(col => {
                const isSorted = sortField === col.id
                const alignClass =
                  col.align === "right"
                    ? "text-right"
                    : col.align === "center"
                      ? "text-center"
                      : "text-left"
                return (
                  <TableHead className={cn(alignClass, col.cellClassName)} key={col.id}>
                    {col.sortValue ? (
                      <Button
                        className={cn(
                          "-ml-2 h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
                          isSorted && "text-foreground",
                        )}
                        onClick={() => handleToggleSort(col.id)}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        <span>{col.header}</span>
                        {isSorted ? (
                          sortDir === "asc" ? (
                            <ArrowUpIcon aria-hidden="true" className="size-3.5" />
                          ) : (
                            <ArrowDownIcon aria-hidden="true" className="size-3.5" />
                          )
                        ) : (
                          <ArrowUpDownIcon aria-hidden="true" className="size-3 opacity-50" />
                        )}
                      </Button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  className="py-8 text-center text-xs text-muted-foreground"
                  colSpan={visibleColumns.length + (selectable ? 1 : 0)}
                >
                  {loadingText}
                </TableCell>
              </TableRow>
            ) : displayedRows.length === 0 ? (
              <TableRow>
                <TableCell
                  className="py-8 text-center text-xs text-muted-foreground"
                  colSpan={visibleColumns.length + (selectable ? 1 : 0)}
                >
                  {emptyState ?? "暂无数据"}
                </TableCell>
              </TableRow>
            ) : (
              displayedRows.map(row => {
                const id = getRowId(row)
                const isSelected = selectedIds.has(id)
                return (
                  <TableRow
                    className={cn(
                      onRowClick && "cursor-pointer",
                      isSelected && "bg-accent/45",
                    )}
                    data-state={isSelected ? "selected" : undefined}
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectable ? (
                      <TableCell
                        className="w-10 px-3"
                        onClick={event => event.stopPropagation()}
                      >
                        <Checkbox
                          aria-label={`选择行 ${id}`}
                          checked={isSelected}
                          onCheckedChange={checked => handleToggleRow(id, checked === true)}
                        />
                      </TableCell>
                    ) : null}
                    {visibleColumns.map(col => {
                      const alignClass =
                        col.align === "right"
                          ? "text-right"
                          : col.align === "center"
                            ? "text-center"
                            : "text-left"
                      return (
                        <TableCell className={cn(alignClass, col.cellClassName)} key={col.id}>
                          {col.cell(row)}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {pageSize > 0 && totalPages > 1 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            共 {sortedRows.length} 条 · 第 {safePage} / {totalPages} 页
          </span>
          <Pagination
            aria-label={`${ariaLabel} 分页`}
            onPageChange={setPage}
            page={safePage}
            pageCount={totalPages}
          >
            <PaginationList>
              <PaginationItem>
                <PaginationPrevious />
              </PaginationItem>
              {paginationRange({ pageCount: totalPages, page: safePage, siblings: 1 }).map((entry, idx) =>
                typeof entry !== "number" ? (
                  <PaginationItem key={`${entry}-${idx}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={entry}>
                    <PaginationLink page={entry} />
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext />
              </PaginationItem>
            </PaginationList>
          </Pagination>
        </div>
      ) : null}

      {selectable && selectedRows.length > 0 && renderBatchActions ? (
        <div
          aria-label={selectedLabel(selectedRows.length)}
          className="sticky bottom-3 z-20 mx-auto flex w-fit items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-xs shadow-lg ring-1 ring-border"
          data-cm="data-table-batch-bar"
          role="toolbar"
        >
          <div className="flex items-center gap-1.5 border-r pr-2.5">
            <span className="font-medium text-foreground tabular-nums">
              {selectedLabel(selectedRows.length)}
            </span>
            <Button
              aria-label={clearSelectionLabel}
              onClick={clearSelection}
              size="icon-xs"
              title={clearSelectionLabel}
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            {renderBatchActions(selectedRows, clearSelection)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export { DataTable }
