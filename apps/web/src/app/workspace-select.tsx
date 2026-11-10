import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { cn } from '@clinmesh/ui/lib/utils'
import type { ReactNode } from 'react'

export interface WorkspaceSelectItem<Value extends string = string> {
  label: ReactNode
  value: Value
}

export function WorkspaceSelect<Value extends string>({
  ariaLabel,
  disabled = false,
  id,
  items,
  onValueChange,
  placeholder,
  value,
  wrapLabels = false,
}: {
  ariaLabel?: string
  disabled?: boolean
  id: string
  items: readonly WorkspaceSelectItem<Value>[]
  onValueChange: (value: Value | null) => void
  placeholder?: ReactNode
  value: Value | null
  wrapLabels?: boolean
}): React.JSX.Element {
  return (
    <Select disabled={disabled} items={items} onValueChange={onValueChange} value={value}>
      <SelectTrigger aria-label={ariaLabel} className={cn('w-full', wrapLabels && 'min-h-8 min-w-0 whitespace-normal data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none')} id={id}>
        <SelectValue className={cn(wrapLabels && 'min-w-0 wrap-anywhere')} {...(placeholder === undefined ? {} : { placeholder })} />
      </SelectTrigger>
      <SelectContent align={wrapLabels ? 'start' : 'center'} alignItemWithTrigger={!wrapLabels}>
        <SelectGroup>
          {items.map(item => (
            <SelectItem className={cn(wrapLabels && 'min-w-0 [&>:first-child]:min-w-0 [&>:first-child]:shrink [&>:first-child]:wrap-anywhere [&>:first-child]:whitespace-normal')} key={item.value} value={item.value}>{item.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
