/** Narrow surface of the Menu exported by DSH 0.1.5-rc.2's browser module loader. */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export interface MenuProps {
    open: boolean
    onClose(): void
    items: readonly { id: string; label: string }[]
    selectedId?: string
    onSelect(id: string): void
    align?: 'start' | 'end'
    portal?: boolean
    anchor: import('react').ReactNode
  }
  export const Menu: import('react').ComponentType<MenuProps>
  export const IconChevronDownOutline14: import('react').ComponentType<{ className?: string }>
}
