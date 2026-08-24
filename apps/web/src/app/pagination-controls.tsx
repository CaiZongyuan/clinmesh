import { Button } from '@clinmesh/ui/components/button'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import type { WorkspaceMessages } from './workspace-i18n.ts'

interface PaginationControlsProps {
  messages: WorkspaceMessages
  onPageChange: (page: number) => void
  page: number
  pageSize: number
  total: number
}

export function PaginationControls({
  messages,
  onPageChange,
  page,
  pageSize,
  total,
}: PaginationControlsProps): React.JSX.Element | null {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount === 1) return null
  return (
    <nav
      aria-label={messages.paginationLabel}
      className="flex min-h-8 items-center justify-end gap-2"
    >
      <Button
        aria-label={messages.previousPage}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        size="icon-sm"
        title={messages.previousPage}
        type="button"
        variant="outline"
      >
        <ChevronLeftIcon />
      </Button>
      <span aria-live="polite" className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
        {page} / {pageCount}
      </span>
      <Button
        aria-label={messages.nextPage}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        size="icon-sm"
        title={messages.nextPage}
        type="button"
        variant="outline"
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  )
}
