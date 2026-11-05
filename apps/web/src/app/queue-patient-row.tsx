import { Button } from '@clinmesh/ui/components/button'
import { cn } from '@clinmesh/ui/lib/utils'
import type { ReactNode } from 'react'

export function QueuePatientRow({ selectionId, label, name, status, description, number, selected, onSelect }: {
  selectionId: string
  label: string
  name: string
  status?: ReactNode
  description?: ReactNode
  number: ReactNode
  selected: boolean
  onSelect: () => void
}) {
  return <div data-queue-patient-row="" aria-current={selected || undefined}
    className={cn('flex min-w-0 flex-col gap-1 rounded-md border bg-card px-1.5 py-2 text-sm',
      selected ? 'border-info/55 bg-accent [&_span.font-medium]:text-accent-foreground' : 'border-border hover:border-foreground/20')}>
    <Button aria-label={label} data-agent-selection={selectionId} onClick={onSelect} type="button" variant="ghost"
      className="h-auto min-h-8 w-full flex-col items-stretch justify-center gap-1 rounded-sm p-0 text-left whitespace-normal hover:bg-transparent! dark:hover:bg-transparent!">
      <span className="flex min-w-0 flex-wrap items-start gap-x-1 gap-y-1">
        <span className="min-w-0 flex-auto break-words font-medium">{name}</span>
        {status === undefined ? null : <span className="ml-auto max-w-full shrink-0">{status}</span>}
      </span>
      {description === undefined ? null : <span className="text-xs font-normal text-muted-foreground wrap-anywhere">{description}</span>}
    </Button>
    <div className="min-w-0 text-xs text-muted-foreground">{number}</div>
  </div>
}
