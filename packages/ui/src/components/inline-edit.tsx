"use client"

import * as React from "react"
import { CheckIcon, PencilIcon, XIcon } from "lucide-react"

import { Button } from "#components/button"
import { Input } from "#components/input"
import { cn } from "#lib/utils"

interface InlineEditProps {
  value: string
  onCommit: (next: string) => void
  ariaLabel?: string
  placeholder?: string
  className?: string
}

function InlineEdit({
  value,
  onCommit,
  ariaLabel = "行内编辑",
  placeholder,
  className,
}: InlineEditProps) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed.length > 0 && trimmed !== value) {
      onCommit(trimmed)
    } else {
      setDraft(value)
    }
  }

  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className={cn("inline-flex items-center gap-1", className)}>
        <Input
          aria-label={ariaLabel}
          className="h-7 min-w-44 text-xs"
          onBlur={commit}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
          placeholder={placeholder}
          ref={inputRef}
          value={draft}
        />
        <Button
          aria-label="保存"
          onClick={commit}
          onMouseDown={event => event.preventDefault()}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
        </Button>
        <Button
          aria-label="取消"
          onClick={cancel}
          onMouseDown={event => event.preventDefault()}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
    )
  }

  return (
    <Button
      aria-label={`${ariaLabel}：${value}`}
      className={cn("group/inline-edit h-7 max-w-full justify-start gap-1.5 px-2 font-medium", className)}
      onClick={() => setEditing(true)}
      size="xs"
      title="点击行内编辑"
      type="button"
      variant="ghost"
    >
      <span className="truncate">{value}</span>
      <PencilIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground opacity-60 group-hover/inline-edit:opacity-100" />
    </Button>
  )
}

export { InlineEdit, type InlineEditProps }
