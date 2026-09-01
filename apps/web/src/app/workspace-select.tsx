import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import type { ReactNode } from 'react'

export interface WorkspaceSelectItem<Value extends string = string> {
  label: ReactNode
  value: Value
}

export function WorkspaceSelect<Value extends string>({
  id,
  items,
  onValueChange,
  placeholder,
  value,
}: {
  id: string
  items: readonly WorkspaceSelectItem<Value>[]
  onValueChange: (value: Value | null) => void
  placeholder?: ReactNode
  value: Value | null
}): React.JSX.Element {
  return (
    <Select items={items} onValueChange={onValueChange} value={value}>
      <SelectTrigger className="w-full" id={id}>
        <SelectValue {...(placeholder === undefined ? {} : { placeholder })} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map(item => (
            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
