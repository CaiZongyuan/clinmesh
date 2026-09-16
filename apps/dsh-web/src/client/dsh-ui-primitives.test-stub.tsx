import { createPortal } from 'react-dom'
import type { MenuProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Host boundary stub; real DSH owns menu positioning, focus and keyboard behavior. */
export function Menu({ anchor, open, items, selectedId, onSelect, portal }: MenuProps) {
  const menu = open ? (
    <div role="menu">
      {items.map(item => (
        <button key={item.id} role="menuitem" aria-current={item.id === selectedId} onClick={() => onSelect(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  ) : null
  return <>{anchor}{portal ? createPortal(menu, document.body) : menu}</>
}

export function IconChevronDownOutline14() { return <svg aria-hidden="true" /> }
