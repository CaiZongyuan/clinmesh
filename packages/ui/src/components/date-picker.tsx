"use client"

import * as React from "react"
import {
  CalendarDay as CalendarDayPrimitive,
  CalendarGrid as CalendarGridPrimitive,
  CalendarHeading as CalendarHeadingPrimitive,
  CalendarNext as CalendarNextPrimitive,
  CalendarPrevious as CalendarPreviousPrimitive,
  CalendarWeekday as CalendarWeekdayPrimitive,
  CalendarWeekdays as CalendarWeekdaysPrimitive,
  CalendarWeeks as CalendarWeeksPrimitive,
  DatePicker as DatePickerPrimitive,
  DatePickerContent as DatePickerContentPrimitive,
  DatePickerInput as DatePickerInputPrimitive,
  DatePickerTrigger as DatePickerTriggerPrimitive,
} from "@ui-sdk/react/date-picker"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

interface DatePickerFieldProps
  extends RelaxOptional<
    Omit<React.ComponentProps<typeof DatePickerPrimitive>, "className" | "children">
  > {
  className?: string | undefined
  inputAriaLabel?: string | undefined
  triggerAriaLabel?: string | undefined
  placeholder?: string | undefined
}

function DatePickerField({
  className,
  inputAriaLabel = "选择日期",
  triggerAriaLabel = "打开日历",
  placeholder = "YYYY-MM-DD",
  ...props
}: DatePickerFieldProps) {
  return (
    <DatePickerPrimitive
      className={cn("inline-flex items-center gap-1.5", className)}
      {...omitUndefined(props)}
    >
      <div className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <DatePickerInputPrimitive
          aria-label={inputAriaLabel}
          className="h-full w-32 bg-transparent px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground tabular-nums"
          placeholder={placeholder}
        />
        <DatePickerTriggerPrimitive
          aria-label={triggerAriaLabel}
          className="inline-flex h-full w-8 cursor-pointer items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <CalendarIcon aria-hidden="true" className="size-3.5" />
        </DatePickerTriggerPrimitive>
      </div>
      <DatePickerContentPrimitive className="z-50 w-64 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-border/60">
        <div className="mb-2 flex items-center justify-between">
          <CalendarPreviousPrimitive
            aria-label="上个月"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
          </CalendarPreviousPrimitive>
          <CalendarHeadingPrimitive className="text-xs font-semibold text-foreground" />
          <CalendarNextPrimitive
            aria-label="下个月"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </CalendarNextPrimitive>
        </div>
        <CalendarGridPrimitive className="w-full border-collapse text-center">
          <CalendarWeekdaysPrimitive>
            {index => (
              <CalendarWeekdayPrimitive
                className="pb-1 text-[11px] font-medium text-muted-foreground"
                index={index}
              />
            )}
          </CalendarWeekdaysPrimitive>
          <CalendarWeeksPrimitive>
            {cell => (
              <CalendarDayPrimitive
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-xs tabular-nums transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[outside]:text-muted-foreground/40 data-[today]:font-semibold data-[today]:text-info data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                value={cell.date}
              />
            )}
          </CalendarWeeksPrimitive>
        </CalendarGridPrimitive>
      </DatePickerContentPrimitive>
    </DatePickerPrimitive>
  )
}

export { DatePickerField, type DatePickerFieldProps }
