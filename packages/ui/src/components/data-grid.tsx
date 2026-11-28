"use client"

import * as React from "react"
import {
  cellsToText,
  createCellRange,
  createGridFocus,
  definePrimitive,
  textToCells,
  type CellRange,
  type GridCell,
} from "@ui-sdk/core"
import { createParts } from "@ui-sdk/react/primitive"
import { CopyIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "#components/button"
import { cn } from "#lib/utils"

interface DataGridProps {
  columns: readonly string[]
  initialRows: readonly (readonly string[])[]
  ariaLabel?: string
  className?: string
  unitSuffix?: string
  copyLabel?: string
  resetLabel?: string
}

type GridState = {
  active: GridCell | null
  range: CellRange | null
  cells: string[][]
  note: string
}

function colLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26))
}

function boundsOf(state: GridState) {
  const { range, active } = state
  if (range) {
    return {
      top: Math.min(range.anchor.row, range.end.row),
      bottom: Math.max(range.anchor.row, range.end.row),
      left: Math.min(range.anchor.col, range.end.col),
      right: Math.max(range.anchor.col, range.end.col),
    }
  }
  return active
    ? { top: active.row, bottom: active.row, left: active.col, right: active.col }
    : null
}

function DataGrid({
  columns,
  initialRows,
  ariaLabel = "Interactive data grid",
  className,
  unitSuffix = "",
  copyLabel = "复制矩阵",
  resetLabel = "重置",
}: DataGridProps) {
  const colCount = columns.length
  const initialMatrix = React.useMemo(
    () => [Array.from(columns), ...initialRows.map(row => Array.from(row))],
    [columns, initialRows],
  )

  const Parts = React.useMemo(() => {
    const primitive = definePrimitive({
      name: "cm-data-grid",
      state: (): GridState => ({
        active: null,
        range:
          initialMatrix.length > 2 && colCount > 2
            ? { anchor: { row: 1, col: 1 }, end: { row: Math.min(2, initialMatrix.length - 1), col: Math.min(2, colCount - 1) } }
            : null,
        cells: initialMatrix.map(r => [...r]),
        note: "",
      }),
      api: context => {
        const rows = () => context.store.get().cells.length
        const cols = () => colCount
        const grid = createGridFocus(context, { key: "active", rows, cols })
        const range = createCellRange(context, { key: "range", grid, rows, cols })
        return {
          grid,
          range,
          copy(event: ClipboardEvent) {
            const state = context.store.get()
            const text = range.text(state, ({ row, col }) => state.cells[row]?.[col] ?? "")
            if (!text) return
            event.preventDefault()
            event.clipboardData?.setData("text/plain", text)
            context.store.set({ note: `已复制 ${text.split("\n").length} 行` })
          },
          paste(event: ClipboardEvent) {
            const rowsIn = textToCells(event.clipboardData?.getData("text/plain") ?? "")
            const state = context.store.get()
            const bounds = range.bounds(state)
            if (!rowsIn.length || !bounds) return
            event.preventDefault()
            const cells = state.cells.map(row => [...row])
            let bottom = bounds.top
            let right = bounds.left
            rowsIn.forEach((row, i) =>
              row.forEach((value, j) => {
                const r = bounds.top + i
                const c = bounds.left + j
                if (r >= cells.length || c >= colCount) return
                const targetRow = cells[r]
                if (!targetRow) return
                targetRow[c] = value
                bottom = Math.max(bottom, r)
                right = Math.max(right, c)
              }),
            )
            context.store.set({ cells, note: "已粘贴到选中区域" })
            range.select({
              anchor: { row: bounds.top, col: bounds.left },
              end: { row: bottom, col: right },
            })
          },
          copyAll() {
            const text = cellsToText(context.store.get().cells)
            navigator.clipboard?.writeText(text).catch(() => undefined)
            context.store.set({ note: `已复制全表（${text.length} 字符）` })
          },
          reset() {
            context.store.set({
              cells: initialMatrix.map(r => [...r]),
              note: "已恢复初始数据",
            })
          },
        }
      },
      slots: slot => ({
        root: slot<object, { label: string; sum: number; count: number; avg: number; note: string }>({
          state: state => {
            const b = boundsOf(state)
            if (!b) return { label: "—", sum: 0, count: 0, avg: 0, note: state.note }
            let sum = 0
            let count = 0
            for (let r = b.top; r <= b.bottom; r++) {
              for (let c = b.left; c <= b.right; c++) {
                const raw = state.cells[r]?.[c] ?? ""
                const val = Number(raw)
                if (r > 0 && raw !== "" && Number.isFinite(val)) {
                  sum += val
                  count++
                }
              }
            }
            const from = `${colLetter(b.left)}${b.top + 1}`
            const to = `${colLetter(b.right)}${b.bottom + 1}`
            return {
              label: from === to ? from : `${from}:${to}`,
              sum: Number(sum.toFixed(2)),
              count,
              avg: count > 0 ? Number((sum / count).toFixed(2)) : 0,
              note: state.note,
            }
          },
        }),
        board: slot({
          attrs: () => ({ role: "grid", "aria-label": ariaLabel }),
          on: {
            copy: (event, { api }) => api.copy(event),
            paste: (event, { api }) => api.paste(event),
          },
        }),
        cell: slot<{ row: number; col: number }, { text: string }>({
          props: { id: "string", row: "number", col: "number" },
          state: (state, { props }) => ({ text: state.cells[props.row]?.[props.col] ?? "" }),
          attrs: (state, { props, api }) => {
            const text = state.cells[props.row]?.[props.col] ?? ""
            return {
              role: "gridcell",
              tabindex: api.grid.tabIndex(state, props),
              ...api.range.cellAttrs(state, props),
              "data-head": props.row === 0 ? "" : undefined,
              "data-number": props.row > 0 && /^-?\d/.test(text) ? "" : undefined,
              "data-active": api.grid.isActive(state, props) ? "" : undefined,
            }
          },
          on: {
            keydown: (event, { api }) => api.range.keydown(event),
            pointerdown: (event, { api, props }) => api.range.pointerdown(event, props),
          },
          bind: (el, { api, props }) => api.range.bind(el, props),
        }),
        copy: slot({
          attrs: () => ({ type: "button" }),
          press: ({ api }) => api.copyAll(),
        }),
        reset: slot({
          attrs: () => ({ type: "button" }),
          press: ({ api }) => api.reset(),
        }),
      }),
    })
    return createParts(primitive, {
      root: "div",
      board: "div",
      cell: "div",
      copy: "button",
      reset: "button",
    })
  }, [ariaLabel, colCount, initialMatrix])

  return (
    <Parts.Root className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3", className)}>
      {({ label, sum, count, avg, note }) => (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground tabular-nums">
                {label}
              </span>
              {count > 0 ? (
                <span className="text-muted-foreground tabular-nums">
                  计数 <strong className="text-foreground">{count}</strong> · 合计{" "}
                  <strong className="text-foreground">{sum}{unitSuffix}</strong> · 均值{" "}
                  <strong className="text-foreground">{avg}{unitSuffix}</strong>
                </span>
              ) : (
                <span className="text-muted-foreground">拖拽或 Shift+方向键框选区域，支持 Ctrl+C / Ctrl+V</span>
              )}
              {note ? <span className="text-info">{note}</span> : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Parts.Copy
                render={<Button size="xs" type="button" variant="outline" />}
              >
                <CopyIcon aria-hidden="true" className="size-3" />
                <span>{copyLabel}</span>
              </Parts.Copy>
              <Parts.Reset
                render={<Button size="xs" type="button" variant="ghost" />}
              >
                <RotateCcwIcon aria-hidden="true" className="size-3" />
                <span>{resetLabel}</span>
              </Parts.Reset>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Parts.Board
              className="grid select-none"
              style={{ gridTemplateColumns: `2rem repeat(${colCount}, minmax(5.5rem, 1fr))` }}
            >
              {/* Column letters header */}
              <div className="border-r border-b bg-muted/60 px-1 py-1 text-center font-mono text-[10px] text-muted-foreground" />
              {columns.map((_, colIdx) => (
                <div
                  className="border-r border-b bg-muted/60 px-2 py-1 text-center font-mono text-[10px] font-medium text-muted-foreground last:border-r-0"
                  key={colIdx}
                >
                  {colLetter(colIdx)}
                </div>
              ))}

              {initialMatrix.map((row, r) => (
                <React.Fragment key={r}>
                  <div className="border-r border-b bg-muted/40 px-1 py-1.5 text-center font-mono text-[10px] text-muted-foreground last:border-b-0">
                    {r + 1}
                  </div>
                  {row.map((_, c) => (
                    <Parts.Cell
                      className="cursor-cell truncate border-r border-b px-2.5 py-1.5 text-xs outline-none last:border-r-0 data-[head]:bg-muted/30 data-[head]:font-medium data-[number]:text-right data-[number]:font-mono data-[number]:tabular-nums data-[in-range]:bg-accent/70 data-[selected]:bg-accent data-[active]:ring-2 data-[active]:ring-inset data-[active]:ring-info"
                      col={c}
                      id={`${r}-${c}`}
                      key={`${r}-${c}`}
                      row={r}
                    >
                      {({ text }) => text}
                    </Parts.Cell>
                  ))}
                </React.Fragment>
              ))}
            </Parts.Board>
          </div>
        </>
      )}
    </Parts.Root>
  )
}

export { DataGrid, type DataGridProps }
