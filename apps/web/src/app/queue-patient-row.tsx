import { Button } from '@clinmesh/ui/components/button'
import { cn } from '@clinmesh/ui/lib/utils'
import type { ReactNode } from 'react'

export function QueuePatientRow({ selectionId, label, name, attributes, status, description, number, selected, onSelect }: {
  selectionId: string
  label: string
  name: string
  attributes?: ReactNode
  status?: ReactNode
  description?: ReactNode
  number: ReactNode
  selected: boolean
  onSelect: () => void
}) {
  return <div data-queue-patient-row="" aria-current={selected || undefined}
    className={cn('flex min-w-0 flex-col gap-1 rounded-md border bg-card px-1.5 py-2 text-sm',
      selected ? 'border-info/40 bg-info/5' : 'border-border hover:border-foreground/20')}>
    <Button aria-label={label} data-agent-selection={selectionId} onClick={onSelect} type="button" variant="ghost"
      className="h-auto min-h-8 w-full flex-col items-stretch justify-center gap-1 rounded-sm p-0 text-left whitespace-normal hover:bg-transparent! dark:hover:bg-transparent!">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-medium">{name}</span>
        {attributes === undefined ? null : <span className="text-xs font-normal text-muted-foreground">{attributes}</span>}
        {status === undefined ? null : <span className="ml-auto shrink-0">{status}</span>}
      </span>
      {description === undefined ? null : <span className="text-xs font-normal text-muted-foreground wrap-anywhere">{description}</span>}
    </Button>
    <div className="min-w-0 text-xs text-muted-foreground">{number}</div>
  </div>
}
