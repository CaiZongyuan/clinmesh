"use client"

import * as React from "react"
import { fuzzyScore, matchRanges, matchSegments } from "@ui-sdk/core/text-match"

import { cn } from "#lib/utils"

interface HighlightTextProps {
  text: string
  query: string
  mode?: "contains" | "fuzzy" | "startsWith"
  className?: string
  markClassName?: string
}

function HighlightText({
  text,
  query,
  mode = "contains",
  className,
  markClassName,
}: HighlightTextProps) {
  const trimmed = query.trim()
  if (!trimmed) {
    return <span className={className}>{text}</span>
  }
  const ranges = matchRanges(text, trimmed, mode)
  if (ranges.length === 0) {
    return <span className={className}>{text}</span>
  }
  const segments = matchSegments(text, ranges)
  return (
    <span className={className}>
      {segments.map((seg, idx) =>
        seg.match ? (
          <mark
            className={cn("rounded-xs bg-accent px-0.5 font-medium text-accent-foreground", markClassName)}
            key={idx}
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={idx}>{seg.text}</React.Fragment>
        ),
      )}
    </span>
  )
}

export { fuzzyScore, HighlightText, matchRanges, matchSegments, type HighlightTextProps }
